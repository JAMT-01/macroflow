/**
 * The habits UI, served as a Worker route rather than a static file.
 *
 * Same rationale as worker/progress-assets.ts and worker/push-assets.ts: the
 * frontend lives in the `ASSETS` binding and there is no local copy of that
 * source (macroflow-kb.md §9), so a feature that needs UI has to bring its own.
 * Everything renders into a shadow root and the palette is sampled from the
 * running app at mount, so this follows the app's theme without a redeploy.
 *
 * KNOWN DUPLICATION. The theme reader and the nav-clone routine below are a
 * third copy of what push-assets.ts and progress-assets.ts already carry. That
 * is deliberate for now — each is an independent injected script in its own
 * shadow root, and the alternative (editing a deployed, working module to export
 * a shared source string) puts a live feature at risk to save bytes on a page
 * that is already cached. Collapse all three when the frontend source is
 * recovered and these move into it.
 *
 * THE REAL BAR, measured 2026-08-27 against the deployed build rather than
 * inferred from a screenshot description:
 *
 *   <div class="mobile-bar">              fixed, bottom, holds both children
 *     <nav class="bottom-nav">            display:grid, repeat(4,1fr), 66px
 *       <span class="nav-pill">           absolute, width (100%-10px)/4, slides
 *       <button>Today  Progress  Photos  Settings
 *     <button class="scan-fab">           capture — NOT a tab, sits outside
 *
 * Three things follow, and getting each of them wrong is what broke the bar:
 *
 *   1. The target is `.bottom-nav`, not `.mobile-bar`. findNav() must prefer the
 *      real <nav> over the wrapper that also contains the capture button.
 *   2. The grid track count is HARDCODED at 4. A fifth cell wraps to a second
 *      row that the 66px height hides, so fitNav() has to rewrite the tracks and
 *      the sliding pill's width.
 *   3. The item goes LAST, because the pill is positioned by an index into the
 *      app's own tab array — inserting earlier misaligns the highlight.
 *
 * The app already has its own Photos tab, which is why progress-assets.ts now
 * stands down when it finds one.
 */

export const HABITS_CLIENT_SOURCE = /* javascript */ `
'use strict';
(function () {
  var NAV_FLAG = 'data-macroflow-habits-nav';

  /* Ten weeks of dots: long enough to show a habit taking hold, short enough to
     stay one glance rather than a chart. Matches HISTORY_DAYS in worker/habits.ts. */
  var GRID_DAYS = 70;

  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    if (attrs) for (var key in attrs) node.setAttribute(key, attrs[key]);
    if (text != null) node.textContent = text;
    return node;
  }

  function trim(value) {
    return Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10);
  }

  function plural(count, word) {
    return count + ' ' + word + (count === 1 ? '' : 's');
  }

  function addDays(date, amount) {
    var p = date.split('-');
    var next = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + amount, 12));
    return next.getUTCFullYear() + '-' +
      String(next.getUTCMonth() + 1).padStart(2, '0') + '-' +
      String(next.getUTCDate()).padStart(2, '0');
  }

  function fmtDate(isoDate) {
    var p = isoDate.split('-');
    return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2], 12))
      .toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  /* ------------------------------------------------------------- theming */
  /*
   * Read from the app, not hardcoded — see PROGRESS-PHOTOS.md §9. The first
   * version of the photos UI shipped a fixed dark palette into a light lime app
   * and looked pasted in from somewhere else. Sampling the live page is what
   * fixed it, and it keeps following the app if the theme is ever changed.
   */

  function parseColor(value) {
    var text = String(value || '').trim();
    var m = text.match(/rgba?\\(([^)]+)\\)/);
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
  function rgba(c, a) { return 'rgba(' + Math.round(c.r) + ',' + Math.round(c.g) + ',' + Math.round(c.b) + ',' + a + ')'; }
  function mix(a, b, amount) {
    return { r: a.r + (b.r - a.r) * amount, g: a.g + (b.g - a.g) * amount, b: a.b + (b.b - a.b) * amount };
  }
  function luminance(c) { return (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255; }
  function saturation(c) {
    var hi = Math.max(c.r, c.g, c.b), lo = Math.min(c.r, c.g, c.b);
    return hi === 0 ? 0 : (hi - lo) / hi;
  }

  function pageBackground() {
    var node = document.body;
    while (node) {
      var c = parseColor(getComputedStyle(node).backgroundColor);
      if (c) return c;
      node = node.parentElement;
    }
    return { r: 255, g: 255, b: 255 };
  }

  function accentColor(pageBg, textColor) {
    var rootStyle = getComputedStyle(document.documentElement);
    var names = ['--accent', '--primary', '--brand', '--color-accent', '--color-primary',
      '--accent-color', '--primary-color', '--brand-color', '--theme-color', '--color-brand',
      '--lime', '--green', '--highlight', '--accent-1', '--c-accent'];
    for (var i = 0; i < names.length; i++) {
      var declared = parseColor(rootStyle.getPropertyValue(names[i]));
      if (declared && saturation(declared) > 0.15) return declared;
    }

    /* Scan DESCENDANTS of controls, not just the controls. This app puts its
       lime accent on a chip inside a pale card and on icon/heading text; the
       buttons themselves are near-white. Reading only button backgrounds is what
       once produced a blue button in a green app. */
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

    var texts = document.querySelectorAll('h1, h2, h3, h4, strong, b, [class*="accent" i], [class*="label" i]');
    for (var m = 0; m < texts.length && m < 120; m++) {
      consider(parseColor(getComputedStyle(texts[m]).color), 1);
    }

    if (best) return best;
    return textColor || (luminance(pageBg) > 0.5 ? { r: 30, g: 30, b: 32 } : { r: 235, g: 235, b: 240 });
  }

  function readTheme() {
    var bodyStyle = getComputedStyle(document.body);
    var bg = pageBackground();
    var dark = luminance(bg) < 0.5;
    var text = parseColor(bodyStyle.color) || (dark ? { r: 245, g: 245, b: 247 } : { r: 20, g: 20, b: 22 });
    var accent = accentColor(bg, text);

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
      surface: toCss(dark ? mix(bg, { r: 255, g: 255, b: 255 }, 0.07) : mix(bg, { r: 0, g: 0, b: 0 }, 0.04)),
      text: toCss(text),
      muted: toCss(mix(text, bg, 0.45)),
      border: toCss(mix(text, bg, 0.86)),
      accent: toCss(accent),
      /* Dots need the accent at low opacity for "missed" and full for "done", so
         the raw channels are kept rather than only the css string. */
      accentFaint: rgba(accent, 0.18),
      onAccent: luminance(accent) > 0.6 ? '#000' : '#fff',
      shadow: dark ? 'rgba(0,0,0,.5)' : 'rgba(0,0,0,.18)',
      danger: dark ? '#ff6961' : '#c0392b',
      warn: dark ? '#ffd60a' : '#a16207'
    };
  }

  function buildStyle(t) {
    return ':host{all:initial;}' +
    '*{box-sizing:border-box;font-family:' + t.font + ';}' +
    '.fab{position:fixed;right:16px;bottom:calc(152px + env(safe-area-inset-bottom));z-index:2147483000;' +
      'width:52px;height:52px;border:0;border-radius:50%;background:' + t.accent + ';color:' + t.onAccent + ';' +
      'font-size:23px;box-shadow:0 6px 20px ' + t.shadow + ';cursor:pointer;display:flex;align-items:center;' +
      'justify-content:center;}' +
    /*
     * FULL-BLEED, LIKE ONE OF THE APP'S PAGES.
     *
     * This previously stopped short of the nav (bottom: navReserve()) and had a
     * 22px bottom radius plus a drop shadow. That is the anatomy of a card
     * floating on top of something — which is precisely why it still read as an
     * overlay even once the nav pill moved onto it.
     *
     * The app's own screens do the opposite: .page fills the viewport and
     * .mobile-bar is a FLOATING bar (fixed, bottom:18px, inset 14px each side)
     * that hovers over the content scrolling beneath it. So the sheet now runs
     * edge to edge with square corners and no shadow, and the nav clearance
     * moved into padding-bottom — see applyReserve(). Same pixels of clearance,
     * but the panel now reads as the screen rather than a thing on top of it.
     *
     * overscroll-behavior:contain stops a scroll that reaches the end of this
     * panel from chaining into the page underneath. Without it the app scrolls
     * behind the sheet, which on a phone reads as the whole screen juddering.
     */
    /*
     * z-index 40 — UNDER the app's floating nav, not over everything.
     *
     * The app's ladder (src/styles.css): content 1-2, .mobile-bar 50,
     * .saved-toast 60, .photo-viewer 80, .modal-backdrop 100. At 40 this covers
     * every page element and the bar still floats on top of it, which is exactly
     * how the app's own screens sit under that bar. A maximal z-index painted
     * over the nav instead, hiding the tabs — and a panel that hides the
     * navigation is a modal by definition, however it is styled.
     *
     * This works only because the host is position:absolute with z-index auto
     * and so creates no stacking context; the sheet competes at the root. See
     * the note in mount().
     */
    '.sheet{position:fixed;inset:0;z-index:40;background:' + t.bg + ';color:' + t.text + ';' +
      'overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;padding:0;}' +
    /* Matches .page-header on mobile: 27px/-.03em title, 58px min-height, and
       the same 15px gutter .page uses. Deliberately NOT sticky — the app's page
       headers scroll away, and a pinned bar with a close button is modal chrome. */
    '.bar{display:flex;align-items:center;gap:12px;min-height:58px;' +
      'padding:calc(24px + env(safe-area-inset-top)) 15px 0;}' +
    '.bar h2{margin:0;font-size:27px;font-weight:700;letter-spacing:-.03em;line-height:1.08;flex:1;}' +
    '.x{background:none;border:0;color:' + t.muted + ';font-size:26px;line-height:1;cursor:pointer;padding:4px 8px;}' +
    '.tabs{display:flex;gap:6px;padding:18px 15px 4px;}' +
    '.tab{flex:1;padding:8px;border:0;border-radius:' + t.radius + ';background:' + t.surface + ';' +
      'color:' + t.muted + ';font-size:14px;font-weight:600;cursor:pointer;}' +
    '.tab[aria-selected="true"]{background:' + t.accent + ';color:' + t.onAccent + ';}' +
    '.body{padding:12px 15px;}' +
    '.hint{color:' + t.muted + ';font-size:13px;line-height:1.45;margin:4px 0 16px;}' +
    '.warn{border:1px solid ' + t.warn + ';border-radius:' + t.radius + ';padding:10px 12px;margin:0 0 14px;' +
      'font-size:13px;line-height:1.45;color:' + t.text + ';}' +
    '.warn b{color:' + t.warn + ';}' +

    /* habit card */
    '.card{border:1px solid ' + t.border + ';border-radius:' + t.radius + ';padding:14px;margin:0 0 12px;' +
      'background:' + t.surface + ';}' +
    '.top{display:flex;align-items:flex-start;gap:12px;}' +
    '.emoji{font-size:26px;line-height:1.1;}' +
    '.who{flex:1;min-width:0;}' +
    '.who h3{margin:0 0 3px;font-size:16px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
    '.sub{color:' + t.muted + ';font-size:13px;margin:0;}' +
    '.check{flex:none;width:46px;height:46px;border-radius:50%;border:2px solid ' + t.border + ';' +
      'background:transparent;color:' + t.muted + ';font-size:20px;cursor:pointer;display:flex;' +
      'align-items:center;justify-content:center;transition:background .12s,border-color .12s;}' +
    '.check[aria-pressed="true"]{background:' + t.accent + ';border-color:' + t.accent + ';color:' + t.onAccent + ';}' +
    '.check[disabled]{opacity:.45;cursor:default;}' +
    '.stats{display:flex;gap:14px;margin:12px 0 0;flex-wrap:wrap;}' +
    '.stat{font-size:12px;color:' + t.muted + ';}' +
    '.stat b{display:block;font-size:17px;font-weight:700;color:' + t.text + ';line-height:1.25;}' +

    /* dot grid */
    '.grid{display:grid;grid-template-columns:repeat(14,1fr);gap:3px;margin:12px 0 0;}' +
    '.dot{aspect-ratio:1;border-radius:2px;background:' + t.accentFaint + ';}' +
    '.dot[data-done="1"]{background:' + t.accent + ';}' +
    '.dot[data-future="1"]{background:transparent;}' +
    '.dot[data-today="1"]{outline:1.5px solid ' + t.text + ';outline-offset:1px;}' +

    /* per-habit controls */
    '.rows{margin:12px 0 0;border-top:1px solid ' + t.border + ';padding-top:10px;display:none;}' +
    '.card[data-open="1"] .rows{display:block;}' +
    '.row{display:flex;align-items:center;gap:10px;margin:0 0 10px;}' +
    '.row span{flex:1;font-size:13px;color:' + t.muted + ';}' +
    '.row input[type="time"],.row input[type="number"]{width:110px;flex:none;}' +
    '.more{background:none;border:0;color:' + t.muted + ';font-size:12px;font-weight:600;cursor:pointer;' +
      'padding:8px 0 0;text-transform:uppercase;letter-spacing:.04em;}' +
    '.danger{background:none;border:0;color:' + t.danger + ';font-size:13px;font-weight:600;cursor:pointer;padding:4px 0;}' +

    /* forms */
    'label{display:block;font-size:12px;font-weight:600;color:' + t.muted + ';margin:14px 0 6px;' +
      'text-transform:uppercase;letter-spacing:.04em;}' +
    'input,select,textarea{width:100%;padding:11px 12px;border:1px solid ' + t.border + ';' +
      'border-radius:' + t.radius + ';background:' + t.bg + ';color:' + t.text + ';font-size:16px;}' +
    '.pair{display:flex;gap:10px;}' +
    '.pair>div{flex:1;}' +
    '.go{width:100%;margin-top:20px;padding:14px;border:0;border-radius:' + t.radius + ';' +
      'background:' + t.accent + ';color:' + t.onAccent + ';font-size:16px;font-weight:600;cursor:pointer;}' +
    '.go[disabled]{opacity:.5;}' +
    '.empty{color:' + t.muted + ';font-size:14px;text-align:center;padding:40px 20px;line-height:1.5;}' +
    '.err{color:' + t.danger + ';font-size:13px;margin-top:12px;}';
  }

  /* ---------------------------------------------------------------- state */

  var host = null;
  var root = null;
  var habits = [];
  var today = '';
  var telegramReady = null;   /* null = unknown, true/false once /api/settings answers */
  var tab = 'today';
  var openCards = {};

  async function api(path, options) {
    var response = await fetch(path, Object.assign({ credentials: 'same-origin' }, options || {}));
    var payload = null;
    try { payload = await response.json(); } catch (error) { /* empty body */ }
    if (!response.ok) throw new Error((payload && payload.error) || 'Request failed');
    return payload;
  }

  async function refresh() {
    var data = await api('/api/habits');
    habits = data.habits || [];
    today = data.today;

    /*
     * Reminders go out over Telegram only. If the bot is not connected the times
     * below are inert, and saying so here is the whole point — macroflow-kb.md
     * §4 records exactly this failure once already: reminders configured, no
     * delivery channel, sent_reminders empty for weeks and nobody noticed.
     */
    if (telegramReady === null) {
      try {
        var settings = await api('/api/settings');
        telegramReady = Boolean(settings.telegramTokenConfigured && settings.telegramChatId);
      } catch (error) { telegramReady = null; }
    }
  }

  /* --------------------------------------------------------------- render */

  function render() {
    var view = root.querySelector('.body');
    view.textContent = '';
    root.querySelectorAll('.tab').forEach(function (node) {
      node.setAttribute('aria-selected', String(node.dataset.tab === tab));
    });
    if (tab === 'add') renderAdd(view);
    else renderToday(view);
  }

  function renderToday(view) {
    if (telegramReady === false && habits.some(function (h) { return h.reminderTime && h.reminderEnabled; })) {
      var warn = el('div', { class: 'warn' });
      warn.appendChild(el('b', null, 'Telegram is not connected. '));
      warn.appendChild(document.createTextNode(
        'Reminder times are saved but nothing will be sent. Add your bot token in Settings, then send /start to the bot.'));
      view.appendChild(warn);
    }

    if (!habits.length) {
      view.appendChild(el('p', { class: 'empty' },
        'No habits yet. A habit is the behaviour, not the result \\u2014 "walk 10 km", not "lose 2 kg".'));
      return;
    }

    habits.forEach(function (habit) { view.appendChild(renderCard(habit)); });
  }

  function renderCard(habit) {
    var card = el('div', { class: 'card' });
    if (openCards[habit.id]) card.setAttribute('data-open', '1');

    var top = el('div', { class: 'top' });
    top.appendChild(el('div', { class: 'emoji' }, habit.emoji));

    var who = el('div', { class: 'who' });
    who.appendChild(el('h3', null, habit.name));

    /* The day counter is the "today is my second day" number, and it is a
       different thing from the streak: day 12 with a 3-day streak says something
       the streak alone does not. */
    var bits = ['Day ' + habit.dayNumber];
    if (habit.doneToday) {
      bits.push(habit.todayValue !== null
        ? 'done \\u00b7 ' + trim(habit.todayValue) + (habit.unit ? ' ' + habit.unit : '')
        : 'done');
    } else if (habit.reminderTime && habit.reminderEnabled) {
      bits.push('reminder ' + habit.reminderTime);
    }
    who.appendChild(el('p', { class: 'sub' }, bits.join(' \\u00b7 ')));
    top.appendChild(who);

    var check = el('button', {
      class: 'check',
      'aria-pressed': String(habit.doneToday),
      'aria-label': (habit.doneToday ? 'Undo today for ' : 'Check off ') + habit.name
    }, habit.doneToday ? '\\u2713' : '');
    check.addEventListener('click', function () { toggle(habit, check); });
    top.appendChild(check);
    card.appendChild(top);

    var stats = el('div', { class: 'stats' });
    stats.appendChild(stat(plural(habit.streak, 'day'), 'streak'));
    stats.appendChild(stat(String(habit.longestStreak), 'best'));
    stats.appendChild(stat(String(habit.totalDone), 'days done'));
    if (habit.totalValue > 0 && habit.unit) {
      stats.appendChild(stat(trim(habit.totalValue) + ' ' + habit.unit, 'total'));
    }
    card.appendChild(stats);

    card.appendChild(buildGrid(habit));

    var more = el('button', { class: 'more' }, openCards[habit.id] ? 'Hide settings' : 'Settings');
    more.addEventListener('click', function () {
      openCards[habit.id] = !openCards[habit.id];
      render();
    });
    card.appendChild(more);
    card.appendChild(buildRows(habit));

    return card;
  }

  function stat(value, label) {
    var node = el('div', { class: 'stat' });
    node.appendChild(el('b', null, value));
    node.appendChild(document.createTextNode(label));
    return node;
  }

  /*
   * GRID_DAYS cells ending on today, oldest first, so it reads left-to-right
   * like a calendar. Days before the habit existed are drawn as future/empty
   * rather than missed — showing a wall of red for days that were never on the
   * board is both wrong and discouraging.
   */
  function buildGrid(habit) {
    var grid = el('div', { class: 'grid', 'aria-hidden': 'true' });
    var done = {};
    habit.history.forEach(function (date) { done[date] = true; });

    for (var offset = GRID_DAYS - 1; offset >= 0; offset--) {
      var date = addDays(today, -offset);
      var dot = el('div', { class: 'dot', title: fmtDate(date) });
      if (done[date]) dot.setAttribute('data-done', '1');
      else if (date < habit.startedOn) dot.setAttribute('data-future', '1');
      if (date === today) dot.setAttribute('data-today', '1');
      grid.appendChild(dot);
    }
    return grid;
  }

  function buildRows(habit) {
    var rows = el('div', { class: 'rows' });

    var timeRow = el('div', { class: 'row' });
    timeRow.appendChild(el('span', null, 'Telegram reminder'));
    var time = el('input', { type: 'time', value: habit.reminderTime || '' });
    time.addEventListener('change', function () {
      save(habit.id, { reminderTime: time.value || null });
    });
    timeRow.appendChild(time);
    rows.appendChild(timeRow);

    if (habit.targetValue !== null) {
      var targetRow = el('div', { class: 'row' });
      targetRow.appendChild(el('span', null, 'Target' + (habit.unit ? ' (' + habit.unit + ')' : '')));
      var target = el('input', { type: 'number', step: '0.1', min: '0.1', value: String(habit.targetValue) });
      target.addEventListener('change', function () {
        save(habit.id, { targetValue: Number(target.value) });
      });
      targetRow.appendChild(target);
      rows.appendChild(targetRow);
    }

    if (habit.doneToday) {
      var actualRow = el('div', { class: 'row' });
      actualRow.appendChild(el('span', null, 'Logged today'));
      var actual = el('input', {
        type: 'number', step: '0.1', min: '0',
        value: habit.todayValue === null ? '' : String(habit.todayValue)
      });
      actual.addEventListener('change', function () {
        checkInWith(habit.id, actual.value === '' ? null : Number(actual.value));
      });
      actualRow.appendChild(actual);
      rows.appendChild(actualRow);
    }

    /* Archive, not delete. Deleting cascades the entries away, and a streak you
       spent two months on should not be one tap from gone. */
    var archive = el('button', { class: 'danger' }, 'Archive this habit');
    archive.addEventListener('click', function () {
      if (!confirm('Archive "' + habit.name + '"? Its history is kept.')) return;
      save(habit.id, { archived: true });
    });
    rows.appendChild(archive);

    return rows;
  }

  function renderAdd(view) {
    view.appendChild(el('p', { class: 'hint' },
      'Track the behaviour, not the outcome. One tap a day, and a reminder over Telegram if you want one.'));

    var name = field(view, 'Habit', el('input', { type: 'text', placeholder: 'Walk 10 km', maxlength: '60' }));
    var emoji = null;
    var target = null;
    var unit = null;

    var pair = el('div', { class: 'pair' });
    var left = el('div');
    left.appendChild(el('label', null, 'Emoji'));
    emoji = el('input', { type: 'text', value: '\\u2705', maxlength: '4' });
    left.appendChild(emoji);
    var mid = el('div');
    mid.appendChild(el('label', null, 'Target'));
    target = el('input', { type: 'number', step: '0.1', min: '0.1', placeholder: '10' });
    mid.appendChild(target);
    var right = el('div');
    right.appendChild(el('label', null, 'Unit'));
    unit = el('input', { type: 'text', placeholder: 'km', maxlength: '12' });
    right.appendChild(unit);
    pair.appendChild(left); pair.appendChild(mid); pair.appendChild(right);
    view.appendChild(pair);

    var started = field(view, 'Started on', el('input', { type: 'date', value: today, max: today }));
    var reminder = field(view, 'Telegram reminder (optional)', el('input', { type: 'time' }));

    var error = el('p', { class: 'err' });
    var go = el('button', { class: 'go' }, 'Add habit');
    go.addEventListener('click', async function () {
      error.textContent = '';
      if (!name.value.trim()) { error.textContent = 'Give the habit a name'; return; }
      go.disabled = true;
      try {
        await api('/api/habits', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: name.value,
            emoji: emoji.value,
            targetValue: target.value === '' ? null : Number(target.value),
            unit: unit.value,
            startedOn: started.value || today,
            reminderTime: reminder.value || null
          })
        });
        await refresh();
        tab = 'today';
        render();
      } catch (failure) {
        error.textContent = failure.message;
      } finally {
        go.disabled = false;
      }
    });
    view.appendChild(go);
    view.appendChild(error);
  }

  function field(view, label, input) {
    view.appendChild(el('label', null, label));
    view.appendChild(input);
    return input;
  }

  /* --------------------------------------------------------------- actions */

  /*
   * Optimistic: the circle fills on tap and the request follows. A check-in is
   * the single most repeated action in this feature and it happens on a phone,
   * often on bad signal — waiting on a round trip to show it registered is what
   * makes people tap twice. The server is idempotent (UNIQUE habit_id+done_date)
   * so a double tap cannot double-count, and a failure re-renders from the truth.
   */
  async function toggle(habit, button) {
    var next = !habit.doneToday;
    button.setAttribute('aria-pressed', String(next));
    button.textContent = next ? '\\u2713' : '';
    button.disabled = true;

    try {
      if (next) {
        await api('/api/habits/' + habit.id + '/check', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          /* Default the value to the target: checking off "Walk 10 km" means
             10 km unless the actual number is edited afterwards. */
          body: JSON.stringify({ value: habit.targetValue })
        });
      } else {
        await api('/api/habits/' + habit.id + '/check', { method: 'DELETE' });
      }
      await refresh();
    } catch (error) {
      /* leave the state alone; the refresh below re-reads the truth */
    } finally {
      button.disabled = false;
      render();
    }
  }

  async function checkInWith(id, value) {
    try {
      await api('/api/habits/' + id + '/check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: value })
      });
      await refresh();
    } catch (error) { /* re-render from truth */ }
    render();
  }

  async function save(id, patch) {
    try {
      await api('/api/habits/' + id, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch)
      });
      await refresh();
    } catch (error) { /* re-render from truth */ }
    render();
  }

  /* ----------------------------------------------------------------- sheet */

  /*
   * How much of the bottom the app's own nav bar occupies.
   *
   * The sheet stops above it rather than covering it, for a reason that is not
   * cosmetic: 'position:fixed' on the shadow host CREATES A STACKING CONTEXT, so
   * the sheet's z-index only competes inside that context. Against the app's bar
   * (z-index 50) the host counts as 0, and the bar therefore paints ON TOP of
   * the sheet no matter how large the sheet's z-index is. Fighting that is not
   * winnable from inside a shadow root; leaving the bar its own space is both
   * honest and better — the tabs stay visible and usable with the sheet open.
   *
   * Measured from the outermost fixed ancestor of the launcher, so the detached
   * capture button beside the tabs is included.
   */
  function navReserve() {
    var item = document.querySelector('[' + NAV_FLAG + ']');
    if (!item) return 0;

    var bar = item;
    var node = item;
    while (node && node !== document.body) {
      if (getComputedStyle(node).position === 'fixed') { bar = node; break; }
      node = node.parentElement;
    }

    var rect = bar.getBoundingClientRect();
    /* Only a bar along the bottom needs reserving; a top or side nav does not
       overlap the sheet's content. */
    if (!rect.height || rect.top < window.innerHeight * 0.5) return 0;
    return Math.max(0, Math.round(window.innerHeight - rect.top) + 10);
  }

  /* Clearance for the floating nav goes in padding, not in the bottom offset. Shortening
     the element left a visible gap and a card edge above the bar; padding keeps
     the panel full-bleed while its content still stops above the nav. */
  function applyReserve() {
    var sheet = root.querySelector('.sheet');
    if (sheet) sheet.style.paddingBottom = navReserve() + 'px';
  }

  function isOpen() {
    return Boolean(root.querySelector('.sheet'));
  }

  /*
   * Make the bar treat Habits as a real tab.
   *
   * Without this the panel reads as an overlay sitting on top of whichever tab
   * you came from: the sheet covers the screen, but the sliding pill stays under
   * Today (or Settings, or wherever you were) and that tab keeps its .active
   * styling. Two tabs then appear to be open at once, which is exactly the
   * "overlay on Settings" complaint.
   *
   * The app drives the highlight with two things, both discoverable from
   * src/styles.css and src/components/Layout.tsx:
   *
   *   .nav-pill { transform: translateX(calc(var(--nav-index,0) * 100%)) }
   *   .bottom-nav button.active { color: var(--ink) }   // + bold label
   *
   * and React writes --nav-index as an inline style on .bottom-nav. So moving
   * the pill is a matter of setting that variable to this item's cell index and
   * moving the .active class. fitNav() has already rewritten the pill's width to
   * match the new track count, so index * 100% lands on the right cell.
   *
   * The previous values are saved rather than recomputed, because the app owns
   * them: on close they go back exactly as they were, and any later React render
   * overwrites them anyway with whatever the app believes is active.
   */
  var savedNav = null;

  function claimNavHighlight() {
    var item = document.querySelector('[' + NAV_FLAG + ']');
    if (!item) return;
    var nav = item.parentElement;
    if (!nav) return;

    var cells = navCells(nav);
    var index = cells.indexOf(item);
    if (index < 0) return;

    var previous = null;
    for (var i = 0; i < cells.length; i++) {
      if (cells[i] !== item && cells[i].classList.contains('active')) {
        previous = cells[i];
        cells[i].classList.remove('active');
      }
    }

    if (!savedNav) {
      savedNav = { nav: nav, index: nav.style.getPropertyValue('--nav-index'), active: previous };
    }
    nav.style.setProperty('--nav-index', String(index));
    item.classList.add('active');
  }

  function releaseNavHighlight() {
    var item = document.querySelector('[' + NAV_FLAG + ']');
    if (item) item.classList.remove('active');
    if (!savedNav) return;
    if (savedNav.index) savedNav.nav.style.setProperty('--nav-index', savedNav.index);
    else savedNav.nav.style.removeProperty('--nav-index');
    if (savedNav.active) savedNav.active.classList.add('active');
    savedNav = null;
  }

  function close() {
    var sheet = root.querySelector('.sheet');
    if (sheet) sheet.remove();
    releaseNavHighlight();
    var item = document.querySelector('[' + NAV_FLAG + ']');
    if (item) item.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onOutsideClick, true);
    document.removeEventListener('keydown', onKeydown, true);
    window.removeEventListener('resize', applyReserve);
  }

  /*
   * Anything tapped outside the sheet closes it — most importantly one of the
   * app's own tabs, which previously navigated BEHIND the open sheet and made it
   * look stuck. The launcher itself is excluded: its own handler toggles, and
   * closing here first would let that toggle immediately re-open it.
   *
   * Nothing is cancelled, so the app still navigates on the same tap.
   */
  function onOutsideClick(event) {
    if (!isOpen()) return;
    var item = document.querySelector('[' + NAV_FLAG + ']');
    if (item && (event.target === item || item.contains(event.target))) return;
    if (host && (event.target === host || host.contains(event.target))) return;
    close();
  }

  function onKeydown(event) {
    if (event.key === 'Escape' || event.key === 'Esc') close();
  }

  function open() {
    if (isOpen()) { close(); return; }

    claimNavHighlight();

    /*
     * 'region', not 'dialog'. It behaves as one of the app's screens now — the
     * bar highlights it, and tapping another tab leaves it — so announcing it as
     * a modal dialog would misdescribe it to a screen reader. Escape and
     * outside-tap still close it, which is a convenience here rather than the
     * modal contract.
     */
    var sheet = el('div', { class: 'sheet', role: 'region', 'aria-label': 'Habits' });

    var bar = el('div', { class: 'bar' });
    bar.appendChild(el('h2', null, 'Habits'));
    var closeButton = el('button', { class: 'x', 'aria-label': 'Close habits' }, '\\u00d7');
    closeButton.addEventListener('click', close);
    bar.appendChild(closeButton);
    sheet.appendChild(bar);

    var tabs = el('div', { class: 'tabs' });
    [['today', 'Today'], ['add', 'New habit']].forEach(function (entry) {
      var button = el('button', { class: 'tab', 'data-tab': entry[0] }, entry[1]);
      button.dataset.tab = entry[0];
      button.addEventListener('click', function () { tab = entry[0]; render(); });
      tabs.appendChild(button);
    });
    sheet.appendChild(tabs);
    sheet.appendChild(el('div', { class: 'body' }));
    root.appendChild(sheet);

    applyReserve();
    var item = document.querySelector('[' + NAV_FLAG + ']');
    if (item) item.setAttribute('aria-expanded', 'true');

    /* Capture phase, so a tap still closes this even if the app stops
       propagation on its own controls. */
    document.addEventListener('click', onOutsideClick, true);
    document.addEventListener('keydown', onKeydown, true);
    window.addEventListener('resize', applyReserve);

    tab = 'today';
    var view = sheet.querySelector('.body');
    view.appendChild(el('p', { class: 'empty' }, 'Loading\\u2026'));
    refresh().then(render).catch(function (error) {
      view.textContent = '';
      view.appendChild(el('p', { class: 'err' }, error.message));
    });
  }

  /* ------------------------------------------------------------------- nav */

  var CHECK_ICON = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>';

  /*
   * Find the real tab bar.
   *
   * Scored rather than selected, because the app's markup is not knowable from
   * here. Two rules below exist because the first version of this got it wrong
   * against the actual app, which lays out its bar as:
   *
   *   <div class="mobile-bar">            <- fixed, bottom, wraps everything
   *     <nav class="bottom-nav"> ...4 tabs... </nav>
   *     <button class="scan-fab">         <- capture, deliberately NOT a tab
   *   </div>
   *
   * Scoring by control count alone put '.mobile-bar' (6 controls, fixed, low)
   * above '.bottom-nav' (4 controls, static) — so the launcher was appended
   * beside the nav as a second capture button, squashing the bar.
   */
  function findNav() {
    /* Already placed? Then the bar is whatever currently holds it. Exact, and
       cheaper than re-scoring the document. */
    var placed = document.querySelector('[' + NAV_FLAG + ']');
    if (placed && placed.parentElement) return placed.parentElement;

    var candidates = document.querySelectorAll('nav, [role="tablist"], footer, div, ul');
    var floor = Math.min(window.innerWidth * 0.5, 280);
    var scored = [];

    for (var i = 0; i < candidates.length && i < 400; i++) {
      var node = candidates[i];
      var rect = node.getBoundingClientRect();
      if (rect.width < floor || rect.height < 34 || rect.height > 120) continue;

      var controls = node.querySelectorAll('a, button, [role="tab"]');
      if (controls.length < 2) continue;

      var position = getComputedStyle(node).position;
      var isRealNav = node.tagName === 'NAV' || node.getAttribute('role') === 'tablist';
      var pinned = position === 'fixed' || position === 'sticky';
      var anchoredLow = rect.top > window.innerHeight * 0.6;

      /*
       * Hard gate, not just a score. "Wide, short, several controls" also
       * describes a date strip, a segmented filter, a toolbar — and on the wide
       * layout it matched the app's week picker, putting a Habits button inside
       * the date selector. A navigation bar is a real <nav>, or it is pinned to
       * the viewport, or it sits along the bottom. Anything else is not one.
       */
      if (!isRealNav && !pinned && !anchoredLow) continue;

      /* Capped: a wrapper that sweeps up extra controls must not out-score the
         real bar on sheer count. */
      var score = Math.min(controls.length, 8);
      if (pinned) score += 8;
      if (anchoredLow) score += 6;
      /* A <nav>/tablist IS the bar; a div that merely contains one is its
         layout wrapper. Weighted heavily enough to settle exactly that case. */
      if (isRealNav) score += 14;

      scored.push({ node: node, score: score });
    }

    /* Drop any candidate that contains another candidate — the inner element is
       the bar, the outer one is the wrapper around it. */
    var best = null;
    for (var j = 0; j < scored.length; j++) {
      var contains = false;
      for (var k = 0; k < scored.length; k++) {
        if (k !== j && scored[j].node.contains(scored[k].node)) { contains = true; break; }
      }
      if (contains) continue;
      if (!best || scored[j].score > best.score) best = scored[j];
    }
    return best ? best.node : null;
  }

  /* Children that actually occupy a cell. An absolutely-positioned child is a
     decoration — the app's sliding highlight pill is one — and must never be
     counted as a tab, cloned as a template, or laid out as a grid item. */
  function navCells(nav) {
    return [].slice.call(nav.children).filter(function (node) {
      return node.nodeType === 1 && getComputedStyle(node).position !== 'absolute' &&
        node.getBoundingClientRect().height > 0;
    });
  }

  function navOverlays(nav) {
    return [].slice.call(nav.children).filter(function (node) {
      return node.nodeType === 1 && getComputedStyle(node).position === 'absolute';
    });
  }

  /* Clone an existing item rather than build one: the clone carries the app's
     class names, icon sizing and active-state markup for free, none of which are
     knowable from here. Only the icon, the label and the active state change. */
  function buildNavItem(nav) {
    var siblings = navCells(nav).filter(function (node) {
      return !node.hasAttribute(NAV_FLAG);
    });
    if (siblings.length < 2) return null;

    var item = siblings[siblings.length - 1].cloneNode(true);
    item.setAttribute(NAV_FLAG, '1');

    item.removeAttribute('aria-current');
    item.removeAttribute('aria-selected');
    item.removeAttribute('data-active');
    if (item.className && typeof item.className === 'string') {
      item.className = item.className
        .split(/\\s+/)
        .filter(function (name) { return !/(active|selected|current)/i.test(name); })
        .join(' ');
    }

    if (item.tagName === 'A') item.setAttribute('href', 'javascript:void(0)');
    var innerLinks = item.querySelectorAll('a');
    for (var i = 0; i < innerLinks.length; i++) innerLinks[i].setAttribute('href', 'javascript:void(0)');

    /*
     * Find the icon. The selector covers SVG/img/icon-font markup; the fallback
     * covers a nav that draws its icons as emoji in a plain element, which the
     * selector misses entirely. Without it the clone keeps the icon of whatever
     * item it was copied from — a Settings gear labelled "Habits" — and that is
     * the one failure mode that looks like a bug rather than a rough edge.
     */
    var icon = item.querySelector('svg,img,i,[class*="icon" i]');
    if (!icon) {
      var leaves = item.querySelectorAll('*');
      for (var g = 0; g < leaves.length; g++) {
        var leaf = leaves[g];
        if (leaf.children.length) continue;
        var glyph = (leaf.textContent || '').trim();
        /* A glyph, not a word: one or two code units and no letters or digits.
           Array.from counts astral emoji as one, which /./ would not. */
        if (glyph && Array.from(glyph).length <= 2 && !/[\\p{L}\\p{N}]/u.test(glyph)) { icon = leaf; break; }
      }
    }
    if (icon) {
      var holder = document.createElement('span');
      holder.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;' +
        'font-size:' + (getComputedStyle(icon).fontSize || '22px') + ';';
      holder.innerHTML = CHECK_ICON;
      icon.parentNode.replaceChild(holder, icon);
    }

    var labelled = null;
    var walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT, null);
    var textNode;
    while ((textNode = walker.nextNode())) {
      if (textNode.nodeValue && textNode.nodeValue.trim()) labelled = textNode;
    }
    if (labelled) labelled.nodeValue = 'Habits';
    else if (!icon) item.textContent = 'Habits';

    item.setAttribute('aria-label', 'Habits');
    item.setAttribute('title', 'Habits');
    item.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      open();
    });
    return item;
  }

  /*
   * Make room for the extra cell.
   *
   * The previous version only handled flex, and only when the bar overflowed
   * horizontally. The real bar is a CSS GRID with a hardcoded track count:
   *
   *   .bottom-nav { display:grid; grid-template-columns:repeat(4,1fr); height:66px }
   *   .nav-pill   { width:calc((100% - 10px)/4); transform:translateX(...) }
   *
   * A grid does not overflow sideways — it wraps to a second row, which a fixed
   * 66px height then hides. So the old check never fired and the fifth tab
   * dropped out of the bar entirely. Grids need the track count rewritten, and
   * any absolutely-positioned highlight resized to match the new track.
   */
  function fitNav(nav) {
    var style = getComputedStyle(nav);
    var count = navCells(nav).length;
    if (!count) return;

    if (style.display.indexOf('grid') !== -1) {
      var tracks = (style.gridTemplateColumns || '').split(/\\s+/).filter(function (value) {
        return value && value !== 'none';
      }).length;
      if (tracks >= count) return;

      /* Derived from the bar's own padding rather than hardcoded, so the
         highlight keeps lining up whatever the app's inset happens to be. */
      var pad = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
      navOverlays(nav).forEach(function (overlay) {
        overlay.setAttribute('data-macroflow-navpill', '');
      });

      nav.setAttribute('data-macroflow-grid', String(count));
      var id = 'macroflow-nav-grid-' + count;
      if (document.getElementById(id)) return;
      var gridStyle = document.createElement('style');
      gridStyle.id = id;
      gridStyle.textContent =
        '[data-macroflow-grid="' + count + '"]{grid-template-columns:repeat(' + count + ',1fr) !important;}' +
        '[data-macroflow-grid="' + count + '"] > [data-macroflow-navpill]{' +
          'width:calc((100% - ' + pad + 'px) / ' + count + ') !important;}' +
        '[data-macroflow-grid="' + count + '"] > * > span{max-width:100%;white-space:nowrap;' +
          'overflow:hidden;text-overflow:ellipsis;}';
      document.head.appendChild(gridStyle);
      return;
    }

    if (nav.scrollWidth <= nav.clientWidth + 2) return;
    nav.setAttribute('data-macroflow-fit', '1');
    if (document.getElementById('macroflow-nav-fit')) return;

    var flexStyle = document.createElement('style');
    flexStyle.id = 'macroflow-nav-fit';
    flexStyle.textContent =
      '[data-macroflow-fit]{gap:2px !important;column-gap:2px !important;}' +
      '[data-macroflow-fit] > *{min-width:0 !important;flex:1 1 0 !important;' +
        'padding-left:3px !important;padding-right:3px !important;}' +
      '[data-macroflow-fit] > * *{max-width:100%;white-space:nowrap;overflow:hidden;' +
        'text-overflow:ellipsis;}';
    document.head.appendChild(flexStyle);
  }

  /* Present AND actually on screen. A fixed element has no offsetParent, hence
     the second test. */
  function isShown(node) {
    return Boolean(node.offsetParent) || getComputedStyle(node).position === 'fixed';
  }

  function ensureNavItem() {
    var existing = document.querySelector('[' + NAV_FLAG + ']');
    if (existing) {
      if (isShown(existing)) return true;
      /* The bar it lives in is hidden — the app swaps its bottom bar for a
         sidebar above 760px. Drop the stale item so a fresh placement (or the
         floating fallback) can take over. */
      existing.remove();
    }

    var nav = findNav();
    if (!nav) return false;
    var item = buildNavItem(nav);
    if (!item) return false;

    /*
     * Appended LAST, not second-to-last as the photos launcher does.
     *
     * The app highlights the active tab with a single pill positioned by an
     * index into the app's OWN tab array ('--nav-index'). Inserting ahead of a
     * native tab shifts that tab one cell right while its index stays put, so
     * the highlight lands on the wrong tab. Appending after every native tab
     * leaves every native index pointing at the cell it already pointed at.
     *
     * The cost is that this sits after Settings rather than before it. That is
     * the right trade: a launcher in an unconventional position is a small
     * oddity, a highlight under the wrong tab reads as a broken app.
     */
    nav.appendChild(item);

    /* Judge by the result, not the placement: if it landed somewhere invisible,
       report failure so the floating fallback takes the job. */
    if (!isShown(item)) {
      item.remove();
      return false;
    }

    fitNav(nav);
    return true;
  }

  /* ----------------------------------------------------------------- mount */

  function addFallbackButton() {
    if (root.querySelector('.fab')) return;
    /* Sits above the photos fallback (88px) so the two cannot overlap when
       neither finds a nav. */
    var fab = el('button', { class: 'fab', 'aria-label': 'Habits', title: 'Habits' }, '\\u2713');
    fab.addEventListener('click', open);
    root.appendChild(fab);
  }

  function mount() {
    host = el('div');
    /*
     * ABSOLUTE, NOT FIXED. This one word decides whether the sheet is visible.
     *
     * 'position:fixed' ALWAYS creates a stacking context. With the host fixed,
     * the sheet's z-index of 2147483001 only ranked against its own siblings
     * inside that context, while the host itself entered the page at z-index
     * auto — so every app element with a positive z-index painted OVER the
     * sheet. In this app that is .calorie-copy and .calorie-ring at z-index 1,
     * which is why the calorie figures showed through the panel, plus
     * .modal-backdrop (100), .photo-viewer (80), .saved-toast (60) and
     * .mobile-bar (50). Scrolling then slid those layers across a stationary
     * sheet, which is what read as tearing.
     *
     * 'position:absolute' with z-index auto creates NO stacking context, so the
     * sheet competes at the root and outranks all of them. The host is still
     * out of flow at 0x0, so it contributes no line box — which is the reason
     * it was taken out of flow in the first place. Fixed descendants stay
     * viewport-anchored either way: only transform/filter/perspective on an
     * ancestor would change that, and there is none here.
     */
    host.style.cssText = 'all:initial;position:absolute;top:0;left:0;width:0;height:0;';
    root = host.attachShadow({ mode: 'open' });
    root.appendChild(el('style', null, buildStyle(readTheme())));
    document.body.appendChild(host);

    if (!ensureNavItem()) addFallbackButton();

    var queued = false;
    function settle() {
      if (!document.body.contains(host)) document.body.appendChild(host);
      if (ensureNavItem()) {
        var fab = root.querySelector('.fab');
        if (fab) fab.remove();
      } else {
        addFallbackButton();
      }
      /*
       * React owns --nav-index and the .active class, and rewrites both on any
       * render — a dashboard refresh mid-session would otherwise snap the pill
       * back to the app's tab while the habits panel is still open. Re-asserting
       * here is idempotent: claimNavHighlight() keeps the first saved values, so
       * close() still restores the state the app actually had.
       */
      if (isOpen()) claimNavHighlight();
    }

    new MutationObserver(function () {
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () {
        queued = false;
        settle();
      });
    }).observe(document.body, { childList: true, subtree: true });

    /* Crossing the app's 760px breakpoint swaps the bottom bar for a sidebar
       without necessarily mutating the body, so the observer alone would miss
       it — the launcher would stay in a bar the media query has hidden. */
    var resizeTimer = null;
    window.addEventListener('resize', function () {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(settle, 180);
    });
  }

  /* Wait for the app to paint: on DOMContentLoaded an SPA body is still empty,
     so readTheme() would sample an unpainted page and find no nav. */
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

export function habitsClientResponse(): Response {
  return new Response(HABITS_CLIENT_SOURCE, {
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      // `private`, like progress-client.js — this route sits behind the password
      // gate, so no shared cache should ever hold a copy.
      'cache-control': 'private, max-age=300',
    },
  });
}

/**
 * Append the client script to served HTML. Non-HTML responses pass through
 * untouched, so this is safe to wrap around the whole asset fallthrough.
 *
 * Chain it with the progress injector — HTMLRewriter streams, so two passes do
 * not each buffer the document:
 *   app.all('*', async (c) =>
 *     injectHabitsClient(injectProgressClient(await c.env.ASSETS.fetch(c.req.raw))))
 */
export function injectHabitsClient(response: Response): Response {
  if (!(response.headers.get('content-type') || '').includes('text/html')) return response;
  return new HTMLRewriter()
    .on('head', {
      element(element) {
        element.append('<script src="/habits-client.js" defer></script>', { html: true });
      },
    })
    .transform(response);
}
