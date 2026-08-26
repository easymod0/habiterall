/**
 * The figures the category comparison actually DRAWS — issue #65, phase 3.
 *
 * `computeCategoryStats` is pinned by `shared/test/stats.test.js` and both
 * editions' API suites pin the route that calls it. Neither can see the step
 * this suite exists for: **pinning the DECISION is not pinning the WIRING.**
 * The numbers are computed on the server and every one of them has to travel
 * through `ui/categories.js` into a card — so every check below reads the
 * rendered DOM and compares it against the payload the same page fetched, and
 * the two structural claims that no payload can make (the view links to no
 * habit; the chart's last point agrees with the number printed over it) are
 * read off the drawn SVG.
 *
 * The fixture spread is `seedCategorySpread` in `fixtures.mjs`: a two-member
 * category, a one-member one, an empty one, one whose only member has never
 * been logged, an archived member, and Uncategorised. Each is a branch in
 * `sectionCard`, and four of them draw a sentence rather than a percentage.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeChrome, devtoolsPort, devtoolsUrl, launchChrome, waitUntil } from './chrome.mjs';
import { SPREAD_ARCHIVED_HABIT, seedCategorySpread } from './fixtures.mjs';

const APP = process.env.BASE ?? 'http://localhost:3000';
const PORT = devtoolsPort(9326);
const profile = mkdtempSync(join(tmpdir(), 'habcompare-'));
const chrome = launchChrome(PORT, profile);

let fails = 0;
const ck = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' :: ' + extra : ''}`);
  if (!cond) fails++;
};

let ws, nid = 1;
const pend = new Map();
const send = (m, p = {}, s) => new Promise((res, rej) => {
  const id = nid++; pend.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method: m, params: p, sessionId: s }));
});

/** The whole-number percentage every strength in the app is written as. */
const pct = (v) => `${Math.round(v * 100)}%`;

/**
 * `scoreChart`'s geometry, restated here so the drawn line can be read back as
 * a value.
 *
 * Restated rather than imported: `charts.js` is a browser module served over
 * `/shared/`, and the point of this check is to invert what the browser
 * actually painted. Height is `ui/categories.js`'s own 140; the padding is
 * `scoreChart`'s. If either moves, this fails loudly rather than quietly, which
 * is the right way round for a constant copied on purpose.
 */
const CHART_HEIGHT = 140;
const CHART_PAD_TOP = 12;
const CHART_PLOT_HEIGHT = CHART_HEIGHT - CHART_PAD_TOP - 24;

try {
  // Seeded before the browser is pointed at the app: the top-bar button is
  // shown only for an account that HAS a category, and `dashboard.paint()` is
  // what decides that from the categories the boot fetched.
  const spread = await seedCategorySpread({ base: APP });

  const url = await devtoolsUrl(PORT, chrome);
  ws = new globalThis.WebSocket(url);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) {
      const { res, rej } = pend.get(m.id); pend.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  };
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  const ev = async (e) => {
    const r = await send('Runtime.evaluate',
      { expression: e, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
    return r.result.value;
  };

  await send('Page.navigate', { url: APP }, sessionId);
  // 'Meditate' by name, not "the grid has a row": a bare row predicate is
  // satisfied by whatever a previous navigation left behind — see the note on
  // the same wait in `categorycheck.mjs`.
  await waitUntil(ev,
    `[...document.querySelectorAll('#grid .habit-row .habit-name')]
       .some(n => n.textContent.trim() === 'Meditate')`,
    { what: 'the dashboard to load' });

  /* ---------- the entry point ---------- */

  const button = await ev(`(() => {
    const b = document.getElementById('btn-compare');
    return { hidden: b.hidden, visible: !!b.offsetParent, label: b.getAttribute('aria-label') };
  })()`);
  ck('the Compare button is on the top bar once the account has a category',
    button.hidden === false && button.visible === true, JSON.stringify(button));

  /* ---------- open it ---------- */

  // The payload this page is about to draw, fetched from the page's own
  // session so it is this account's. Read BEFORE the click, so a view that
  // renders nothing at all cannot make the comparison below vacuous.
  const data = await ev(
    `fetch('/api/categories/stats?granularity=week').then(r => r.json())`);
  ck('the route answers with every category plus Uncategorised',
    data.categories.length === 5, `${data.categories.length} sections`);

  await ev(`document.getElementById('btn-compare').click()`);

  /**
   * **The view unhidden AND a card laid out**, not a card count on its own.
   *
   * `render()` unhides the container before `replaceChildren()` empties it, so
   * a previous render's cards survive in it — and a poll that merely counts
   * `.compare-card` matches those stale nodes and returns before this render
   * has laid anything out, which is how a measurement of a zero-width page
   * gets taken. Requiring a real box on the first card is what makes the wait
   * about THIS render.
   */
  const READY = `(() => {
    const view = document.getElementById('view-categories');
    if (!view || view.hidden) return false;
    const cards = [...view.querySelectorAll('.compare-card')];
    if (cards.length !== ${data.categories.length}) return false;
    if (cards.at(-1).querySelector('.card-title').textContent.trim() !== 'Uncategorised') {
      return false;
    }
    return cards[0].getBoundingClientRect().width > 0;
  })()`;
  await waitUntil(ev, READY, { what: 'the comparison to render' });

  const where = await ev(`(() => ({
    hash: location.hash,
    list: !document.getElementById('view-list').hidden,
    detail: !document.getElementById('view-detail').hidden,
    compare: !document.getElementById('view-categories').hidden,
  }))()`);
  ck('the button opens the comparison and nothing else',
    where.compare && !where.list && !where.detail, JSON.stringify(where));
  ck('and the URL names it', where.hash === '#/categories', where.hash);

  /* ---------- what each card says ---------- */

  const drawn = await ev(`(() => {
    const view = document.getElementById('view-categories');
    const lineOf = (c) =>
      [...c.querySelectorAll('svg path')].find(p => p.getAttribute('fill') === 'none');
    return {
      sub: view.querySelector('.habit-sub').textContent,
      // Best and worst are NAMED and link nowhere, which is half of what keeps
      // the single ourEntry boolean in ui/routes.js honest — see the comment
      // in ui/categories.js. Counted over the whole view, so a link added
      // anywhere in it trips this.
      links: view.querySelectorAll('a, [href]').length,
      cards: [...view.querySelectorAll('.compare-card')].map((c) => {
        const line = lineOf(c);
        const d = line?.getAttribute('d') ?? '';
        const segments = d ? d.trim().split(' ') : [];
        const last = segments.length
          ? segments[segments.length - 1].slice(1).split(',').map(Number)
          : null;
        const spread = [...c.querySelectorAll('.compare-member')].map((m) => ({
          label: m.querySelector('.compare-member-label').textContent,
          name: m.querySelector('.compare-member-name').textContent,
          score: m.querySelector('.compare-member-score').textContent,
        }));
        return {
          title: c.querySelector('.card-title').textContent.trim(),
          mean: c.querySelector('.compare-mean').textContent,
          notes: [...c.querySelectorAll('.compare-note')].map(n => n.textContent),
          spread,
          hasChart: !!line,
          points: segments.length,
          lastY: last ? last[1] : null,
          stroke: line?.getAttribute('stroke') ?? null,
          width: Math.round(c.getBoundingClientRect().width),
        };
      }),
    };
  })()`);

  ck('one card per section, in the order the server sent them',
    drawn.cards.length === data.categories.length
    && drawn.cards.every((c, i) =>
      c.title === (data.categories[i].name ?? 'Uncategorised')),
    JSON.stringify(drawn.cards.map(c => c.title)));

  ck('Uncategorised is drawn last and is named by the view, not the server',
    drawn.cards.at(-1).title === 'Uncategorised'
    && data.categories.at(-1).id === null && data.categories.at(-1).name === null,
    JSON.stringify(data.categories.at(-1).name));

  ck('the comparison links to no habit',
    drawn.links === 0, `${drawn.links} link(s)`);

  /* ---------- the mean of every section reached its card ---------- */

  for (const [i, section] of data.categories.entries()) {
    const card = drawn.cards[i];
    const name = section.name ?? 'Uncategorised';
    const expected = section.mean === null ? '—' : pct(section.mean);
    ck(`${name}: the mean on the card is the mean the server computed`,
      card.mean === expected, `drew ${card.mean}, server said ${expected}`);
  }

  /* ---------- and so did the spread, the counts and the recovery rate ---------- */

  const bodyMind = drawn.cards[0];
  const bodySection = data.categories[0];
  ck('a two-member category names both ends of its spread',
    bodyMind.spread.length === 2
    && bodyMind.spread[0].name === bodySection.best.name
    && bodyMind.spread[0].score === pct(bodySection.best.score)
    && bodyMind.spread[1].name === bodySection.worst.name
    && bodyMind.spread[1].score === pct(bodySection.worst.score),
    JSON.stringify(bodyMind.spread));
  ck('and says how many habits the mean is over',
    bodyMind.notes[0] === `over ${bodySection.members} habits`,
    JSON.stringify(bodyMind.notes[0]));
  // The archived member is in the category and in none of its figures. Both
  // halves, because a route that had never heard of `archived` would still
  // pass the first on its own.
  ck('the archived member is excluded from the count it would otherwise be in',
    bodySection.members === 2
    && !bodyMind.spread.some((m) => m.name === SPREAD_ARCHIVED_HABIT),
    `members=${bodySection.members}, spread=${JSON.stringify(bodyMind.spread)}`);
  ck('and the view says so, with the number the server counted',
    drawn.sub.includes(`${data.archivedExcluded} archived habit left out.`)
    && data.archivedExcluded === 1,
    `archivedExcluded=${data.archivedExcluded} :: ${drawn.sub}`);
  ck('the recovery rate is drawn as a percentage of lapses',
    bodyMind.notes.at(-1) === `Recovers from ${pct(bodySection.recoveryRate)} of lapses`,
    JSON.stringify(bodyMind.notes.at(-1)));

  /* ---------- a single-member category ---------- */

  const readingCard = drawn.cards[1];
  const readingSection = data.categories[1];
  ck('a one-member category names the same habit as best and as weakest',
    readingCard.spread.length === 2
    && readingCard.spread[0].name === 'Read'
    && readingCard.spread[1].name === 'Read'
    && readingCard.spread[0].score === readingCard.spread[1].score,
    JSON.stringify(readingCard.spread));

  /* ---------- the two ways a mean can be absent are two sentences ---------- */

  const dormant = drawn.cards[2];
  ck('an empty category says it has no habits, and charts nothing',
    dormant.mean === '—'
    && dormant.notes.includes('No habits in this category yet.')
    && dormant.notes.includes('Nothing to chart.')
    && dormant.hasChart === false,
    JSON.stringify(dormant.notes));
  // An empty category gets no recovery line at all — 'No recovered lapses to
  // rate.' says the same nothing the figure above it has already said.
  ck('and it is not also told it has no lapses to rate',
    !dormant.notes.includes('No recovered lapses to rate.'),
    JSON.stringify(dormant.notes));

  const started = drawn.cards[3];
  ck('a category whose only member has never been logged says THAT instead',
    started.mean === '—'
    && started.notes.includes('1 habit, never logged — no strength to average.')
    && started.hasChart === false,
    JSON.stringify(started.notes));
  ck('and it counts that member rather than dropping it',
    data.categories[3].members === 1 && data.categories[3].unloggedExcluded === 1,
    `members=${data.categories[3].members}, `
    + `unloggedExcluded=${data.categories[3].unloggedExcluded}`);

  /* ---------- the chart ---------- */

  // 60 days of fixtures inside a 366-day window: a member joins the line when
  // its first entry lands, so most of the axis is deliberately empty and the
  // drawn line is the tail of it. Asserting the count against the payload's
  // non-null buckets is what catches a view that plots the nulls as zero —
  // which is not merely ugly: a null reaches `scoreChart`'s arithmetic and
  // every coordinate after it is NaN.
  for (const [i, section] of data.categories.entries()) {
    if (section.mean === null) continue;
    const card = drawn.cards[i];
    const landed = section.series.filter(p => p.value !== null).length;
    ck(`${section.name ?? 'Uncategorised'}: the line holds one point per bucket that has landed`,
      card.hasChart && card.points === landed && landed < data.buckets.length,
      `${card.points} points, ${landed} landed, ${data.buckets.length} buckets`);

    // A chart whose final point disagrees with the number printed over it
    // reads as a bug whichever of the two is right — so BOTH sides of this one
    // come off the page: the y of the last vertex of the drawn path, against
    // the text of `.compare-mean`. Comparing the line to the PAYLOAD instead
    // would leave the printed figure free to be anything at all, which is the
    // half a mutation of `sectionCard` actually moves. Half a point of
    // tolerance because the printed number is rounded and the line is not.
    const value = (CHART_PAD_TOP + CHART_PLOT_HEIGHT - card.lastY) / CHART_PLOT_HEIGHT;
    ck(`${section.name ?? 'Uncategorised'}: the line ends where the printed mean says it does`,
      Math.abs(value * 100 - Number.parseInt(card.mean, 10)) < 0.6,
      `line ends at ${(value * 100).toFixed(2)}%, card says ${card.mean}`);
  }

  // **A chart NAMES a theme colour and never resolves one.** Uncategorised has
  // no colour of its own, so its line is a `var()` reference CSS resolves on
  // every paint; a value read out with `getComputedStyle` at draw time would
  // freeze the palette the chart was drawn under.
  ck('a category draws its own colour and Uncategorised names a theme variable',
    drawn.cards[0].stroke === spread.wellbeing.color
    && drawn.cards.at(-1).stroke === 'var(--text-dim)',
    `${drawn.cards[0].stroke} / ${drawn.cards.at(-1).stroke}`);

  /* ---------- and it agrees with the habit's own page ---------- */

  // **Two surfaces, one habit, one number.** A one-member category's mean IS
  // that habit's strength, so the percentage on this card and the Strength
  // tile on the habit's own page are the same figure computed by two different
  // routes and drawn by two different modules — and two surfaces disagreeing
  // about one habit is indistinguishable from one of them being broken.
  //
  // 'Read' is daily on purpose: `onPaceSeries` pro-rates the requirement over
  // the first `denominator - 1` days, so a non-daily member legitimately
  // differs between two windows that start on different days.
  //
  // What this does NOT reach is `SCORE_WARMUP_DAYS`. The view sends no `start`
  // and the route then opens `COMPARE_WINDOW_DAYS` — a year, which is ~28
  // half-lives of the score's EWMA, so a comparison that started cold at the
  // window's edge has re-converged to the same value long before `end`. The
  // warm-up only moves a figure for a caller that asks for a SHORT window, and
  // this view has no control that can (measured: with the warm-up removed, a
  // `?start=` 20 days back reported 55% against the habit page's 78%, while
  // the view's own year-long request reported 78% either way). It is the API
  // suites that pin it, and they must keep doing so.
  const meanOnCard = readingCard.mean;
  await ev(`(() => {
    const row = [...document.querySelectorAll('#grid .habit-row')]
      .find(r => r.querySelector('.habit-name').textContent.trim() === 'Read');
    row.querySelector('.habit-meta').click();
  })()`);
  await waitUntil(ev,
    `document.querySelector('#view-detail h2')?.textContent.trim() === 'Read'
       && !!document.querySelector('#view-detail .stat-tile')`,
    { what: "Read's own page" });

  const ownStrength = await ev(`(() => {
    const tile = [...document.querySelectorAll('#view-detail .stat-tile')]
      .find(t => t.querySelector('.stat-label').textContent === 'Strength');
    return tile.querySelector('.stat-value').textContent;
  })()`);
  ck("a one-member category reads the same strength the habit's own page does",
    ownStrength === meanOnCard, `page says ${ownStrength}, card said ${meanOnCard}`);

  /* ---------- the button goes away while a habit is open ---------- */

  const whileOpen = await ev(`document.getElementById('btn-compare').hidden`);
  ck('the Compare button is hidden while a habit is open', whileOpen === true,
    `hidden=${whileOpen}`);

  /* ---------- an all-archived category is not an empty one ---------- */

  // `archivedExcluded` used to be one account-wide number, so a category whose
  // only members are archived arrived with `members: 0` and was
  // indistinguishable from 'Dormant' above — and the card then said "No habits
  // in this category yet." about a category the user filled and later shelved.
  // Made here rather than seeded: 'Reading' is a one-member category the checks
  // above have already finished with, and archiving its member turns it into
  // exactly that shape without moving any card's position or the section count
  // every other assertion in this file (and `responsive.mjs`) indexes by.
  // Navigated rather than `history.back()`: the habit above was opened from the
  // COMPARISON's grid, so one Back lands on `#/categories` and the depth to
  // unwind is a thing this block would have to know. Aiming at the app with no
  // fragment reaches the dashboard whether the browser treats it as a reload or
  // as a same-document hash change.
  await send('Page.navigate', { url: APP }, sessionId);
  await waitUntil(ev,
    `location.hash === ''
       && !document.getElementById('view-list').hidden
       && document.getElementById('btn-compare').hidden === false
       && [...document.querySelectorAll('#grid .habit-row .habit-name')]
            .some(n => n.textContent.trim() === 'Meditate')`,
    { what: 'the dashboard, with its Compare button' });

  await ev(`(async () => {
    const habits = await (await fetch('/api/habits')).json();
    const read = habits.find(h => h.name === 'Read');
    // PUT REPLACES, so the whole fetched row goes back with the one field
    // changed — see shared/CLAUDE.md.
    await fetch('/api/habits/' + read.id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...read, archived: true }),
    });
  })()`);

  await ev(`document.getElementById('btn-compare').click()`);
  // The Reading card showing a DASH, not merely a card called Reading: the
  // previous render's nodes survive in the container until `replaceChildren()`
  // runs, and that card was showing a percentage — so this predicate is about
  // THIS render and cannot be satisfied by what is already on screen.
  await waitUntil(ev, `(() => {
    const c = [...document.querySelectorAll('#view-categories .compare-card')]
      .find(x => x.querySelector('.card-title').textContent.trim() === 'Reading');
    return !!c && c.querySelector('.compare-mean').textContent === '—';
  })()`, { what: 'the comparison, with Reading now empty of active habits' });

  const shelvedCard = await ev(`(() => {
    const cards = [...document.querySelectorAll('#view-categories .compare-card')];
    const c = cards.find(x =>
      x.querySelector('.card-title').textContent.trim() === 'Reading');
    return {
      mean: c.querySelector('.compare-mean').textContent,
      notes: [...c.querySelectorAll('.compare-note')].map(n => n.textContent),
      sub: document.querySelector('#view-categories .habit-sub').textContent,
    };
  })()`);
  const shelvedSection = await ev(
    `fetch('/api/categories/stats?granularity=week').then(r => r.json())`
  ).then((d) => d.categories.find((c) => c.name === 'Reading'));

  ck('a category whose habits are all archived reports its own archived count',
    shelvedSection?.members === 0 && shelvedSection?.archivedExcluded === 1,
    JSON.stringify({ members: shelvedSection?.members,
                     archivedExcluded: shelvedSection?.archivedExcluded }));
  ck('...and the card says THAT rather than claiming nobody has filled it',
    shelvedCard.mean === '—'
    && shelvedCard.notes.includes('1 archived habit, nothing active to average.')
    && !shelvedCard.notes.includes('No habits in this category yet.'),
    JSON.stringify(shelvedCard.notes));
  // The account-wide total is still the header's, and it moved by one — so the
  // per-section count is an addition rather than a rename of the same number.
  ck('and the header still reports the account-wide total, now two',
    shelvedCard.sub.includes('2 archived habits left out.'),
    JSON.stringify(shelvedCard.sub));

  console.log(fails === 0 ? '\nALL COMPARISON CHECKS PASSED' : `\n${fails} FAILED`);
} catch (e) {
  console.error('ERR', e.message); fails++;
} finally {
  await closeChrome({ chrome, port: PORT, profile });
  process.exit(fails ? 1 : 0);
}
