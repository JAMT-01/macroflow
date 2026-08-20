/**
 * Design-language probe for MacroFlow's frontend.
 *
 * Why this exists: the frontend lives only in the Worker's ASSETS binding
 * (macroflow-kb.md §9). It cannot be downloaded, and the site is password-gated,
 * so every styling decision in worker/progress-assets.ts has been inference from
 * a screenshot. This reads the real thing.
 *
 * Run it in the browser console with the app open and signed in. It is
 * READ-ONLY — it computes styles and copies a JSON summary to the clipboard.
 * Nothing is sent anywhere; it goes to your clipboard and no further.
 *
 * In Chrome/Edge DevTools `copy()` puts it on the clipboard directly. Elsewhere
 * the same object is returned and logged, so it can be copied from the console.
 */
(() => {
  const summarise = (el, keys) => {
    if (!el) return null;
    const s = getComputedStyle(el);
    const out = {};
    for (const k of keys) {
      const v = s[k];
      if (v && v !== 'none' && v !== 'normal' && v !== '0px' && v !== 'rgba(0, 0, 0, 0)') out[k] = v;
    }
    return out;
  };

  const BOX = ['backgroundColor', 'color', 'borderRadius', 'borderTopWidth', 'borderColor',
    'borderStyle', 'padding', 'boxShadow', 'fontFamily', 'fontSize', 'fontWeight',
    'letterSpacing', 'lineHeight', 'gap', 'textTransform'];

  /* Every custom property actually declared in the app's own stylesheets. */
  const vars = {};
  for (const sheet of Array.from(document.styleSheets)) {
    let rules;
    try { rules = sheet.cssRules; } catch (e) { continue; }   // cross-origin
    for (const rule of Array.from(rules || [])) {
      if (!rule.style) continue;
      for (const prop of Array.from(rule.style)) {
        if (prop.startsWith('--')) vars[prop] = rule.style.getPropertyValue(prop).trim();
      }
    }
  }

  /* The nav, found the same way worker/progress-assets.ts finds it. */
  let nav = null;
  let bestScore = 0;
  const candidates = document.querySelectorAll(
    'nav,[role="navigation"],[role="tablist"],footer,[class*="nav" i],[class*="tab" i],[class*="bottom" i]');
  for (const node of candidates) {
    const rect = node.getBoundingClientRect();
    if (!rect.height || rect.height > 170) continue;
    if (rect.width < Math.min(innerWidth * 0.5, 280)) continue;
    const items = node.querySelectorAll('a,button,[role="tab"]');
    if (items.length < 2) continue;
    let score = Math.min(items.length, 8);
    const pos = getComputedStyle(node).position;
    if (pos === 'fixed' || pos === 'sticky') score += 6;
    if (rect.top > innerHeight * 0.6) score += 6;
    if (node.tagName === 'NAV' || node.getAttribute('role') === 'tablist') score += 3;
    if (score > bestScore) { bestScore = score; nav = node; }
  }

  const navItems = nav ? Array.from(nav.children).filter((n) => n.nodeType === 1) : [];

  /* Colours actually painted, ranked by how much of the page uses them. */
  const paint = {};
  for (const el of Array.from(document.querySelectorAll('*')).slice(0, 1200)) {
    const s = getComputedStyle(el);
    for (const key of ['backgroundColor', 'color']) {
      const v = s[key];
      if (!v || v === 'rgba(0, 0, 0, 0)') continue;
      paint[v] = (paint[v] || 0) + 1;
    }
  }
  const palette = Object.entries(paint).sort((a, b) => b[1] - a[1]).slice(0, 14)
    .map(([color, count]) => ({ color, count }));

  const firstOf = (sel) => document.querySelector(sel);

  const report = {
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    cssVariables: vars,
    page: summarise(document.body, BOX),

    nav: nav ? {
      selectorTag: nav.tagName,
      className: typeof nav.className === 'string' ? nav.className : null,
      position: getComputedStyle(nav).position,
      styles: summarise(nav, BOX),
      itemCount: navItems.length,
      overflowsAtCurrentCount: nav.scrollWidth > nav.clientWidth + 2,
      scrollWidth: nav.scrollWidth,
      clientWidth: nav.clientWidth,
      /* The exact markup of one item — this is what gets cloned. */
      itemMarkup: navItems.map((n) => n.outerHTML.slice(0, 400)),
      itemStyles: navItems.map((n) => ({
        label: n.textContent.trim().slice(0, 24),
        styles: summarise(n, BOX),
        width: Math.round(n.getBoundingClientRect().width),
      })),
      iconStyles: navItems.map((n) => {
        const icon = n.querySelector('svg,img,i,[class*="icon" i]');
        return icon ? { tag: icon.tagName, styles: summarise(icon, BOX) } : null;
      }),
    } : 'NO NAV FOUND — this is itself the answer',

    samples: {
      heading: summarise(firstOf('h1,h2'), BOX),
      card: summarise(firstOf('[class*="card" i],section,article'), BOX),
      primaryButton: summarise(firstOf('button:not([class*="tab" i])'), BOX),
      input: summarise(firstOf('input,select,textarea'), BOX),
      link: summarise(firstOf('a'), BOX),
    },

    palette,
  };

  try { copy(report); console.log('Copied to clipboard.'); } catch (e) { /* not DevTools */ }
  console.log(report);
  return report;
})();
