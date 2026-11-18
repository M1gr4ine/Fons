import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import * as store from '../scripts/fons-store.mjs';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const storeUrl = new URL('../scripts/fons-store.mjs', import.meta.url).href;

function fixture(t, sessionId = A) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fons-store-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  return { rootDir, sessionId };
}

function paths(ctx) {
  return store.sessionPaths(ctx);
}

function put(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

function state(ctx, value) {
  put(paths(ctx).state, JSON.stringify(value));
}

function snapshot(ctx) {
  return store.readPoolSnapshot({ ...ctx, debounceMs: 60000, now: Date.now() });
}

function item(ctx, text) {
  const found = snapshot(ctx).items.find((row) => row.text === text);
  assert.ok(found, `missing item: ${text}`);
  return found;
}

function mutation(ctx, row) {
  return { ...ctx, rowIndex: row.rowIndex, expectedRaw: row.raw };
}

function id(text) {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);
}

function child(script, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--input-type=module', '-e', script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (part) => { stderr += part; });
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ code, stderr }));
  });
}

test('paths reject traversal and Windows device names and isolate sessions', (t) => {
  const ctx = fixture(t);
  for (const sessionId of ['../escape', 'CON', '', 'not-a-uuid']) {
    assert.throws(() => paths({ ...ctx, sessionId }));
  }
  const a = paths(ctx);
  const b = paths({ ...ctx, sessionId: B });
  assert.equal(a.ideas, path.join(ctx.rootDir, '.agents', 'fons', `ideas-${A}.md`));
  assert.equal(a.archive, path.join(ctx.rootDir, '.agents', 'fons', 'archive', `${A}.md`));
  assert.notEqual(a.ideas, b.ideas);
  assert.notEqual(a.state, b.state);
  assert.notEqual(a.ui, b.ui);
});

test('registration resolves from the selected app data without overwriting an existing pointer', (t) => {
  const ctx = fixture(t);
  const appData = path.join(ctx.rootDir, 'host-data');
  assert.equal(store.lookupConversation({ appData, sessionId: A }), null);
  store.registerConversation({ appData, sessionId: A, rootDir: ctx.rootDir, title: 'first' });
  store.registerConversation({ appData, sessionId: A, rootDir: 'other', title: 'second' });
  const record = store.lookupConversation({ appData, sessionId: A });
  assert.equal(record.rootDir, ctx.rootDir);
  assert.equal(record.title, 'first');
  assert.equal(store.lookupConversation({ appData, sessionId: B }), null);
  assert.throws(() => store.lookupConversation({ appData, sessionId: '../x' }));
});

test('add normalizes text, preserves CRLF and does not alter other sessions', (t) => {
  const ctx = fixture(t);
  put(paths(ctx).ideas, '# ideas\r\n- [ ] existing');
  store.addIdeas({ ...ctx, texts: ['- [ ] alpha\nbeta', '  ', 'second'] });
  assert.equal(fs.readFileSync(paths(ctx).ideas, 'utf8'), '# ideas\r\n- [ ] existing\r\n- [ ] alpha beta\r\n- [ ] second\r\n');
  assert.deepEqual(snapshot(ctx).items.map((row) => row.text), ['existing', 'alpha beta', 'second']);
  assert.deepEqual(snapshot({ ...ctx, sessionId: B }).items, []);
});

test('receipt selects the exact occurrence and CAS folds receipts without changing remaining delivery ids', (t) => {
  const ctx = fixture(t);
  put(paths(ctx).ideas, '- [ ] first\r\n- [ ] same\r\n- [ ] same\r\n');
  const target = item(ctx, 'same');
  store.completeIdea({ ...ctx, token: target.token });
  const before = snapshot(ctx);
  assert.equal(before.items.filter((row) => row.text === 'same' && row.status === 'done').length, 1);
  const pendingBefore = before.items.find((row) => row.text === 'same' && row.status !== 'done');
  assert.ok(pendingBefore);
  const first = item(ctx, 'first');
  store.updateIdeaText({ ...mutation(ctx, first), newText: 'edited' });
  const after = snapshot(ctx);
  const pendingAfter = after.items.find((row) => row.text === 'same' && row.status !== 'done');
  assert.equal(pendingAfter.id, pendingBefore.id);
  assert.equal(after.items.filter((row) => row.text === 'same' && row.status === 'done').length, 1);
  const content = fs.readFileSync(paths(ctx).ideas, 'utf8');
  assert.match(content, /【√】 same\r\n/);
  assert.doesNotMatch(content, /fons-ack:/);
  assert.doesNotMatch(content, /(?<!\r)\n/);
});

test('stale CAS rejects edits and deletions without changing the file', (t) => {
  const ctx = fixture(t);
  store.addIdeas({ ...ctx, texts: ['original'] });
  const stale = item(ctx, 'original');
  put(paths(ctx).ideas, '- [ ] changed\n');
  assert.equal(store.updateIdeaText({ ...mutation(ctx, stale), newText: 'replacement' }).conflict, true);
  assert.equal(store.removeIdea(mutation(ctx, stale)).conflict, true);
  assert.equal(fs.readFileSync(paths(ctx).ideas, 'utf8'), '- [ ] changed\n');
});

test('reopening a receipt completion returns it to buffering', (t) => {
  const ctx = fixture(t);
  store.addIdeas({ ...ctx, texts: ['one'] });
  store.completeIdea({ ...ctx, token: item(ctx, 'one').token });
  const done = item(ctx, 'one');
  assert.equal(done.status, 'done');
  store.reopenIdea(mutation(ctx, done));
  assert.equal(item(ctx, 'one').status, 'buffering');
  assert.doesNotMatch(fs.readFileSync(paths(ctx).ideas, 'utf8'), /fons-ack:/);
});

test('readonly acknowledgments support legacy true and reopening without rewriting ideas', (t) => {
  const ctx = fixture(t);
  store.addIdeas({ ...ctx, texts: ['legacy', 'recent'] });
  const legacy = item(ctx, 'legacy');
  const recent = item(ctx, 'recent');
  state(ctx, { acknowledged: { [legacy.id]: true, [recent.id]: { at: 1234 } } });
  assert.equal(item(ctx, 'legacy').status, 'done');
  assert.equal(item(ctx, 'recent').doneSource, 'readonly_ack');
  const before = fs.readFileSync(paths(ctx).ideas, 'utf8');
  store.reopenIdea(mutation(ctx, item(ctx, 'legacy')));
  store.reopenIdea(mutation(ctx, item(ctx, 'recent')));
  assert.equal(fs.readFileSync(paths(ctx).ideas, 'utf8'), before);
  assert.notEqual(item(ctx, 'legacy').status, 'done');
  assert.notEqual(item(ctx, 'recent').status, 'done');
});

test('removing a delivered item records its retraction without changing the hook ledger', (t) => {
  const ctx = fixture(t);
  store.addIdeas({ ...ctx, texts: ['delivered', 'draft'] });
  const delivered = item(ctx, 'delivered');
  state(ctx, { delivered: { [delivered.id]: { at: 1 } } });
  const ledger = fs.readFileSync(paths(ctx).state, 'utf8');
  assert.equal(item(ctx, 'delivered').status, 'delivered');
  store.removeIdea(mutation(ctx, item(ctx, 'delivered')));
  const ui = JSON.parse(fs.readFileSync(paths(ctx).ui, 'utf8'));
  assert.equal(ui.retracted[delivered.id].text, 'delivered');
  assert.equal(fs.readFileSync(paths(ctx).state, 'utf8'), ledger);
  assert.deepEqual(snapshot(ctx).items.map((row) => row.text), ['draft']);
});

test('flush and leftover temporary JSON files do not damage the ledger or snapshot', (t) => {
  const ctx = fixture(t);
  store.addIdeas({ ...ctx, texts: ['draft'] });
  const current = item(ctx, 'draft');
  state(ctx, { delivered: { [current.id]: { at: 1 } } });
  put(`${paths(ctx).state}.tmp-9`, '{incomplete');
  put(`${paths(ctx).ui}.tmp-9`, '{incomplete');
  store.requestFlush(ctx);
  assert.equal(item(ctx, 'draft').status, 'delivered');
  assert.ok(JSON.parse(fs.readFileSync(paths(ctx).ui, 'utf8')).flushRequestedAt > 0);
  assert.ok(JSON.parse(fs.readFileSync(paths(ctx).state, 'utf8')).delivered[current.id]);
});

test('archive keeps the remaining duplicate id stable and deletes a fully completed inbox', (t) => {
  const ctx = fixture(t);
  put(paths(ctx).ideas, '【√】 repeat\r\n- [ ] repeat\r\n');
  const before = snapshot(ctx).items.find((row) => row.text === 'repeat' && row.status !== 'done').id;
  assert.equal(snapshot(ctx).canArchive, true);
  store.archiveCompleted(ctx);
  assert.equal(item(ctx, 'repeat').id, before);
  assert.match(fs.readFileSync(paths(ctx).archive, 'utf8'), /repeat/);
  store.completeIdea({ ...ctx, token: item(ctx, 'repeat').token });
  store.archiveCompleted(ctx);
  assert.equal(fs.existsSync(paths(ctx).ideas), false);
});

test('archive includes readonly acknowledgments', (t) => {
  const ctx = fixture(t);
  store.addIdeas({ ...ctx, texts: ['readonly'] });
  const entry = item(ctx, 'readonly');
  state(ctx, { acknowledged: { [entry.id]: { at: 1 } } });
  store.archiveCompleted(ctx);
  assert.equal(fs.existsSync(paths(ctx).ideas), false);
  assert.match(fs.readFileSync(paths(ctx).archive, 'utf8'), /readonly/);
});

test('two processes migrate once and route delivered and unclaimed legacy rows correctly', async (t) => {
  const ctx = fixture(t);
  const dir = path.join(ctx.rootDir, '.agents', 'fons');
  put(path.join(dir, 'ideas.md'), '- [ ] for A\n- [ ] for B\n- [ ] unclaimed\n');
  put(path.join(dir, '.state.json'), JSON.stringify({
    [A]: { delivered: { [id('for A')]: { text: 'for A', deliveredAt: 1, ackToken: 'aaaaaaaaaaaaaaaa' } } },
    [B]: { delivered: { [id('for B')]: { text: 'for B', deliveredAt: 2, ackToken: 'bbbbbbbbbbbbbbbb' } } },
  }));
  put(path.join(dir, 'archive.md'), '【√】 old\n');
  const script = `import { migrateLegacyInbox } from ${JSON.stringify(storeUrl)}; migrateLegacyInbox({ rootDir: process.argv[1], sessionId: process.argv[2] });`;
  const outcomes = await Promise.all([child(script, [ctx.rootDir, A]), child(script, [ctx.rootDir, B])]);
  for (const result of outcomes) assert.equal(result.code, 0, result.stderr);
  const a = snapshot(ctx).items.map((row) => row.text);
  const b = snapshot({ ...ctx, sessionId: B }).items.map((row) => row.text);
  assert.ok(a.includes('for A'));
  assert.ok(b.includes('for B'));
  assert.equal(a.includes('for B'), false);
  assert.equal(b.includes('for A'), false);
  assert.equal(Number(a.includes('unclaimed')) + Number(b.includes('unclaimed')), 1);
  assert.equal(item(ctx, 'for A').status, 'delivered');
  assert.equal(item({ ...ctx, sessionId: B }, 'for B').status, 'delivered');
  assert.equal(fs.existsSync(path.join(dir, 'ideas.md')), false);
  assert.ok(fs.existsSync(path.join(dir, '.state.legacy.json')));
  assert.equal(fs.readFileSync(path.join(dir, 'archive', 'legacy.md'), 'utf8'), '【√】 old\n');
});

test('migration preserves a shared delivery in both sessions and sends an unclaimed item only to its trigger', (t) => {
  const ctx = fixture(t);
  const dir = path.join(ctx.rootDir, '.agents', 'fons');
  put(path.join(dir, 'ideas.md'), '- [ ] shared\n- [ ] unclaimed\n');
  put(path.join(dir, '.state.json'), JSON.stringify({
    [A]: { delivered: { [id('shared')]: { text: 'shared', deliveredAt: 1, ackToken: 'aaaaaaaaaaaaaaaa' } } },
    [B]: { delivered: { [id('shared')]: { text: 'shared', deliveredAt: 2, ackToken: 'bbbbbbbbbbbbbbbb' } } },
  }));
  store.migrateLegacyInbox(ctx);
  assert.equal(item(ctx, 'shared').status, 'delivered');
  assert.equal(item({ ...ctx, sessionId: B }, 'shared').status, 'delivered');
  assert.equal(item(ctx, 'unclaimed').status, 'buffering');
  assert.equal(snapshot({ ...ctx, sessionId: B }).items.some((row) => row.text === 'unclaimed'), false);
});

test('migration does not overwrite an existing session inbox or consume the legacy files', (t) => {
  const ctx = fixture(t);
  const dir = path.join(ctx.rootDir, '.agents', 'fons');
  const legacy = '- [ ] old\n';
  const ledger = JSON.stringify({ [A]: { delivered: { [id('old')]: { text: 'old', deliveredAt: 1, ackToken: 'aaaaaaaaaaaaaaaa' } } } });
  put(path.join(dir, 'ideas.md'), legacy);
  put(path.join(dir, '.state.json'), ledger);
  put(paths(ctx).ideas, '- [ ] new\n');
  assert.throws(() => store.migrateLegacyInbox(ctx), /目标会话已有数据/);
  assert.equal(fs.readFileSync(paths(ctx).ideas, 'utf8'), '- [ ] new\n');
  assert.equal(fs.readFileSync(path.join(dir, 'ideas.md'), 'utf8'), legacy);
  assert.equal(fs.readFileSync(path.join(dir, '.state.json'), 'utf8'), ledger);
});

test('migration keeps an active repeated text delivered despite old completion history', (t) => {
  const ctx = fixture(t);
  const dir = path.join(ctx.rootDir, '.agents', 'fons');
  const repeatId = id('repeat\0' + '2');
  put(path.join(dir, 'ideas.md'), '【√】 repeat\n- [ ] repeat\n');
  put(path.join(dir, 'archive.md'), '【√】 repeat\n');
  put(path.join(dir, '.state.json'), JSON.stringify({ [A]: { delivered: { [repeatId]: { text: 'repeat', deliveredAt: 1, ackToken: 'aaaaaaaaaaaaaaaa' } } } }));
  store.migrateLegacyInbox(ctx);
  assert.equal(snapshot(ctx).items.find((row) => row.text === 'repeat' && row.status !== 'done').status, 'delivered');
  assert.equal(fs.readFileSync(path.join(dir, 'archive', 'legacy.md'), 'utf8'), '【√】 repeat\n');
});



test('debounce tracks pending text changes but ignores delivered completion', (t) => {
  const ctx = fixture(t);
  store.addIdeas({ ...ctx, texts: ['sent', 'draft', 'another'] });
  const sent = item(ctx, 'sent');
  state(ctx, { delivered: { [sent.id]: { at: 1 } } });
  const data = store.readPoolData(ctx);
  const initial = store.computeDebounce({ ...data, mtimeMs: 1000, debounceMs: 60000, now: 11000 });
  const ledger = { ...data.state, pendingSig: initial.sig, pendingSigAt: initial.pendingSigAt };
  const unchanged = store.computeDebounce({ ...data, state: ledger, mtimeMs: 5000, debounceMs: 60000, now: 11000 });
  assert.equal(unchanged.debounceRemainingMs, 50000);
  store.completeIdea({ ...ctx, token: sent.token });
  const afterDone = store.computeDebounce({ ...store.readPoolData(ctx), state: ledger, mtimeMs: 5000, debounceMs: 60000, now: 11000 });
  assert.equal(afterDone.pendingSigAt, 1000);
  store.completeIdea({ ...ctx, token: item(ctx, 'draft').token });
  const afterDraftDone = store.computeDebounce({ ...store.readPoolData(ctx), state: ledger, mtimeMs: 9000, debounceMs: 60000, now: 11000 });
  assert.equal(afterDraftDone.pendingSigAt, 9000);
  assert.equal(afterDraftDone.debounceRemainingMs, 58000);
  store.addIdeas({ ...ctx, texts: ['new'] });
  const afterAdd = store.computeDebounce({ ...store.readPoolData(ctx), state: { ...ledger, pendingSig: afterDraftDone.sig, pendingSigAt: 9000 }, mtimeMs: 10000, debounceMs: 60000, now: 11000 });
  assert.equal(afterAdd.pendingSigAt, 10000);
  assert.equal(afterAdd.debounceRemainingMs, 59000);
  assert.equal(store.computeDebounce({ ...store.readPoolData(ctx), state: ledger, mtimeMs: 10000, debounceMs: 0, now: 11000 }).debounceRemainingMs, 0);
});

test('requestFlush makes the current pending draft immediately deliverable', (t) => {
  const ctx = fixture(t);
  store.addIdeas({ ...ctx, texts: ['draft'] });
  assert.ok(snapshot(ctx).debounceRemainingMs > 0);
  store.requestFlush(ctx);
  assert.equal(snapshot(ctx).flushPending, true);
  assert.equal(snapshot(ctx).debounceRemainingMs, 0);
});

test('deleting a preceding row preserves a later receipt and duplicate delivery id', (t) => {
  const ctx = fixture(t);
  store.addIdeas({ ...ctx, texts: ['remove', 'repeat', 'repeat'] });
  store.completeIdea({ ...ctx, token: item(ctx, 'repeat').token });
  const before = snapshot(ctx).items.find((row) => row.text === 'repeat' && row.status !== 'done').id;
  store.removeIdea(mutation(ctx, item(ctx, 'remove')));
  const after = snapshot(ctx).items;
  assert.equal(after.find((row) => row.text === 'repeat' && row.status !== 'done').id, before);
  assert.equal(after.filter((row) => row.text === 'repeat' && row.status === 'done').length, 1);
});

test('a competing write at the CAS check does not send a false retraction', (t) => {
  const ctx = fixture(t);
  store.addIdeas({ ...ctx, texts: ['sent'] });
  const sent = item(ctx, 'sent');
  state(ctx, { delivered: { [sent.id]: { at: 1 } } });
  const originalRead = fs.readFileSync;
  let ideaReads = 0;
  fs.readFileSync = function (file, ...args) {
    if (String(file) === paths(ctx).ideas && ++ideaReads === 2) {
      fs.writeFileSync(file, '- [ ] edited concurrently\n', 'utf8');
    }
    return originalRead.call(this, file, ...args);
  };
  let result;
  try { result = store.removeIdea(mutation(ctx, sent)); } finally { fs.readFileSync = originalRead; }
  assert.equal(result.conflict, true);
  assert.equal(fs.readFileSync(paths(ctx).ideas, 'utf8'), '- [ ] edited concurrently\n');
  assert.equal(fs.existsSync(paths(ctx).ui), false);
  assert.equal(fs.existsSync(paths(ctx).retractMarker), false);
});


test('migration refuses malformed legacy ledgers without consuming legacy data', (t) => {
  const invalidOwner = { 'not-a-uuid': { delivered: { [id('old')]: { text: 'old', deliveredAt: 1, ackToken: 'aaaaaaaaaaaaaaaa' } } } };
  const cases = [['{invalid', SyntaxError], [JSON.stringify(invalidOwner), /旧账本含无效会话 ID/]];
  for (const [ledger, expectedError] of cases) {
    const ctx = fixture(t);
    const dir = path.join(ctx.rootDir, '.agents', 'fons');
    put(path.join(dir, 'ideas.md'), '- [ ] old\n');
    put(path.join(dir, '.state.json'), ledger);
    assert.throws(() => store.migrateLegacyInbox(ctx), expectedError);
    assert.equal(fs.readFileSync(path.join(dir, 'ideas.md'), 'utf8'), '- [ ] old\n');
    assert.equal(fs.readFileSync(path.join(dir, '.state.json'), 'utf8'), ledger);
    assert.equal(fs.existsSync(paths(ctx).ideas), false);
  }
});

test('the exact token can complete the second duplicate without completing the first', (t) => {
  const ctx = fixture(t);
  store.addIdeas({ ...ctx, texts: ['repeat', 'repeat'] });
  const duplicates = snapshot(ctx).items.filter((row) => row.text === 'repeat');
  assert.equal(duplicates.length, 2);
  store.completeIdea({ ...ctx, token: duplicates[1].token });
  const after = snapshot(ctx).items.filter((row) => row.text === 'repeat');
  assert.notEqual(after[0].status, 'done');
  assert.equal(after[1].status, 'done');
});

test('zero debounce is immediate even when filesystem mtime is fractionally ahead', () => {
  const result = store.computeDebounce({
    items: [{ id: 'one', text: 'draft', status: 'buffering' }],
    state: {}, ui: {}, mtimeMs: 1000.75, debounceMs: 0, now: 1000,
  });
  assert.equal(result.debounceRemainingMs, 0);
});


test('migration rolls back partial publication and can be retried after an I/O failure', (t) => {
  const ctx = fixture(t);
  const dir = path.join(ctx.rootDir, '.agents', 'fons');
  const ledger = JSON.stringify({ [A]: { delivered: { [id('old')]: { text: 'old', deliveredAt: 1, ackToken: 'aaaaaaaaaaaaaaaa' } } } });
  put(path.join(dir, 'ideas.md'), '- [ ] old\n');
  put(path.join(dir, '.state.json'), ledger);
  put(path.join(dir, 'archive.md'), '【√】 past\n');
  const originalLink = fs.linkSync;
  let injected = false;
  fs.linkSync = function (source, target, ...args) {
    if (!injected && String(target) === path.join(dir, 'archive', 'legacy.md')) {
      injected = true;
      throw new Error('injected archive publication failure');
    }
    return originalLink.call(this, source, target, ...args);
  };
  try { assert.throws(() => store.migrateLegacyInbox(ctx), /injected/); } finally { fs.linkSync = originalLink; }
  assert.equal(fs.readFileSync(path.join(dir, 'ideas.md'), 'utf8'), '- [ ] old\n');
  assert.equal(fs.readFileSync(path.join(dir, '.state.json'), 'utf8'), ledger);
  assert.equal(fs.readFileSync(path.join(dir, 'archive.md'), 'utf8'), '【√】 past\n');
  assert.equal(fs.existsSync(paths(ctx).ideas), false);
  assert.equal(fs.existsSync(paths(ctx).state), false);
  store.migrateLegacyInbox(ctx);
  assert.equal(item(ctx, 'old').status, 'delivered');
});

test('after migrating repeated history a newly added occurrence can be delivered', (t) => {
  const ctx = fixture(t);
  const dir = path.join(ctx.rootDir, '.agents', 'fons');
  const repeatId = id('repeat\0' + '2');
  put(path.join(dir, 'ideas.md'), '【√】 repeat\n- [ ] repeat\n');
  put(path.join(dir, 'archive.md'), '【√】 repeat\n');
  put(path.join(dir, '.state.json'), JSON.stringify({ [A]: { delivered: { [repeatId]: { text: 'repeat', deliveredAt: 1, ackToken: 'aaaaaaaaaaaaaaaa' } } } }));
  store.migrateLegacyInbox(ctx);
  const active = snapshot(ctx).items.find((row) => row.text === 'repeat' && row.status !== 'done');
  store.completeIdea({ ...ctx, token: active.token });
  store.archiveCompleted(ctx);
  store.addIdeas({ ...ctx, texts: ['repeat'] });
  assert.equal(item(ctx, 'repeat').status, 'buffering');
  assert.notEqual(item(ctx, 'repeat').id, active.id);
});

test('failed retraction publication restores the removed row without clobbering concurrent edits', (t) => {
  for (const failure of ['marker', 'ui', 'concurrent']) {
    const ctx = fixture(t);
    store.addIdeas({ ...ctx, texts: ['sent'] });
    const sent = item(ctx, 'sent');
    state(ctx, { delivered: { [sent.id]: { at: 1 } } });
    const originalWrite = fs.writeFileSync;
    let injected = false;
    fs.writeFileSync = function (file, ...args) {
      const isMarker = String(file) === paths(ctx).retractMarker;
      const isUi = String(file).startsWith(`${paths(ctx).ui}.tmp-`);
      if (!injected && ((failure === 'ui' && isUi) || (failure !== 'ui' && isMarker))) {
        injected = true;
        if (failure === 'concurrent') originalWrite.call(this, paths(ctx).ideas, '- [ ] concurrent\n', 'utf8');
        throw new Error('injected retraction failure');
      }
      return originalWrite.call(this, file, ...args);
    };
    try { assert.throws(() => store.removeIdea(mutation(ctx, sent)), /injected/); } finally { fs.writeFileSync = originalWrite; }
    assert.equal(fs.readFileSync(paths(ctx).ideas, 'utf8'), failure === 'concurrent' ? '- [ ] concurrent\n' : '- [ ] sent\n');
    assert.equal(fs.existsSync(paths(ctx).retractMarker), false);
    const ui = fs.existsSync(paths(ctx).ui) ? JSON.parse(fs.readFileSync(paths(ctx).ui, 'utf8')) : {};
    assert.equal(Boolean(ui.retracted?.[sent.id]), failure === 'concurrent');
  }
});



function recoveryPath(base, relative) {
  assert.equal(path.isAbsolute(relative), false);
  const resolved = path.resolve(base, relative);
  const within = path.relative(base, resolved);
  assert.ok(within && within !== '..' && !within.startsWith('..' + path.sep) && !path.isAbsolute(within));
  return resolved;
}

function preservePublishedTarget({ dir, holding, target }) {
  for (const kind of ['ideas', 'state']) {
    const source = recoveryPath(dir, target[kind]);
    if (!fs.existsSync(source)) continue;
    const digest = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
    assert.equal(digest, target[kind + 'Hash']);
    const destination = recoveryPath(holding, target[kind]);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(source, destination);
  }
}

function restoreSource({ dir, holding, original, backup }) {
  const source = recoveryPath(dir, backup);
  if (!fs.existsSync(source)) return;
  const destination = recoveryPath(dir, original);
  if (fs.existsSync(destination)) assert.deepEqual(fs.readFileSync(destination), fs.readFileSync(source));
  else {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
  assert.deepEqual(fs.readFileSync(destination), fs.readFileSync(source));
  const held = recoveryPath(holding, backup);
  fs.mkdirSync(path.dirname(held), { recursive: true });
  fs.renameSync(source, held);
}

function recoverClaimed({ rootDir, owner }) {
  const dir = path.join(rootDir, '.agents', 'fons');
  const backup = path.join(rootDir, 'recovery-backup');
  const holding = path.join(backup, 'retained');
  fs.cpSync(dir, backup, { recursive: true });
  fs.mkdirSync(holding);
  for (const target of owner.targets) preservePublishedTarget({ dir, holding, target });
  for (const [original, saved] of [['ideas', 'claimed'], ['state', 'stateBackup'], ['archive', 'archiveBackup']]) {
    restoreSource({ dir, holding, original: owner.source[original], backup: owner.source[saved] });
  }
  fs.renameSync(path.join(dir, '.migration.lock'), path.join(holding, '.migration.lock'));
  return { backup, holding };
}

test('a killed migration retains lock and claimed data while another session remains usable', { timeout: 10000 }, async (t) => {
  const ctx = fixture(t);
  const second = { ...ctx, sessionId: B };
  const dir = path.join(ctx.rootDir, '.agents', 'fons');
  const legacy = '- [ ] old\n';
  const ledger = JSON.stringify({ [A]: { delivered: { [id('old')]: { text: 'old', deliveredAt: 1, ackToken: 'aaaaaaaaaaaaaaaa' } } } });
  put(path.join(dir, 'ideas.md'), legacy);
  put(path.join(dir, '.state.json'), ledger);
  const preload = path.join(ctx.rootDir, 'pause-migration.cjs');
  put(preload, `const fs = require('node:fs');
const oldOpen = fs.openSync;
const oldWrite = fs.writeFileSync;
let watched;
fs.openSync = function(file, ...args) {
  const fd = oldOpen.call(this, file, ...args);
  if (String(file) === process.env.FONS_TEST_TARGET) watched = fd;
  return fd;
};
fs.writeFileSync = function(file, ...args) {
  const value = oldWrite.call(this, file, ...args);
  if (file === watched) {
    process.stdout.write('FONS_TEST_READY\\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
  return value;
};`);
  const script = `import { migrateLegacyInbox } from ${JSON.stringify(storeUrl)}; migrateLegacyInbox({ rootDir: process.argv[1], sessionId: process.argv[2] });`;
  const started = Date.now();
  const proc = spawn(process.execPath, ['--require', preload, '--input-type=module', '-e', script, ctx.rootDir, A], {
    env: { ...process.env, FONS_TEST_TARGET: paths(ctx).ideas }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); });
  let stderr = '';
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (chunk) => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`migration did not pause: ${stderr}`)), 5000);
    proc.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('FONS_TEST_READY')) { clearTimeout(timer); resolve(); }
    });
    proc.once('error', (error) => { clearTimeout(timer); reject(error); });
    proc.once('exit', (code) => { clearTimeout(timer); reject(new Error(`migration exited early (${code}): ${stderr}`)); });
  });
  const exited = new Promise((resolve) => proc.once('close', resolve));
  let liveWarning;
  try {
    liveWarning = store.getMigrationWarning({ rootDir: ctx.rootDir });
  } finally {
    proc.kill('SIGKILL');
    await exited;
  }
  assert.equal(liveWarning.status, 'active');
  assert.equal(liveWarning.pid, proc.pid);
  const owner = JSON.parse(fs.readFileSync(path.join(dir, '.migration.lock', 'owner.json'), 'utf8'));
  assert.equal(owner.pid, proc.pid);
  assert.ok(owner.startedAt >= started && owner.startedAt <= Date.now());
  assert.equal(owner.step, 'publishing');
  assert.equal(owner.source.ideas, 'ideas.md');
  assert.equal(path.isAbsolute(owner.source.claimed), false);
  assert.equal(fs.readFileSync(path.join(dir, owner.source.claimed), 'utf8'), legacy);
  assert.equal(fs.readFileSync(path.join(dir, owner.source.state), 'utf8'), ledger);
  const target = owner.targets.find((entry) => entry.ideas === path.basename(paths(ctx).ideas));
  assert.ok(target);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, target.ideas))).digest('hex'), target.ideasHash);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, target.state))).digest('hex'), target.stateHash);
  store.addIdeas({ ...second, texts: ['new session'] });
  assert.equal(item(second, 'new session').status, 'buffering');
  const retained = fs.readFileSync(path.join(dir, owner.source.claimed), 'utf8');
  const published = fs.readFileSync(path.join(dir, target.ideas), 'utf8');
  assert.equal(store.migrateLegacyInbox(second).migrated, false);
  assert.equal(fs.readFileSync(path.join(dir, owner.source.claimed), 'utf8'), retained);
  assert.equal(fs.readFileSync(path.join(dir, target.ideas), 'utf8'), published);
  assert.equal(item(second, 'new session').text, 'new session');
  assert.equal(fs.existsSync(path.join(dir, '.migration.lock', 'owner.json')), true);
  const warning = store.getMigrationWarning({ rootDir: ctx.rootDir });
  assert.equal(warning.status, 'interrupted');
  assert.equal(warning.pid, proc.pid);
  assert.equal(warning.step, 'publishing');
  const secondBefore = fs.readFileSync(paths(second).ideas, 'utf8');
  const { backup, holding } = recoverClaimed({ rootDir: ctx.rootDir, owner });
  assert.equal(fs.existsSync(path.join(backup, '.migration.lock', 'owner.json')), true);
  assert.equal(fs.existsSync(path.join(holding, '.migration.lock', 'owner.json')), true);
  assert.equal(store.migrateLegacyInbox(ctx).migrated, true);
  assert.equal(item(ctx, 'old').status, 'delivered');
  assert.deepEqual(snapshot(ctx).items.map((row) => row.text), ['old']);
  assert.equal(fs.readFileSync(paths(second).ideas, 'utf8'), secondBefore);
  const migrated = fs.readFileSync(paths(ctx).ideas, 'utf8');
  const migratedState = fs.readFileSync(paths(ctx).state, 'utf8');
  assert.equal(store.migrateLegacyInbox(ctx).migrated, false);
  assert.equal(fs.readFileSync(paths(ctx).ideas, 'utf8'), migrated);
  assert.equal(fs.readFileSync(paths(ctx).state, 'utf8'), migratedState);
  assert.equal(fs.existsSync(path.join(dir, '.migration.lock')), false);
});




test('failed rollback retains the lock and reports interrupted despite the owner process being alive', (t) => {
  const ctx = fixture(t);
  const dir = path.join(ctx.rootDir, '.agents', 'fons');
  put(path.join(dir, 'ideas.md'), '- [ ] old\n');
  put(path.join(dir, '.state.json'), JSON.stringify({}));
  put(path.join(dir, 'archive.md'), '【√】 past\n');
  const originalLink = fs.linkSync;
  let injected = false;
  fs.linkSync = function (source, target, ...args) {
    if (!injected && String(target) === path.join(dir, 'archive', 'legacy.md')) {
      injected = true;
      fs.writeFileSync(paths(ctx).ideas, '- [ ] concurrent\n', 'utf8');
      throw new Error('injected migration failure');
    }
    return originalLink.call(this, source, target, ...args);
  };
  try { assert.throws(() => store.migrateLegacyInbox(ctx), /injected/); } finally { fs.linkSync = originalLink; }
  const lock = path.join(dir, '.migration.lock');
  const owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'));
  assert.equal(owner.pid, process.pid);
  assert.equal(owner.step, 'rollback-failed');
  assert.equal(fs.readFileSync(path.join(dir, owner.source.claimed), 'utf8'), '- [ ] old\n');
  assert.equal(fs.readFileSync(paths(ctx).ideas, 'utf8'), '- [ ] concurrent\n');
  const warning = store.getMigrationWarning({ rootDir: ctx.rootDir });
  assert.equal(warning.status, 'interrupted');
  assert.equal(warning.step, 'rollback-failed');
});

test('an absent or corrupt lock owner is reported as unknown and never discarded', (t) => {
  const ctx = fixture(t);
  assert.equal(store.getMigrationWarning({ rootDir: ctx.rootDir }), null);
  const lock = path.join(ctx.rootDir, '.agents', 'fons', '.migration.lock');
  fs.mkdirSync(lock, { recursive: true });
  assert.equal(store.getMigrationWarning({ rootDir: ctx.rootDir }).status, 'unknown');
  put(path.join(lock, 'owner.json'), '{broken');
  assert.equal(store.getMigrationWarning({ rootDir: ctx.rootDir }).status, 'unknown');
  assert.equal(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'), '{broken');
});

test('concurrent registration publishes one complete immutable pointer and returns it to both callers', async (t) => {
  const ctx = fixture(t);
  const appData = path.join(ctx.rootDir, 'host');
  const indexFile = path.join(appData, 'fons', 'conversations', `${A}.json`);
  const readyA = path.join(ctx.rootDir, 'ready-a');
  const readyB = path.join(ctx.rootDir, 'ready-b');
  const script = `
    import fs from 'node:fs';
    import { registerConversation } from ${JSON.stringify(storeUrl)};
    const [appData, sessionId, rootDir, title, indexFile, ready, other] = process.argv.slice(1);
    const write = fs.writeFileSync;
    let synchronized = false;
    fs.writeFileSync = function (file, ...args) {
      if (!synchronized && String(file).startsWith(indexFile + '.tmp-')) {
        synchronized = true;
        write.call(this, ready, 'ready');
        const deadline = Date.now() + 10000;
        while (!fs.existsSync(other)) {
          if (Date.now() > deadline) throw new Error('registration barrier timed out');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
      }
      return write.call(this, file, ...args);
    };
    process.stdout.write(JSON.stringify(registerConversation({ appData, sessionId, rootDir, title })));
  `;
  function register(rootDir, title, ready, other) {
    return new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, ['--input-type=module', '-e', script,
        appData, A, rootDir, title, indexFile, ready, other], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (part) => { stdout += part; });
      proc.stderr.on('data', (part) => { stderr += part; });
      proc.on('error', reject);
      proc.on('close', (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
    });
  }
  const [first, second] = await Promise.all([
    register('root-a', 'title-a', readyA, readyB),
    register('root-b', 'title-b', readyB, readyA),
  ]);
  assert.deepEqual(first, second);
  assert.deepEqual(JSON.parse(fs.readFileSync(indexFile, 'utf8')), first);
  assert.ok(first.rootDir === 'root-a' || first.rootDir === 'root-b');
  assert.equal(first.title, first.rootDir === 'root-a' ? 'title-a' : 'title-b');
});

test('manual recovery restores moved legacy state and archive without blocking migration retry', (t) => {
  const ctx = fixture(t);
  const dir = path.join(ctx.rootDir, '.agents', 'fons');
  const owner = { source: { ideas: 'ideas.md', claimed: 'ideas.migrating-999999.md', state: '.state.json', stateBackup: '.state.legacy.json', archive: 'archive.md', archiveBackup: path.join('archive', 'legacy.md') }, targets: [] };
  const ledger = JSON.stringify({ [A]: { delivered: { [id('old')]: { text: 'old', deliveredAt: 1, ackToken: 'aaaaaaaaaaaaaaaa' } } } });
  put(path.join(dir, owner.source.claimed), '- [ ] old\n');
  put(path.join(dir, owner.source.stateBackup), ledger);
  put(path.join(dir, owner.source.archiveBackup), '【√】 past\n');
  put(path.join(dir, '.migration.lock', 'owner.json'), JSON.stringify(owner));
  const { backup, holding } = recoverClaimed({ rootDir: ctx.rootDir, owner });
  assert.equal(fs.readFileSync(path.join(dir, owner.source.state), 'utf8'), ledger);
  assert.equal(fs.readFileSync(path.join(dir, owner.source.archive), 'utf8'), '【√】 past\n');
  assert.equal(fs.readFileSync(path.join(backup, owner.source.stateBackup), 'utf8'), ledger);
  assert.equal(fs.readFileSync(path.join(holding, owner.source.archiveBackup), 'utf8'), '【√】 past\n');
  assert.equal(store.migrateLegacyInbox(ctx).migrated, true);
  assert.equal(item(ctx, 'old').status, 'delivered');
  assert.equal(fs.readFileSync(path.join(dir, owner.source.stateBackup), 'utf8'), ledger);
  assert.equal(fs.readFileSync(path.join(dir, owner.source.archiveBackup), 'utf8'), '【√】 past\n');
  assert.equal(fs.existsSync(path.join(dir, '.migration.lock')), false);
});


test('migration preserves a ledger created after planning and restores the old inbox', (t) => {
  const ctx = fixture(t);
  const dir = path.join(ctx.rootDir, '.agents', 'fons');
  const oldInbox = '- [ ] old\n';
  const oldLedger = JSON.stringify({ [A]: { delivered: { [id('old')]: { text: 'old', deliveredAt: 1, ackToken: 'aaaaaaaaaaaaaaaa' } } } });
  const concurrentLedger = '{"delivered":{"new":{"text":"concurrent"}}}\n';
  put(path.join(dir, 'ideas.md'), oldInbox);
  put(path.join(dir, '.state.json'), oldLedger);
  const ownerFile = path.join(dir, '.migration.lock', 'owner.json');
  const originalRename = fs.renameSync;
  let inserted = false;
  fs.renameSync = function (source, target, ...args) {
    const result = originalRename.call(this, source, target, ...args);
    if (!inserted && String(target) === ownerFile && JSON.parse(fs.readFileSync(ownerFile, 'utf8')).step === 'publishing') {
      inserted = true;
      fs.writeFileSync(paths(ctx).state, concurrentLedger, 'utf8');
    }
    return result;
  };
  try {
    assert.throws(() => store.migrateLegacyInbox(ctx), { code: 'EEXIST' });
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(inserted, true);
  assert.equal(fs.readFileSync(paths(ctx).state, 'utf8'), concurrentLedger);
  assert.equal(fs.readFileSync(path.join(dir, 'ideas.md'), 'utf8'), oldInbox);
  assert.equal(fs.readFileSync(path.join(dir, '.state.json'), 'utf8'), oldLedger);
  assert.equal(fs.existsSync(paths(ctx).ideas), false);
});

test('a killed migration retains its staged ledger before or after exclusive publication', { timeout: 15000 }, async (t) => {
  for (const phase of ['before', 'after']) {
    const ctx = fixture(t);
    const dir = path.join(ctx.rootDir, '.agents', 'fons');
    const legacy = '- [ ] old\n';
    put(path.join(dir, 'ideas.md'), legacy);
    put(path.join(dir, '.state.json'), JSON.stringify({ [A]: { delivered: { [id('old')]: { text: 'old' } } } }));
    const staging = path.join(dir, '.migration.lock', 'state-staging.json');
    const preload = path.join(ctx.rootDir, 'pause-staged-publication.cjs');
    put(preload, `const fs = require('node:fs');
const original = fs.linkSync;
function pause() {
  process.stdout.write('FONS_STAGING_READY\\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
fs.linkSync = function(source, target, ...args) {
  const watched = String(source) === process.env.FONS_TEST_STAGING;
  if (watched && process.env.FONS_TEST_PHASE === 'before') pause();
  const result = original.call(this, source, target, ...args);
  if (watched && process.env.FONS_TEST_PHASE === 'after') pause();
  return result;
};`);
    const script = 'import { migrateLegacyInbox } from ' + JSON.stringify(storeUrl) + '; migrateLegacyInbox({ rootDir: process.argv[1], sessionId: process.argv[2] });';
    const proc = spawn(process.execPath, ['--require', preload, '--input-type=module', '-e', script, ctx.rootDir, A], {
      env: { ...process.env, FONS_TEST_STAGING: staging, FONS_TEST_PHASE: phase }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); });
    let stderr = '';
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => { stderr += chunk; });
    await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('migration did not pause: ' + stderr)), 5000);
      proc.stdout.on('data', (chunk) => {
        output += chunk;
        if (output.includes('FONS_STAGING_READY')) { clearTimeout(timer); resolve(); }
      });
      proc.once('error', (error) => { clearTimeout(timer); reject(error); });
      proc.once('exit', (code) => { clearTimeout(timer); reject(new Error('migration exited early (' + code + '): ' + stderr)); });
    });
    const exited = new Promise((resolve) => proc.once('close', resolve));
    assert.equal(proc.kill('SIGKILL'), true);
    await exited;
    const owner = JSON.parse(fs.readFileSync(path.join(dir, '.migration.lock', 'owner.json'), 'utf8'));
    const entry = owner.targets.find((target) => target.state === path.basename(paths(ctx).state));
    assert.equal(owner.step, 'publishing');
    assert.equal(fs.readFileSync(path.join(dir, owner.source.claimed), 'utf8'), legacy);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(staging)).digest('hex'), entry.stateHash);
    assert.equal(fs.existsSync(paths(ctx).state), phase === 'after');
    if (phase === 'after') assert.deepEqual(fs.readFileSync(paths(ctx).state), fs.readFileSync(staging));
    assert.equal(store.getMigrationWarning({ rootDir: ctx.rootDir }).status, 'interrupted');
  }
});
