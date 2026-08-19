/*
 * The two things on this site that need a script: the theme control, and wiki
 * search. Both degrade — the theme falls back to the device's preference
 * through a media query in site.css, and the search box is a real <form>
 * pointing at the wiki index.
 *
 * No modules, no imports, one file. There is nothing here worth a second
 * request, and this is a documentation site whose visitors arrive on phones
 * from search results.
 */
(function () {
  'use strict';

  /* ---------------------------------------------------------------- theme */

  var KEY = 'habiterall-site-theme';

  /*
   * Three states, in the app's own order and with the app's own glyphs —
   * ◐ follow the device, ☀ light, ☾ dark. `system` REMOVES the attribute
   * rather than resolving it to light or dark, which is the difference between
   * a page that follows the device when the device changes at sunset and one
   * that froze whichever it was when you loaded it.
   */
  var STATES = [
    { value: 'system', icon: '◐', label: 'Theme: follow the device' },
    { value: 'light', icon: '☀', label: 'Theme: light' },
    { value: 'dark', icon: '☾', label: 'Theme: dark' },
  ];

  function readTheme() {
    try {
      var stored = localStorage.getItem(KEY);
      for (var i = 0; i < STATES.length; i++) {
        if (STATES[i].value === stored) return stored;
      }
    } catch (e) {
      /* A browser with storage denied still gets a working page. */
    }
    return 'system';
  }

  function applyTheme(value, button) {
    if (value === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = value;

    var state = STATES.find(function (s) { return s.value === value; }) || STATES[0];
    if (button) {
      button.dataset.icon = state.icon;
      button.setAttribute('aria-label', state.label);
      button.setAttribute('title', state.label + ' (click to change)');
    }
  }

  var toggle = document.querySelector('.theme-toggle');
  var theme = readTheme();
  applyTheme(theme, toggle);

  if (toggle) {
    toggle.addEventListener('click', function () {
      var index = STATES.findIndex(function (s) { return s.value === theme; });
      theme = STATES[(index + 1) % STATES.length].value;
      try { localStorage.setItem(KEY, theme); } catch (e) { /* see readTheme */ }
      applyTheme(theme, toggle);
    });
  }

  /* --------------------------------------------------------------- search */

  var forms = document.querySelectorAll('.search');
  if (!forms.length) return;

  var index = null;
  var loading = null;

  // The site's base path, written onto <html> by the layout. Read from there
  // rather than assumed to be '/', so that moving the site under a path prefix
  // — a project Pages URL, a preview deploy — does not leave search fetching
  // an index that is one directory up from where it lives.
  var base = document.documentElement.dataset.base || '/';

  function load() {
    if (index) return Promise.resolve(index);
    if (!loading) {
      loading = fetch(base + 'search-index.json')
        .then(function (r) { return r.ok ? r.json() : []; })
        .then(function (data) { index = data; return index; })
        .catch(function () { index = []; return index; });
    }
    return loading;
  }

  /*
   * Every query term has to appear somewhere in the record — an AND, not an OR.
   * "row level security" matching every page containing the word "security" is
   * how a search box stops being used: the top result is never the one meant,
   * and after twice nobody types into it again.
   *
   * Scoring puts a match in the heading far above one in the body, and a whole
   * word above a fragment, so `ntfy` finds the ntfy SECTION rather than the
   * six pages that mention it in passing.
   */
  function search(query) {
    var terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];

    var hits = [];
    for (var i = 0; i < index.length; i++) {
      var record = index[i];
      var title = record.t.toLowerCase();
      var body = record.b.toLowerCase();
      var score = 0;
      var all = true;

      for (var j = 0; j < terms.length; j++) {
        var term = terms[j];
        var inTitle = title.indexOf(term);
        var inBody = body.indexOf(term);
        if (inTitle < 0 && inBody < 0) { all = false; break; }

        if (inTitle === 0) score += 60;
        else if (inTitle > 0) score += 30;
        if (new RegExp('\\b' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(title)) score += 25;
        if (inBody >= 0) score += 4;
      }

      if (all) hits.push({ record: record, score: score });
    }

    hits.sort(function (a, b) { return b.score - a.score; });
    return hits.slice(0, 12).map(function (h) { return h.record; });
  }

  function excerpt(record, query) {
    var term = query.toLowerCase().split(/\s+/)[0];
    var at = record.b.toLowerCase().indexOf(term);
    if (at < 0) return record.b.slice(0, 110);
    var start = Math.max(0, at - 35);
    return (start ? '…' : '') + record.b.slice(start, start + 120).trim() + '…';
  }

  forms.forEach(function (form) {
    var input = /** @type {HTMLInputElement} */ (form.querySelector('input'));
    var panel = /** @type {HTMLElement} */ (form.querySelector('.search-results'));
    var active = -1;

    function render(results, query) {
      active = -1;
      if (!query) { panel.hidden = true; panel.innerHTML = ''; return; }

      if (!results.length) {
        panel.innerHTML = '<p class="search-empty">Nothing matched “' +
          query.replace(/[<&]/g, function (c) { return c === '<' ? '&lt;' : '&amp;'; }) + '”.</p>';
        panel.hidden = false;
        return;
      }

      panel.innerHTML = results.map(function (r) {
        return '<a href="' + r.u + '"><strong></strong><span></span></a>';
      }).join('');

      // Text set through textContent rather than interpolated into the HTML
      // above: these strings are the README's, which contains angle brackets,
      // ampersands and quotes in abundance.
      var links = panel.querySelectorAll('a');
      results.forEach(function (r, i) {
        links[i].querySelector('strong').textContent = r.t;
        links[i].querySelector('span').textContent = r.p + ' · ' + excerpt(r, query);
      });
      panel.hidden = false;
    }

    function run() {
      var query = input.value.trim();
      if (!query) { render([], ''); return; }
      load().then(function () { render(search(query), query); });
    }

    input.addEventListener('input', run);
    input.addEventListener('focus', load);

    input.addEventListener('keydown', function (event) {
      var links = panel.querySelectorAll('a');

      if (event.key === 'Escape') { input.value = ''; render([], ''); return; }
      if (!links.length) return;

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        active = event.key === 'ArrowDown'
          ? Math.min(active + 1, links.length - 1)
          : Math.max(active - 1, 0);
        links.forEach(function (a, i) { a.classList.toggle('active', i === active); });
        links[active].scrollIntoView({ block: 'nearest' });
        return;
      }

      if (event.key === 'Enter') {
        // Only when something is selected. Otherwise the form submits to the
        // wiki index with `?q=`, which is the no-JavaScript path and a
        // perfectly good answer to "I pressed enter and nothing was chosen".
        if (active >= 0) { event.preventDefault(); links[active].click(); }
      }
    });

    document.addEventListener('click', function (event) {
      if (!form.contains(/** @type {Node} */ (event.target))) { panel.hidden = true; }
    });

    // Arriving from the no-JavaScript path: /wiki/?q=ntfy runs the search.
    var initial = new URLSearchParams(location.search).get('q');
    if (initial) { input.value = initial; run(); }
  });

  /*
   * `/` focuses the search box, as it does on GitHub and on every documentation
   * site people have already learned. Ignored while typing somewhere else,
   * which is what makes it safe to bind a bare printable character at all.
   */
  document.addEventListener('keydown', function (event) {
    if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
    var tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    var input = /** @type {HTMLInputElement} */ (
      document.querySelector('.wiki-side .search input, .search input')
    );
    if (!input) return;
    event.preventDefault();
    input.focus();
  });
})();
