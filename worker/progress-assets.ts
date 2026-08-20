/**
 * The progress-photo UI, served as a Worker route rather than a static file.
 *
 * Rationale is the same as worker/push-assets.ts: the frontend lives in the
 * `ASSETS` binding and there is no local copy of that source (macroflow-kb.md
 * §9 — only the Worker bundle was recovered). Serving this script from the
 * Worker and injecting the tag with HTMLRewriter adds the feature without
 * touching the asset bundle. When the frontend source is recovered, moving this
 * into it — and hanging it off the real navigation instead of a floating
 * button — is a cosmetic change.
 *
 * Everything renders into a shadow root, so it inherits none of the app's CSS
 * and leaks none of its own. Necessary, because the app's stylesheet is unknown.
 */

export const PROGRESS_CLIENT_SOURCE = /* javascript */ `
'use strict';
(function () {
  var POSES = ['front', 'side', 'back'];
  var POSE_LABEL = { front: 'Front', side: 'Side', back: 'Back' };

  // Long edge in pixels. macros.md §10 wants same-pose comparison, not print
  // detail; 1600 is already larger than any phone screen. The resize is not only
  // about bandwidth -- re-encoding through a canvas drops the EXIF block, and
  // iPhone photos carry GPS coordinates in it. Nothing upstream strips that, so
  // if it is not removed here it is stored.
  var MAX_EDGE = 1600;
  var JPEG_QUALITY = 0.85;

  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    if (attrs) for (var key in attrs) node.setAttribute(key, attrs[key]);
    if (text != null) node.textContent = text;
    return node;
  }

  async function loadImage(file) {
    // 'from-image' applies the EXIF rotation before we discard EXIF, otherwise a
    // portrait phone photo would be stored on its side.
    if (window.createImageBitmap) {
      try {
        return await createImageBitmap(file, { imageOrientation: 'from-image' });
      } catch (error) { /* older Safari lacks the option; fall through */ }
    }
    return await new Promise(function (resolve, reject) {
      var img = new Image();
      var url = URL.createObjectURL(file);
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function (error) { URL.revokeObjectURL(url); reject(error); };
      img.src = url;
    });
  }

  async function downscale(file) {
    var source = await loadImage(file);
    var sourceWidth = source.width || source.naturalWidth;
    var sourceHeight = source.height || source.naturalHeight;
    var scale = Math.min(1, MAX_EDGE / Math.max(sourceWidth, sourceHeight));
    var width = Math.round(sourceWidth * scale);
    var height = Math.round(sourceHeight * scale);

    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(source, 0, 0, width, height);
    if (source.close) source.close();

    return await new Promise(function (resolve) {
      canvas.toBlob(function (blob) { resolve(blob); }, 'image/jpeg', JPEG_QUALITY);
    });
  }

  function fmtDate(isoDate) {
    var parts = isoDate.split('-');
    return new Date(Date.UTC(+parts[0], +parts[1] - 1, +parts[2], 12))
      .toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function weeksBetween(a, b) {
    return Math.round(Math.abs(new Date(a) - new Date(b)) / 604800000);
  }

  /*
   * Theme is READ FROM THE APP, not hardcoded.
   *
   * The first version of this shipped a fixed iOS-dark palette. settings.theme
   * is 'light', so it clashed badly. Guessing a second time would be the same
   * mistake, and there is still no local copy of the frontend to match against
   * (macroflow-kb.md §9) -- so instead of guessing, this samples the live page
   * for its background, text colour, accent, radius and font, and builds the
   * stylesheet from what it finds.
   *
   * Consequence worth knowing: this follows the app automatically. Change the
   * theme, restyle the app, and this follows without a redeploy.
   */

  function parseColor(value) {
    var text = String(value || '').trim();
    var m = text.match(/rgba?\(([^)]+)\)/);
    if (m) {
      var p = m[1].split(/[,\\s\\/]+/).filter(Boolean).map(parseFloat);
      if (p.length >= 3 && !(p.length > 3 && p[3] === 0)) return { r: p[0], g: p[1], b: p[2] };
      return null;
    }
    var hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!hex) return null;
    var h = hex[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
  }

  function toCss(c) { return 'rgb(' + Math.round(c.r) + ',' + Math.round(c.g) + ',' + Math.round(c.b) + ')'; }
  function mix(a, b, amount) {
    return { r: a.r + (b.r - a.r) * amount, g: a.g + (b.g - a.g) * amount, b: a.b + (b.b - a.b) * amount };
  }
  function luminance(c) { return (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255; }
  function saturation(c) {
    var hi = Math.max(c.r, c.g, c.b), lo = Math.min(c.r, c.g, c.b);
    return hi === 0 ? 0 : (hi - lo) / hi;
  }

  /* Walk up from body until something paints an actual background. */
  function pageBackground() {
    var node = document.body;
    while (node) {
      var c = parseColor(getComputedStyle(node).backgroundColor);
      if (c) return c;
      node = node.parentElement;
    }
    return { r: 255, g: 255, b: 255 };
  }

  /*
   * The app's accent. Custom properties first (most apps declare one), then the
   * most common saturated button background, then a neutral blue. Anything too
   * grey is rejected -- a grey "accent" would make every primary control vanish.
   */
  function accentColor(pageBg, textColor) {
    var rootStyle = getComputedStyle(document.documentElement);
    var names = ['--accent', '--primary', '--brand', '--color-accent', '--color-primary',
      '--accent-color', '--primary-color', '--brand-color', '--theme-color', '--color-brand',
      '--lime', '--green', '--highlight', '--accent-1', '--c-accent'];
    for (var i = 0; i < names.length; i++) {
      var declared = parseColor(rootStyle.getPropertyValue(names[i]));
      if (declared && saturation(declared) > 0.15) return declared;
    }

    /*
     * Scan DESCENDANTS of controls, not just the controls themselves.
     *
     * This app puts its accent on a small chip inside a pale card, and on icon
     * and heading text -- the button's own background is near-white. Reading
     * only the control's backgroundColor found nothing and fell through to a
     * hardcoded blue, which is how a lime-green app ended up with a blue button.
     */
    var tally = {};
    var best = null;
    function consider(color, weight) {
      if (!color || saturation(color) < 0.3) return;
      if (Math.abs(luminance(color) - luminance(pageBg)) < 0.06) return;
      var key = toCss(color);
      tally[key] = (tally[key] || 0) + weight;
      if (!best || tally[key] > tally[toCss(best)]) best = color;
    }

    var controls = document.querySelectorAll('button, a, [role="button"], [role="tab"]');
    for (var j = 0; j < controls.length && j < 200; j++) {
      consider(parseColor(getComputedStyle(controls[j]).backgroundColor), 3);
      var inner = controls[j].querySelectorAll('*');
      for (var k = 0; k < inner.length && k < 12; k++) {
        var innerStyle = getComputedStyle(inner[k]);
        consider(parseColor(innerStyle.backgroundColor), 2);
        consider(parseColor(innerStyle.color), 1);
      }
    }

    /* Saturated heading/label text is often the accent too. */
    var texts = document.querySelectorAll('h1, h2, h3, h4, strong, b, [class*="accent" i], [class*="label" i]');
    for (var m = 0; m < texts.length && m < 120; m++) {
      consider(parseColor(getComputedStyle(texts[m]).color), 1);
    }

    if (best) return best;

    /*
     * No accent found. Fall back to the app's own text colour rather than a
     * hardcoded hue -- a monochrome control reads as deliberate, whereas a blue
     * one in a green app reads as broken.
     */
    return textColor || (luminance(pageBg) > 0.5 ? { r: 30, g: 30, b: 32 } : { r: 235, g: 235, b: 240 });
  }

  function readTheme() {
    var bodyStyle = getComputedStyle(document.body);
    var bg = pageBackground();
    var dark = luminance(bg) < 0.5;
    var text = parseColor(bodyStyle.color) || (dark ? { r: 245, g: 245, b: 247 } : { r: 20, g: 20, b: 22 });
    var accent = accentColor(bg, text);

    /*
     * Corner radius, by majority vote across real controls rather than the first
     * one found -- the first match is often an unstyled or ghost button whose
     * radius is 0, which is not what the app actually looks like.
     */
    var radiusTally = {};
    var radius = '';
    var controls = document.querySelectorAll('button, input, select, textarea');
    for (var k = 0; k < controls.length && k < 200; k++) {
      var r = getComputedStyle(controls[k]).borderRadius;
      if (!r || r === '0px' || r.indexOf('%') !== -1) continue;
      radiusTally[r] = (radiusTally[r] || 0) + 1;
      if (!radius || radiusTally[r] > radiusTally[radius]) radius = r;
    }
    if (!radius) radius = '10px';

    return {
      font: bodyStyle.fontFamily || '-apple-system,BlinkMacSystemFont,system-ui,sans-serif',
      radius: radius,
      bg: toCss(bg),
      /* Cards/inputs sit one step away from the page, whichever way that is. */
      surface: toCss(dark ? mix(bg, { r: 255, g: 255, b: 255 }, 0.07) : mix(bg, { r: 0, g: 0, b: 0 }, 0.04)),
      text: toCss(text),
      muted: toCss(mix(text, bg, 0.45)),
      border: toCss(mix(text, bg, 0.86)),
      accent: toCss(accent),
      onAccent: luminance(accent) > 0.6 ? '#000' : '#fff',
      shadow: dark ? 'rgba(0,0,0,.5)' : 'rgba(0,0,0,.18)',
      danger: dark ? '#ff6961' : '#c0392b'
    };
  }

  function buildStyle(t) {
    return ':host{all:initial;}' +
    '*{box-sizing:border-box;font-family:' + t.font + ';}' +
    '.fab{position:fixed;right:16px;bottom:calc(88px + env(safe-area-inset-bottom));z-index:2147483000;' +
      'width:52px;height:52px;border:0;border-radius:50%;background:' + t.accent + ';color:' + t.onAccent + ';' +
      'font-size:23px;box-shadow:0 6px 20px ' + t.shadow + ';cursor:pointer;display:flex;align-items:center;' +
      'justify-content:center;}' +
    '.sheet{position:fixed;inset:0;z-index:2147483001;background:' + t.bg + ';color:' + t.text + ';' +
      'overflow-y:auto;-webkit-overflow-scrolling:touch;padding:0 0 calc(32px + env(safe-area-inset-bottom));}' +
    '.bar{position:sticky;top:0;background:' + t.bg + ';display:flex;align-items:center;gap:12px;' +
      'padding:calc(12px + env(safe-area-inset-top)) 16px 12px;border-bottom:1px solid ' + t.border + ';}' +
    '.bar h2{margin:0;font-size:17px;font-weight:600;flex:1;}' +
    '.x{background:none;border:0;color:' + t.muted + ';font-size:24px;line-height:1;cursor:pointer;padding:4px 8px;}' +
    '.tabs{display:flex;gap:6px;padding:12px 16px 4px;}' +
    '.tab{flex:1;padding:8px;border:0;border-radius:' + t.radius + ';background:' + t.surface + ';' +
      'color:' + t.muted + ';font-size:14px;font-weight:600;cursor:pointer;}' +
    '.tab[aria-selected="true"]{background:' + t.accent + ';color:' + t.onAccent + ';}' +
    '.body{padding:12px 16px;}' +
    '.hint{color:' + t.muted + ';font-size:13px;line-height:1.45;margin:4px 0 16px;}' +
    'label{display:block;font-size:12px;font-weight:600;color:' + t.muted + ';margin:14px 0 6px;' +
      'text-transform:uppercase;letter-spacing:.04em;}' +
    'input,select,textarea{width:100%;padding:11px 12px;border:1px solid ' + t.border + ';' +
      'border-radius:' + t.radius + ';background:' + t.surface + ';color:' + t.text + ';font-size:16px;}' +
    'textarea{resize:vertical;min-height:60px;}' +
    '.pick{width:100%;padding:13px 12px;border:1px dashed ' + t.border + ';' +
      'border-radius:' + t.radius + ';background:' + t.surface + ';color:' + t.muted + ';' +
      'font-size:15px;font-weight:600;cursor:pointer;text-align:center;white-space:nowrap;' +
      'overflow:hidden;text-overflow:ellipsis;}' +
    '.pick[data-chosen="1"]{border-style:solid;color:' + t.text + ';}' +
    '.poses{display:flex;gap:8px;}' +
    '.poses button{flex:1;padding:10px;border:1px solid ' + t.border + ';border-radius:' + t.radius + ';' +
      'background:' + t.surface + ';color:' + t.muted + ';font-size:14px;font-weight:600;cursor:pointer;}' +
    '.poses button[aria-pressed="true"]{background:' + t.accent + ';border-color:' + t.accent + ';' +
      'color:' + t.onAccent + ';}' +
    '.go{width:100%;margin-top:20px;padding:14px;border:0;border-radius:' + t.radius + ';' +
      'background:' + t.accent + ';color:' + t.onAccent + ';font-size:16px;font-weight:600;cursor:pointer;}' +
    '.go[disabled]{opacity:.5;}' +
    '.session{margin:0 0 22px;}' +
    '.session h3{margin:0 0 2px;font-size:15px;font-weight:600;}' +
    '.meta{color:' + t.muted + ';font-size:13px;margin:0 0 10px;}' +
    '.shots{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;}' +
    '.shot{position:relative;}' +
    '.shot img{width:100%;aspect-ratio:3/4;object-fit:cover;border-radius:' + t.radius + ';' +
      'background:' + t.surface + ';display:block;}' +
    '.shot span{position:absolute;left:6px;bottom:6px;background:rgba(0,0,0,.65);color:#fff;border-radius:6px;' +
      'padding:2px 6px;font-size:11px;font-weight:600;}' +
    '.shot .del{position:absolute;right:5px;top:5px;background:rgba(0,0,0,.65);border:0;color:#fff;' +
      'border-radius:50%;width:24px;height:24px;font-size:14px;line-height:1;cursor:pointer;}' +
    '.pair{display:grid;grid-template-columns:1fr 1fr;gap:8px;}' +
    '.pair figure{margin:0;}' +
    '.pair img{width:100%;aspect-ratio:3/4;object-fit:cover;border-radius:' + t.radius + ';' +
      'background:' + t.surface + ';display:block;}' +
    '.pair figcaption{color:' + t.muted + ';font-size:12px;text-align:center;margin-top:6px;line-height:1.4;' +
      'white-space:pre-line;}' +
    '.delta{text-align:center;font-size:14px;font-weight:600;margin:14px 0 0;}' +
    '.empty{color:' + t.muted + ';font-size:14px;text-align:center;padding:40px 20px;line-height:1.5;}' +
    '.err{color:' + t.danger + ';font-size:13px;margin-top:12px;}';
  }

  var host = null;
  var root = null;
  var photos = [];
  var pose = 'front';
  var tab = 'timeline';

  async function refresh() {
    var response = await fetch('/api/progress', { credentials: 'same-origin' });
    if (!response.ok) throw new Error('Could not load progress photos');
    photos = (await response.json()).photos || [];
  }

  function render() {
    var view = root.querySelector('.body');
    view.textContent = '';
    root.querySelectorAll('.tab').forEach(function (node) {
      node.setAttribute('aria-selected', String(node.dataset.tab === tab));
    });
    if (tab === 'add') renderAdd(view);
    else if (tab === 'compare') renderCompare(view);
    else renderTimeline(view);
  }

  function renderTimeline(view) {
    if (!photos.length) {
      view.appendChild(el('p', { class: 'empty' },
        'No progress photos yet. Every 4 weeks, same light, same pose, same time of day \\u2014 that cadence is what makes them readable.'));
      return;
    }

    var order = [];
    var sessions = {};
    photos.forEach(function (photo) {
      if (!sessions[photo.takenDate]) { sessions[photo.takenDate] = []; order.push(photo.takenDate); }
      sessions[photo.takenDate].push(photo);
    });

    order.forEach(function (date) {
      var group = sessions[date];
      var section = el('section', { class: 'session' });
      section.appendChild(el('h3', null, fmtDate(date)));

      var weighed = group.filter(function (photo) { return photo.weightKg != null; })[0];
      section.appendChild(el('p', { class: 'meta' },
        (weighed ? weighed.weightKg.toFixed(1) + ' kg \\u00b7 ' : '') +
        group.length + (group.length === 1 ? ' photo' : ' photos')));

      var shots = el('div', { class: 'shots' });
      group.forEach(function (photo) {
        var cell = el('div', { class: 'shot' });
        cell.appendChild(el('img', { src: photo.imagePath, alt: POSE_LABEL[photo.pose], loading: 'lazy' }));
        cell.appendChild(el('span', null, POSE_LABEL[photo.pose]));
        var remove = el('button', { class: 'del', 'aria-label': 'Delete photo' }, '\\u00d7');
        remove.addEventListener('click', async function () {
          if (!window.confirm('Delete this photo? The image is removed from storage immediately.')) return;
          await fetch('/api/progress/' + photo.id, { method: 'DELETE', credentials: 'same-origin' });
          await refresh();
          render();
        });
        cell.appendChild(remove);
        shots.appendChild(cell);
      });
      section.appendChild(shots);
      view.appendChild(section);
    });
  }

  function renderAdd(view) {
    view.appendChild(el('p', { class: 'hint' },
      'Same light, same pose, same time of day \\u2014 ideally fasted, before breakfast. Consistency matters more than the camera.'));

    view.appendChild(el('label', null, 'Pose'));
    var poseRow = el('div', { class: 'poses' });
    POSES.forEach(function (name) {
      var button = el('button', { type: 'button', 'data-pose': name, 'aria-pressed': String(name === pose) },
        POSE_LABEL[name]);
      button.addEventListener('click', function () {
        pose = name;
        poseRow.querySelectorAll('button').forEach(function (node) {
          node.setAttribute('aria-pressed', String(node.dataset.pose === name));
        });
      });
      poseRow.appendChild(button);
    });
    view.appendChild(poseRow);

    view.appendChild(el('label', null, 'Photo'));
    /*
     * A bare <input type=file> renders the browser's native control, which
     * carries its own chrome and locale ("Seleccionar archivo / Ningun archivo
     * seleccionado") and cannot be styled. Hide it and drive it from a real
     * button so it matches everything else in the sheet.
     */
    var file = el('input', { type: 'file', accept: 'image/*' });
    file.style.display = 'none';
    var picker = el('button', { class: 'pick', type: 'button' }, 'Choose photo');
    picker.addEventListener('click', function () { file.click(); });
    file.addEventListener('change', function () {
      var chosen = file.files && file.files[0];
      picker.textContent = chosen ? chosen.name : 'Choose photo';
      picker.setAttribute('data-chosen', chosen ? '1' : '');
    });
    view.appendChild(picker);
    view.appendChild(file);

    view.appendChild(el('label', null, 'Bodyweight (kg) \\u2014 optional'));
    var weight = el('input', { type: 'number', step: '0.1', min: '20', max: '400',
      placeholder: 'Defaults to your latest logged weight' });
    view.appendChild(weight);

    view.appendChild(el('label', null, 'Notes \\u2014 optional'));
    var notes = el('textarea', { placeholder: 'Lighting, time of day, anything worth remembering' });
    view.appendChild(notes);

    var error = el('p', { class: 'err' });
    var save = el('button', { class: 'go', type: 'button' }, 'Save photo');
    save.addEventListener('click', async function () {
      error.textContent = '';
      if (!file.files || !file.files[0]) { error.textContent = 'Choose a photo first.'; return; }
      save.disabled = true;
      save.textContent = 'Saving\\u2026';
      try {
        var blob = await downscale(file.files[0]);
        var form = new FormData();
        form.append('image', blob, 'progress.jpg');
        form.append('pose', pose);
        form.append('takenAt', new Date().toISOString());
        if (weight.value) form.append('weightKg', weight.value);
        if (notes.value) form.append('notes', notes.value);

        var response = await fetch('/api/progress', { method: 'POST', credentials: 'same-origin', body: form });
        if (!response.ok) throw new Error(((await response.json()) || {}).error || 'Upload failed');

        await refresh();
        tab = 'timeline';
        render();
      } catch (failure) {
        error.textContent = failure.message || 'Could not save that photo.';
        save.disabled = false;
        save.textContent = 'Save photo';
      }
    });
    view.appendChild(save);
    view.appendChild(error);
  }

  function renderCompare(view) {
    view.appendChild(el('label', null, 'Pose'));
    var picker = el('select');
    POSES.forEach(function (name) {
      var option = el('option', { value: name }, POSE_LABEL[name]);
      if (name === pose) option.setAttribute('selected', 'selected');
      picker.appendChild(option);
    });
    view.appendChild(picker);

    var pane = el('div');
    view.appendChild(pane);

    function draw() {
      pane.textContent = '';
      // Same pose only. A front shot against a side shot compares nothing.
      var matching = photos.filter(function (photo) { return photo.pose === picker.value; });
      if (matching.length < 2) {
        pane.appendChild(el('p', { class: 'empty' },
          'Two ' + POSE_LABEL[picker.value].toLowerCase() + ' photos are needed to compare. You have ' +
          matching.length + '.'));
        return;
      }

      // photos arrive newest-first, so the last element is the oldest.
      var latest = matching[0];
      var earliest = matching[matching.length - 1];

      var pair = el('div', { class: 'pair' });
      [earliest, latest].forEach(function (photo) {
        var figure = el('figure');
        figure.appendChild(el('img', { src: photo.imagePath, alt: fmtDate(photo.takenDate), loading: 'lazy' }));
        figure.appendChild(el('figcaption', null,
          fmtDate(photo.takenDate) + (photo.weightKg != null ? '\\n' + photo.weightKg.toFixed(1) + ' kg' : '')));
        pair.appendChild(figure);
      });
      pane.appendChild(pair);

      var weeks = weeksBetween(earliest.takenAt, latest.takenAt);
      var line = weeks + (weeks === 1 ? ' week apart' : ' weeks apart');
      if (earliest.weightKg != null && latest.weightKg != null) {
        var delta = latest.weightKg - earliest.weightKg;
        line += ' \\u00b7 ' + (delta >= 0 ? '+' : '') + delta.toFixed(1) + ' kg';
        if (weeks > 0) {
          line += ' (' + (delta / weeks >= 0 ? '+' : '') + (delta / weeks).toFixed(2) + ' kg/week)';
        }
      }
      pane.appendChild(el('p', { class: 'delta' }, line));
    }

    picker.addEventListener('change', function () { pose = picker.value; draw(); });
    draw();
  }

  function open() {
    var sheet = el('div', { class: 'sheet' });

    var bar = el('div', { class: 'bar' });
    bar.appendChild(el('h2', null, 'Progress photos'));
    var close = el('button', { class: 'x', 'aria-label': 'Close' }, '\\u00d7');
    close.addEventListener('click', function () { sheet.remove(); });
    bar.appendChild(close);
    sheet.appendChild(bar);

    var tabs = el('div', { class: 'tabs' });
    [['timeline', 'Timeline'], ['add', 'Add'], ['compare', 'Compare']].forEach(function (entry) {
      var button = el('button', { class: 'tab' }, entry[1]);
      button.dataset.tab = entry[0];
      button.addEventListener('click', function () { tab = entry[0]; render(); });
      tabs.appendChild(button);
    });
    sheet.appendChild(tabs);
    sheet.appendChild(el('div', { class: 'body' }));

    root.appendChild(sheet);

    tab = 'timeline';
    refresh().then(render).catch(function () {
      sheet.querySelector('.body').appendChild(
        el('p', { class: 'empty' }, 'Could not load your photos. Check that you are still signed in.'));
    });
  }

  /* ---------------------------------------------------------------- nav bar */

  var NAV_FLAG = 'data-macroflow-progress';

  /* Outline camera. Inherits currentColor, so it picks up the nav's own icon
     colour including the active/inactive states. */
  var CAMERA_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ' +
    'style="width:1em;height:1em;display:block;">' +
    '<path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h2.2a1 1 0 0 0 .83-.45l.94-1.4A1 1 0 0 1 9.3 4.7h5.4a1 1 0 0 1 .83.45l.94 1.4a1 1 0 0 0 .83.45h2.2A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/>' +
    '<circle cx="12" cy="13" r="3.4"/></svg>';

  /*
   * Locate the app's nav. Nothing about the frontend's markup is known here
   * (macroflow-kb.md §9), so this scores candidates instead of matching a
   * selector: wide, short, more than one control, and preferably fixed or
   * stuck to the bottom of the viewport.
   */
  function findNav() {
    var selector = 'nav,[role="navigation"],[role="tablist"],footer,' +
      '[class*="nav" i],[class*="tab-bar" i],[class*="tabbar" i],[class*="bottom" i]';
    var candidates = [].slice.call(document.querySelectorAll(selector));
    var best = null;
    var bestScore = 0;

    for (var i = 0; i < candidates.length; i++) {
      var node = candidates[i];
      var rect = node.getBoundingClientRect();
      if (rect.height === 0 || rect.height > 170) continue;
      /* Width floor is capped at 280px: a bar can be much narrower than half the
         viewport on a desktop-width window while still being the real nav. */
      if (rect.width < Math.min(window.innerWidth * 0.5, 280)) continue;

      var items = node.querySelectorAll('a,button,[role="tab"]');
      if (items.length < 2) continue;

      var score = Math.min(items.length, 8);
      var position = getComputedStyle(node).position;
      if (position === 'fixed' || position === 'sticky') score += 6;
      if (rect.top > window.innerHeight * 0.6) score += 6;
      if (node.tagName === 'NAV' || node.getAttribute('role') === 'tablist') score += 3;

      if (score > bestScore) { bestScore = score; best = node; }
    }
    return best;
  }

  /*
   * Build the new item by CLONING an existing one.
   *
   * This is the whole trick. A hand-built button would need the app's class
   * names, icon sizing and active-state markup, none of which are knowable from
   * here. A clone carries all of it for free, so the item matches whatever the
   * nav already looks like. Only the icon, the label and the active state are
   * then changed.
   */
  function buildNavItem(nav) {
    var siblings = [].slice.call(nav.children).filter(function (node) {
      return node.nodeType === 1 && !node.hasAttribute(NAV_FLAG) &&
        node.getBoundingClientRect().height > 0;
    });
    if (siblings.length < 2) return null;

    var item = siblings[siblings.length - 1].cloneNode(true);
    item.setAttribute(NAV_FLAG, '1');

    /* Never inherit the template's "you are here" state. */
    item.removeAttribute('aria-current');
    item.removeAttribute('aria-selected');
    item.removeAttribute('data-active');
    if (item.className && typeof item.className === 'string') {
      item.className = item.className
        .split(/\\s+/)
        .filter(function (name) { return !/(active|selected|current)/i.test(name); })
        .join(' ');
    }

    /* A cloned link would navigate somewhere real. */
    if (item.tagName === 'A') item.setAttribute('href', 'javascript:void(0)');
    var innerLinks = item.querySelectorAll('a');
    for (var i = 0; i < innerLinks.length; i++) innerLinks[i].setAttribute('href', 'javascript:void(0)');

    var icon = item.querySelector('svg,img,i,[class*="icon" i]');
    if (icon) {
      var holder = document.createElement('span');
      holder.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;' +
        'font-size:' + (getComputedStyle(icon).fontSize || '22px') + ';';
      holder.innerHTML = CAMERA_ICON;
      icon.parentNode.replaceChild(holder, icon);
    }

    /* Relabel the deepest text-bearing node, so the app's own label element
       (and its styling) is reused rather than replaced. */
    var labelled = null;
    var walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT, null);
    var textNode;
    while ((textNode = walker.nextNode())) {
      if (textNode.nodeValue && textNode.nodeValue.trim()) labelled = textNode;
    }
    /*
     * "Photos", not "Progress" -- the nav already has a Progress tab (the weight
     * and macro charts). Two tabs with the same label would be worse than an
     * imperfect one.
     */
    if (labelled) labelled.nodeValue = 'Photos';
    else if (!icon) item.textContent = 'Photos';

    item.setAttribute('aria-label', 'Progress photos');
    item.setAttribute('title', 'Progress photos');
    item.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      open();
    });
    return item;
  }

  /*
   * One more item can overflow a nav that was laid out for a fixed count. Only
   * applied when the nav actually overflows, and scoped to that element.
   */
  function fitNav(nav) {
    if (nav.scrollWidth <= nav.clientWidth + 2) return;
    nav.setAttribute('data-macroflow-fit', '1');
    if (document.getElementById('macroflow-nav-fit')) return;

    var style = document.createElement('style');
    style.id = 'macroflow-nav-fit';
    style.textContent =
      '[data-macroflow-fit]{gap:2px !important;column-gap:2px !important;}' +
      '[data-macroflow-fit] > *{min-width:0 !important;flex:1 1 0 !important;' +
        'padding-left:3px !important;padding-right:3px !important;}' +
      '[data-macroflow-fit] > * *{max-width:100%;white-space:nowrap;overflow:hidden;' +
        'text-overflow:ellipsis;}';
    document.head.appendChild(style);
  }

  /** Idempotent: returns true once the launcher is in the nav. */
  function ensureNavItem() {
    if (document.querySelector('[' + NAV_FLAG + ']')) return true;
    var nav = findNav();
    if (!nav) return false;
    var item = buildNavItem(nav);
    if (!item) return false;

    /*
     * Insert second-to-last rather than appending. Settings conventionally sits
     * last, and it does in this app (Today · Progress · Scan · Settings), so
     * appending would strand it mid-row. This also keeps the raised centre
     * button near the middle: at five items it lands dead centre instead of
     * right-of-centre.
     */
    var siblings = [].slice.call(nav.children).filter(function (node) {
      return node.nodeType === 1 && node.getBoundingClientRect().height > 0;
    });
    var last = siblings[siblings.length - 1];
    if (last) nav.insertBefore(item, last); else nav.appendChild(item);

    fitNav(nav);
    return true;
  }

  /* ------------------------------------------------------------------ mount */

  function addFallbackButton() {
    if (root.querySelector('.fab')) return;
    var fab = el('button', { class: 'fab', 'aria-label': 'Progress photos', title: 'Progress photos' },
      '\\ud83d\\udcf7');
    fab.addEventListener('click', open);
    root.appendChild(fab);
  }

  function mount() {
    host = el('div');
    /* Zero-sized and out of flow: the host must never contribute a line box to
       the app's layout. A fixed-position ancestor does not create a containing
       block for fixed descendants, so the sheet still covers the viewport. */
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;';
    root = host.attachShadow({ mode: 'open' });
    root.appendChild(el('style', null, buildStyle(readTheme())));
    document.body.appendChild(host);

    if (!ensureNavItem()) addFallbackButton();

    /*
     * An SPA re-render replaces the nav and takes the item with it. Re-inserting
     * on every mutation would thrash (and was a likely source of flicker), so
     * this coalesces to one check per frame and ensureNavItem() no-ops when the
     * item is already present.
     */
    var queued = false;
    new MutationObserver(function () {
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () {
        queued = false;
        if (!document.body.contains(host)) document.body.appendChild(host);
        if (ensureNavItem()) {
          var fab = root.querySelector('.fab');
          if (fab) fab.remove();
        }
      });
    }).observe(document.body, { childList: true, subtree: true });
  }

  /*
   * Wait for the app to render before mounting.
   *
   * The previous version mounted on DOMContentLoaded. In an SPA the body is
   * still empty at that point, so readTheme() sampled an unpainted page and
   * accentColor() had no buttons to scan — the palette came out wrong, and there
   * was no nav to attach to. This waits for the nav, with a ceiling so a layout
   * that never produces one still gets the floating fallback.
   */
  function start() {
    var attempts = 0;
    (function poll() {
      if (findNav() || attempts++ > 40) { mount(); return; }
      setTimeout(poll, 150);
    })();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
`;

export function progressClientResponse(): Response {
  return new Response(PROGRESS_CLIENT_SOURCE, {
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      // `private`, unlike push-assets.ts's `public` — /sw.js has to stay
      // reachable signed-out, but this route sits behind the password gate, so
      // no shared cache should ever hold a copy.
      'cache-control': 'private, max-age=300',
    },
  });
}

/**
 * Append the client script to served HTML. Non-HTML responses pass through
 * untouched, so this is safe to wrap around the whole asset fallthrough.
 *
 * ASSETS.fetch returns a Promise, so the handler has to await it:
 *   app.all('*', async (c) => injectProgressClient(await c.env.ASSETS.fetch(c.req.raw)))
 *
 * If push is also wired up, chain them — HTMLRewriter streams, so the two passes
 * do not each buffer the document:
 *   app.all('*', async (c) =>
 *     injectProgressClient(injectPushClient(await c.env.ASSETS.fetch(c.req.raw))))
 */
export function injectProgressClient(response: Response): Response {
  if (!(response.headers.get('content-type') || '').includes('text/html')) return response;
  return new HTMLRewriter()
    .on('head', {
      element(element) {
        element.append('<script src="/progress-client.js" defer></script>', { html: true });
      },
    })
    .transform(response);
}
