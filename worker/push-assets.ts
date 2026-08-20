/**
 * The service worker and enrollment UI, served as Worker routes rather than
 * static files.
 *
 * Rationale: the frontend assets live in the `ASSETS` binding and there is no
 * local copy of that source (see macroflow-kb.md §9 — only the Worker bundle was
 * recovered). Serving these two scripts from the Worker and injecting the script
 * tag with HTMLRewriter means push works without touching the asset bundle at
 * all. If the frontend source is ever recovered, moving them into it is a
 * cosmetic change.
 */

/**
 * Scope note: a service worker's scope cannot be broader than its own path, so
 * this MUST be served from the origin root to control the whole app. It is, and
 * the Service-Worker-Allowed header below makes that explicit.
 */
export const SERVICE_WORKER_SOURCE = /* javascript */ `
'use strict';

// Take over without waiting for every tab to close — otherwise a first-time
// subscribe can sit uncontrolled until the PWA is fully quit.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (error) {
    data = { title: 'MacroFlow', body: event.data ? event.data.text() : '' };
  }

  // iOS drops the subscription if a push arrives and no notification is shown,
  // so this always shows something even when the payload is unusable.
  event.waitUntil(
    self.registration.showNotification(data.title || 'MacroFlow', {
      body: data.body || '',
      tag: data.tag || undefined,
      // No icon: an installed iOS PWA uses its home-screen icon automatically,
      // and referencing a path that may not exist would break the notification.
      data: { url: data.url || '/' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if ('focus' in client) {
        await client.focus();
        if ('navigate' in client && target !== '/') {
          try { await client.navigate(target); } catch (error) { /* cross-origin or blocked */ }
        }
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});
`;

/**
 * Enrollment UI. Rendered into a shadow root so it inherits none of the app's
 * CSS and leaks none of its own — necessary because this is injected into a
 * page whose stylesheet is unknown.
 */
export const CLIENT_SOURCE = /* javascript */ `
'use strict';
(function () {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;

  var DISMISS_KEY = 'macroflow.push.dismissed';

  var isApple = /iP(hone|ad|od)/.test(navigator.userAgent);
  var isStandalone =
    window.navigator.standalone === true ||
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);

  // On iOS, PushManager only functions inside an installed PWA. In a Safari tab
  // subscribe() rejects, so prompting there would only produce a broken flow.
  if (isApple && !isStandalone) return;

  function urlBase64ToUint8Array(base64String) {
    var padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    var raw = window.atob(base64);
    var output = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
    return output;
  }

  function bufferToBase64Url(buffer) {
    var bytes = new Uint8Array(buffer);
    var binary = '';
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return window.btoa(binary).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  }

  function banner(message, actionLabel, onAction) {
    var host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;';
    var root = host.attachShadow({ mode: 'open' });
    root.innerHTML =
      '<style>' +
      '.wrap{margin:0 auto 16px;max-width:26rem;display:flex;gap:.75rem;align-items:center;' +
      'padding:.85rem 1rem;border-radius:14px;font:500 14px/1.35 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;' +
      'background:#1c1c1e;color:#f5f5f7;box-shadow:0 8px 28px rgba(0,0,0,.35);' +
      'margin-bottom:calc(16px + env(safe-area-inset-bottom));}' +
      '.msg{flex:1;}' +
      'button{font:600 14px system-ui,sans-serif;border:0;border-radius:9px;padding:.5rem .85rem;cursor:pointer;}' +
      '.go{background:#0a84ff;color:#fff;}' +
      '.no{background:transparent;color:#8e8e93;padding:.5rem .35rem;}' +
      '</style>' +
      '<div class="wrap"><span class="msg"></span>' +
      '<button class="go"></button><button class="no">✕</button></div>';

    root.querySelector('.msg').textContent = message;
    root.querySelector('.go').textContent = actionLabel;
    root.querySelector('.go').addEventListener('click', function () {
      host.remove();
      onAction();
    });
    root.querySelector('.no').addEventListener('click', function () {
      host.remove();
      try { localStorage.setItem(DISMISS_KEY, '1'); } catch (error) {}
    });
    document.body.appendChild(host);
    return host;
  }

  async function subscribe(registration) {
    var response = await fetch('/api/push/key', { credentials: 'same-origin' });
    if (!response.ok) return;
    var key = (await response.json()).publicKey;
    if (!key) return;

    var subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,              // required; iOS rejects silent push
      applicationServerKey: urlBase64ToUint8Array(key),
    });

    await fetch('/api/push/subscribe', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        endpoint: subscription.endpoint,
        p256dh: bufferToBase64Url(subscription.getKey('p256dh')),
        auth: bufferToBase64Url(subscription.getKey('auth')),
        userAgent: navigator.userAgent,
      }),
    });
  }

  async function start() {
    var registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;

    var existing = await registration.pushManager.getSubscription();

    // Already granted and subscribed: re-post it. Cheap, and it self-heals the
    // case where the server row was lost but the browser subscription survived.
    if (Notification.permission === 'granted') {
      if (existing) {
        await fetch('/api/push/subscribe', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            endpoint: existing.endpoint,
            p256dh: bufferToBase64Url(existing.getKey('p256dh')),
            auth: bufferToBase64Url(existing.getKey('auth')),
            userAgent: navigator.userAgent,
          }),
        });
      } else {
        await subscribe(registration);
      }
      return;
    }

    // Denied is terminal on iOS — it cannot be re-prompted from the page, only
    // reset in Settings. Showing a button that cannot work would be worse than
    // showing nothing.
    if (Notification.permission === 'denied') return;

    try { if (localStorage.getItem(DISMISS_KEY)) return; } catch (error) {}

    // requestPermission() must be called from a user gesture, so it hangs off
    // the button rather than firing on load.
    banner('Get reminders to log your weight and meals.', 'Enable', async function () {
      var permission = await Notification.requestPermission();
      if (permission !== 'granted') return;
      try {
        await subscribe(registration);
      } catch (error) {
        console.error('[macroflow] push subscribe failed', error);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { start().catch(function () {}); });
  } else {
    start().catch(function () {});
  }
})();
`;

export function serviceWorkerResponse(): Response {
  return new Response(SERVICE_WORKER_SOURCE, {
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      // Lets a worker served from any path claim the root scope.
      'service-worker-allowed': '/',
      'cache-control': 'no-cache',
    },
  });
}

export function clientScriptResponse(): Response {
  return new Response(CLIENT_SOURCE, {
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'public, max-age=300',
    },
  });
}

/**
 * Append the client script to the served HTML. Leaves every non-HTML response
 * untouched, so it is safe to wrap the whole asset fallthrough in it.
 */
export function injectPushClient(response: Response): Response {
  if (!(response.headers.get('content-type') || '').includes('text/html')) return response;
  return new HTMLRewriter()
    .on('head', {
      element(element) {
        element.append('<script src="/push-client.js" defer></script>', { html: true });
      },
    })
    .transform(response);
}
