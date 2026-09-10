// The release walk must never shoot a page that is still loading.
//
// The first release walk caught a "Loading…" placeholder in 6 of its 36 cells
// (#205): every per-route `setup()` waited on a single structural selector,
// which appears as soon as the shell renders, while the SWR fetches behind it
// were still in flight. A cell shot mid-load is not judgeable, so the walk
// gates every capture on a LOAD SETTLE: network quiet, then no "Loading…"
// placeholder left in the DOM.
//
// These are node --test unit tests against a fake Playwright page — the walk
// itself needs a real server + browser (`npm run walk`), which `npm test` has
// neither of. The fake records the DOM state AT THE MOMENT OF THE SHOT, so the
// assertion is the ticket's own words ("no capture shows Loading…") rather
// than the shape of the code under it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForLoadSettle, collectLoadingOffenders } from './e2e/walk.mjs';

/**
 * A Playwright `Page` stand-in. `settlesAfter` is how many DOM scans still
 * report a "Loading…" placeholder before the page finishes loading; the fake
 * tracks that as real state, so anything it hands back (a screenshot, a probe)
 * knows whether it happened mid-load.
 */
function fakePage({ settlesAfter = 1, networkIdle = true, tolerated = () => [] } = {}) {
  const page = {
    scans: 0,
    loading: true,
    shots: [],
    async waitForLoadState(state, opts) {
      page.loadStateWaits = [...(page.loadStateWaits ?? []), { state, opts }];
      if (!networkIdle) throw new Error(`Timeout ${opts?.timeout}ms exceeded waiting for ${state}`);
    },
    async evaluate() {
      page.scans++;
      page.loading = page.scans <= settlesAfter;
      return {
        blocking: page.loading ? [{ tag: 'div', class: 'muted small pad8', text: 'Loading…' }] : [],
        tolerated: tolerated(page.scans),
      };
    },
    async screenshot(opts) {
      page.shots.push({ path: opts?.path, loadingAtCapture: page.loading });
    },
  };
  return page;
}

test('waitForLoadSettle holds until the "Loading…" placeholders are gone', async () => {
  const page = fakePage({ settlesAfter: 3 });

  const settle = await waitForLoadSettle(page, { timeoutMs: 2_000, pollMs: 1 });

  assert.equal(page.loading, false, 'must not return while the page still reads "Loading…"');
  assert.equal(settle.settled, true);
  assert.equal(settle.networkIdle, true);
  assert.ok(page.scans >= 4, `expected repeated scans until settle, got ${page.scans}`);
});

test('waitForLoadSettle waits for network idle before scanning the DOM', async () => {
  const page = fakePage({ settlesAfter: 0 });

  await waitForLoadSettle(page, { timeoutMs: 2_000, pollMs: 1 });

  assert.deepEqual(
    page.loadStateWaits.map((w) => w.state),
    ['networkidle'],
  );
});

test('a page stuck loading fails loudly inside the timeout instead of hanging the walk', async () => {
  const page = fakePage({ settlesAfter: Infinity });
  const started = Date.now();

  await assert.rejects(
    () => waitForLoadSettle(page, { timeoutMs: 150, pollMs: 5 }),
    (err) => {
      assert.match(err.message, /150ms/, 'the error must name the budget it blew');
      assert.match(err.message, /Loading…/, 'the error must name what was still on screen');
      assert.match(err.message, /div\.muted\.small\.pad8/, 'the error must name the offending element');
      return true;
    },
  );

  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2_000, `must give up at the timeout, took ${elapsed}ms`);
});

test('a network that never goes idle is a disclosed note, not a failed capture', async () => {
  // A live session's SSE stream (or a polling surface) can hold a request open
  // for the whole walk: `networkidle` would never fire there, and refusing to
  // shoot those routes would lose cells the walk exists to judge. The DOM
  // placeholder scan is the authority; network idle is best-effort.
  const page = fakePage({ settlesAfter: 1, networkIdle: false });
  const notes = [];

  const settle = await waitForLoadSettle(page, { timeoutMs: 2_000, pollMs: 1, notes });

  assert.equal(settle.settled, true);
  assert.equal(settle.networkIdle, false);
  assert.equal(page.loading, false, 'the DOM scan still has to settle');
  assert.equal(notes.length, 1);
  assert.match(notes[0], /network/i);
});

// ---- The DOM scan itself (runs in the browser under the real walk) ----------

/** Minimal stand-in for the handful of DOM reads collectLoadingOffenders makes. */
function fakeDocument(elements) {
  return {
    querySelectorAll: () => elements.map((el) => ({
      tagName: el.tag ?? 'DIV',
      className: el.class ?? '',
      textContent: el.text ?? '',
      children: el.children ?? [],
      closest: (sel) => ((el.inside ?? []).includes(sel) ? { tagName: 'DIV' } : null),
    })),
  };
}

function scan(elements, options = {}) {
  const real = globalThis.document;
  globalThis.document = fakeDocument(elements);
  try {
    return collectLoadingOffenders({ allowSelectors: [], ...options });
  } finally {
    globalThis.document = real;
  }
}

test('collectLoadingOffenders finds the placeholder, not the page around it', () => {
  const result = scan([
    { class: 'page center muted', text: 'Loading…', children: [{}] },
    { class: 'muted small pad8', text: 'Loading…' },
    { class: 'card', text: '$9,421 month to date' },
  ]);

  assert.equal(result.blocking.length, 1, 'only the leaf that renders the text counts');
  assert.equal(result.blocking[0].class, 'muted small pad8');
  assert.deepEqual(result.tolerated, []);
});

test('collectLoadingOffenders tolerates a placeholder inside an allowed region', () => {
  // The Plan windows card is an external api.anthropic.com read (opt-out, slow
  // and outside Chronicle's control): the walk discloses it still loading
  // rather than failing the cell. Everything else is Chronicle's own fetch and
  // must settle.
  const result = scan(
    [
      { class: 'muted small pad8', text: 'Loading…', inside: ['.spend-tab .plan-windows'] },
      { class: 'muted pad8', text: 'Loading…' },
    ],
    { allowSelectors: ['.spend-tab .plan-windows'] },
  );

  assert.deepEqual(result.blocking.map((o) => o.class), ['muted pad8']);
  assert.deepEqual(result.tolerated.map((o) => o.class), ['muted small pad8']);
});
