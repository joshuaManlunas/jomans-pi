import { test, expect } from 'bun:test';
import { PolishSession } from '../scripts/session.mjs';

function setup(complete = async () => 'improved') {
  let draft = 'original';
  const notices = [], saves = [], copies = [];
  const session = new PolishSession({
    readDraft: () => draft,
    writeDraft: text => { draft = text; },
    saveHistory: entries => { saves.push(entries); },
    notify: (message, type) => notices.push({ message, type }),
    complete,
    writeClipboard: async text => { copies.push(text); },
  });
  return { session, notices, saves, copies, get draft() { return draft; }, set draft(value) { draft = value; } };
}

test('successful polish saves and applies without submission; preview and copy are exact', async () => {
  const h = setup(async () => 'first\n\n  second');
  expect(await h.session.polish({})).toBe('first\n\n  second');
  expect(h.draft).toBe('first\n\n  second');
  expect(h.saves[0][0]).toMatchObject({ original: 'original', improved: h.draft });
  expect(h.session.running).toBe(false);
  expect(h.session.preview()).toBe(h.draft);
  expect(h.session.expanded).toBe(true);
  expect(await h.session.copy()).toBe(true);
  expect(h.copies).toEqual([h.draft]);
  h.session.preview();
  expect(h.session.expanded).toBe(false);
  h.session.submit();
  expect(h.session.controlsVisible).toBe(false);
  expect(h.session.history).toHaveLength(1);
});

test('empty and concurrent requests never start another completion', async () => {
  let finish, calls = 0;
  const h = setup(() => { calls++; return new Promise(resolve => { finish = resolve; }); });
  h.draft = '  ';
  await h.session.polish({});
  expect(calls).toBe(0);
  h.draft = 'original';
  const pending = h.session.polish({});
  await h.session.polish({});
  expect(calls).toBe(1);
  finish('improved');
  await pending;
  expect(h.notices.map(n => n.message)).toContain('Prompt improvement already running');
});

test('concurrent editor changes are preserved while result goes to history', async () => {
  let finish;
  const h = setup(() => new Promise(resolve => { finish = resolve; }));
  const pending = h.session.polish({});
  h.draft = 'new draft';
  finish('improved');
  await pending;
  expect(h.draft).toBe('new draft');
  expect(h.session.history[0].improved).toBe('improved');
  expect(h.notices.at(-1).type).toBe('warning');
});

test('submission during completion does not reopen controls', async () => {
  let finish;
  const h = setup(() => new Promise(resolve => { finish = resolve; }));
  const pending = h.session.polish({});
  h.session.submit();
  finish('improved');
  await pending;
  expect(h.session.controlsVisible).toBe(false);
  expect(h.session.history).toHaveLength(1);
});

test('session changes abort and discard late results without disturbing a new request', async () => {
  const finishes = [], signals = [];
  const h = setup((_original, ctx) => { signals.push(ctx.signal); return new Promise(resolve => finishes.push(resolve)); });
  const old = h.session.polish({});
  h.session.start();
  expect(signals[0].aborted).toBe(true);
  const fresh = h.session.polish({});
  finishes[0]('stale');
  expect(await old).toBeUndefined();
  expect(h.session.running).toBe(true);
  finishes[1]('fresh');
  await fresh;
  expect(h.draft).toBe('fresh');
  expect(h.session.history.map(i => i.improved)).toEqual(['fresh']);
});

test('history replay filters malformed entries, deduplicates, limits to 20, and restores without reorder', () => {
  const h = setup();
  const entries = Array.from({ length: 25 }, (_, timestamp) => ({ original: String(timestamp), improved: `prompt ${timestamp}`, timestamp }));
  entries.push(null, {}, { original: 'x', improved: ' ' }, { original: 'newest', improved: 'prompt 20', timestamp: 99 });
  h.session.start(entries);
  expect(h.draft).toBe('original');
  expect(h.session.history).toHaveLength(20);
  expect(h.session.polished).toBe('prompt 20');
  expect(h.session.history[0].original).toBe('newest');
  const before = JSON.stringify(h.session.history);
  expect(h.session.restore(1)).toBe('prompt 24');
  expect(h.draft).toBe('prompt 24');
  expect(JSON.stringify(h.session.history)).toBe(before);
  expect(h.session.restore(99)).toBeUndefined();
  h.session.stop();
  expect(h.session.history).toEqual([]);
  expect(h.session.polished).toBeUndefined();
});

test('persistence failure warns once and retains memory history', async () => {
  const h = setup();
  h.session.saveHistory = () => { throw new Error('unavailable'); };
  await h.session.polish({});
  await h.session.polish({});
  expect(h.session.history).toHaveLength(1);
  expect(h.notices.filter(n => n.message.includes('memory-only'))).toHaveLength(1);
});

test('failure and cancelled work leave the draft and previous result unchanged', async () => {
  const h = setup();
  await h.session.polish({});
  h.draft = 'next';
  h.session.complete = async () => { throw new Error('controlled failure'); };
  expect(await h.session.polish({})).toBeUndefined();
  expect(h.draft).toBe('next');
  expect(h.session.polished).toBe('improved');
  expect(h.session.running).toBe(false);
});

test('copy failure preserves expanded preview and draft; empty state is graceful', async () => {
  const h = setup();
  expect(h.session.preview()).toBeUndefined();
  expect(await h.session.copy()).toBe(false);
  await h.session.polish({});
  h.session.preview();
  h.session.writeClipboard = async () => { throw new Error('denied'); };
  expect(await h.session.copy()).toBe(false);
  expect(h.session.expanded).toBe(true);
  expect(h.draft).toBe('improved');
});
