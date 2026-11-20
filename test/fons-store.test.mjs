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

test('readonly acknowledgments support reopening and deletion without reusing old completion', (t) => {
  const ctx = fixture(t);
  store.addIdeas({ ...ctx, texts: ['legacy', 'recent', 'repeat'] });
  const legacy = item(ctx, 'legacy');
  const recent = item(ctx, 'recent');
  const repeat = item(ctx, 'repeat');
  state(ctx, { acknowledged: { [legacy.id]: true, [recent.id]: { at: 1234 }, [repeat.id]: { at: Date.now() } } });
  assert.equal(item(ctx, 'legacy').status, 'done');
  assert.equal(item(ctx, 'recent').doneSource, 'readonly_ack');
  const before = fs.readFileSync(paths(ctx).ideas, 'utf8');
  store.reopenIdea(mutation(ctx, item(ctx, 'legacy')));
  store.reopenIdea(mutation(ctx, item(ctx, 'recent')));
  assert.equal(fs.readFileSync(paths(ctx).ideas, 'utf8'), before);
  assert.notEqual(item(ctx, 'legacy').status, 'done');
  assert.notEqual(item(ctx, 'recent').status, 'done');
  const completed = item(ctx, 'repeat');
  assert.equal(completed.doneSource, 'readonly_ack');
  assert.equal(store.removeIdea(mutation(ctx, completed)).conflict, false);
  store.addIdeas({ ...ctx, texts: ['repeat'] });
  assert.equal(item(ctx, 'repeat').status, 'buffering');
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

test('holdEditing and leftover temporary JSON files do not damage the ledger or snapshot', (t) => {
  const ctx = fixture(t);
  store.addIdeas({ ...ctx, texts: ['sent', 'draft'] });
  const sent = item(ctx, 'sent');
  const draft = item(ctx, 'draft');
  state(ctx, { delivered: { [sent.id]: { at: 1 } } });
  put(`${paths(ctx).state}.tmp-9`, '{incomplete');
  put(`${paths(ctx).ui}.tmp-9`, '{incomplete');
  store.holdEditing({ ...ctx, id: draft.id, now: 5000 });
  assert.equal(item(ctx, 'sent').status, 'delivered');
  assert.ok(JSON.parse(fs.readFileSync(paths(ctx).ui, 'utf8')).timers[draft.id].holdUntil > 5000);
  assert.ok(JSON.parse(fs.readFileSync(paths(ctx).state, 'utf8')).delivered[sent.id]);
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



test('per-item timers stay independent across additions and completions while delivered/done rows lock edits', (t) => {
  const ctx = fixture(t);
  store.addIdeas({ ...ctx, texts: ['sent', 'draft'] });
  const sent = item(ctx, 'sent');
  const draft = item(ctx, 'draft');
  state(ctx, { delivered: { [sent.id]: { at: 1 } } });
  const data = store.readPoolData(ctx);
  const initial = store.computeDebounce({ ...data, mtimeMs: 1000, debounceMs: 45000, now: 11000 });
  assert.equal(initial.byId.get(draft.id).remainingMs, 35000);
  const ledger = { ...data.state, pendingAt: initial.pendingAt };

  store.completeIdea({ ...ctx, token: sent.token });
  const afterDone = store.computeDebounce({ ...store.readPoolData(ctx), state: ledger, mtimeMs: 15000, debounceMs: 45000, now: 16000 });
  assert.equal(afterDone.byId.get(draft.id).since, 1000);
  assert.equal(afterDone.byId.get(draft.id).remainingMs, 30000);

  store.addIdeas({ ...ctx, texts: ['second'] });
  const second = item(ctx, 'second');
  const afterAdd = store.computeDebounce({ ...store.readPoolData(ctx), state: ledger, mtimeMs: 20000, debounceMs: 45000, now: 21000 });
  assert.equal(afterAdd.byId.get(draft.id).since, 1000);
  assert.equal(afterAdd.byId.get(draft.id).remainingMs, 25000);
  assert.equal(afterAdd.byId.get(second.id).since, 20000);
  assert.equal(afterAdd.byId.get(second.id).remainingMs, 44000);

  const doneRow = item(ctx, 'sent');
  assert.deepEqual(store.updateIdeaText({ ...mutation(ctx, doneRow), newText: 'cannot edit done' }), { conflict: true, locked: true });
  store.addIdeas({ ...ctx, texts: ['alreadySent'] });
  const sentRow = item(ctx, 'alreadySent');
  state(ctx, { ...ledger, delivered: { [sentRow.id]: { at: 2 } } });
  assert.deepEqual(store.updateIdeaText({ ...mutation(ctx, item(ctx, 'alreadySent')), newText: 'cannot edit sent' }), { conflict: true, locked: true });
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
    items: [{ id: 'aaaaaaaaaaaa', text: 'draft', status: 'buffering' }],
    state: {}, ui: {}, mtimeMs: 1000.75, debounceMs: 0, now: 1000,
  });
  assert.equal(result.byId.get('aaaaaaaaaaaa').remainingMs, 0);
  assert.equal(result.ready.length, 1);
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

test('default debounce is 45 seconds and per-item editing hold freezes only the held item and safely expires', (t) => {
  const saved = process.env.FONS_DEBOUNCE_SEC;
  t.after(() => {
    if (saved === undefined) delete process.env.FONS_DEBOUNCE_SEC;
    else process.env.FONS_DEBOUNCE_SEC = saved;
  });
  delete process.env.FONS_DEBOUNCE_SEC;
  assert.equal(store.resolveDebounceMs(), 45000);
  process.env.FONS_DEBOUNCE_SEC = 'invalid';
  assert.equal(store.resolveDebounceMs(), 45000);
  delete process.env.FONS_DEBOUNCE_SEC;

  const ctx = fixture(t);
  store.addIdeas({ ...ctx, texts: ['first', 'second'] });
  const baseAt = 10000;
  fs.utimesSync(paths(ctx).ideas, new Date(baseAt), new Date(baseAt));
  store.stampPoolTimers({ ...ctx, now: baseAt });
  const firstId = item(ctx, 'first').id;
  const secondId = item(ctx, 'second').id;

  assert.equal(store.holdEditing({ ...ctx, id: secondId, now: 25000 }).editingHold, true);
  const heldMid = store.readPoolSnapshot({ ...ctx, now: 32000 });
  const firstMid = heldMid.items.find((row) => row.id === firstId);
  const secondMid = heldMid.items.find((row) => row.id === secondId);
  assert.equal(firstMid.editingHold, false);
  assert.equal(firstMid.remainingMs, 23000);
  assert.equal(secondMid.editingHold, true);
  assert.equal(secondMid.remainingMs, 30000);

  assert.equal(store.holdEditing({ ...ctx, id: secondId, now: 35000 }).editingHold, true);
  assert.equal(store.readPoolSnapshot({ ...ctx, now: 42000 }).items.find((row) => row.id === secondId).remainingMs, 30000);

  store.releaseEditing({ ...ctx, id: secondId, now: 45000 });
  const afterRelease = store.readPoolSnapshot({ ...ctx, now: 50000 }).items.find((row) => row.id === secondId);
  assert.equal(afterRelease.editingHold, false);
  assert.equal(afterRelease.remainingMs, 25000);

  store.holdEditing({ ...ctx, id: secondId, now: 50000 });
  const afterLeaseExpiry = store.readPoolSnapshot({ ...ctx, now: 70000 }).items.find((row) => row.id === secondId);
  assert.equal(afterLeaseExpiry.editingHold, false);
  assert.equal(afterLeaseExpiry.remainingMs, 20000);
});

test('no-workspace conversations isolate from workspaces, support full pool CRUD via fonsDir, and skip migrations', (t) => {
  const ctx = fixture(t);
  const appData = path.join(ctx.rootDir, 'host');
  const legacyId = '33333333-3333-4333-8333-333333333333';
  const indexDir = path.join(appData, 'fons', 'conversations');
  fs.mkdirSync(indexDir, { recursive: true });
  fs.writeFileSync(path.join(indexDir, `${legacyId}.json`), JSON.stringify({ rootDir: ctx.rootDir, title: 'legacy', registeredAt: 1 }));

  store.registerConversation({ appData, sessionId: A, scope: 'no-workspace', title: '自由讨论' });
  store.registerConversation({ appData, sessionId: B, rootDir: ctx.rootDir, title: '项目会话' });

  const noWs = store.lookupConversation({ appData, sessionId: A });
  assert.equal(noWs.scope, 'no-workspace');
  assert.equal(noWs.rootDir, null);
  assert.equal(noWs.fonsDir, store.noWorkspaceFonsDir(appData));
  assert.equal(noWs.title, '自由讨论');

  const wsEntry = store.lookupConversation({ appData, sessionId: B });
  assert.equal(wsEntry.scope, 'workspace');
  assert.equal(wsEntry.rootDir, ctx.rootDir);
  assert.equal(wsEntry.fonsDir, path.join(ctx.rootDir, '.agents', 'fons'));

  const legacyEntry = store.lookupConversation({ appData, sessionId: legacyId });
  assert.equal(legacyEntry.scope, 'workspace');
  assert.equal(legacyEntry.rootDir, ctx.rootDir);

  assert.deepEqual(store.listConversations({ appData, scope: 'no-workspace' }).map((e) => e.sessionId), [A]);
  assert.deepEqual(store.listConversations({ appData, rootDir: ctx.rootDir }).map((e) => e.sessionId).sort(), [B, legacyId]);

  const noWsCtx = { scope: 'no-workspace', rootDir: null, fonsDir: noWs.fonsDir, sessionId: A };
  store.addIdeas({ ...noWsCtx, texts: ['草稿一', '草稿二'] });
  const first = store.readPoolSnapshot(noWsCtx).items[0];
  assert.equal(store.updateIdeaText({ ...noWsCtx, rowIndex: first.rowIndex, expectedRaw: first.raw, newText: '改写一' }).conflict, false);
  const edited = store.readPoolSnapshot(noWsCtx).items[0];
  assert.equal(store.holdEditing({ ...noWsCtx, id: edited.id }).editingHold, true);
  assert.equal(store.releaseEditing({ ...noWsCtx, id: edited.id }).editingHold, false);
  store.completeIdea({ ...noWsCtx, token: edited.token });
  const done = store.readPoolSnapshot(noWsCtx).items[0];
  assert.equal(done.status, 'done');
  assert.equal(store.reopenIdea({ ...noWsCtx, rowIndex: done.rowIndex, expectedRaw: done.raw }).conflict, false);
  const reopened = store.readPoolSnapshot(noWsCtx).items[0];
  store.completeIdea({ ...noWsCtx, token: reopened.token });
  assert.equal(store.archiveCompleted(noWsCtx).count, 1);

  const second = store.readPoolSnapshot(noWsCtx).items[0];
  assert.equal(store.removeIdea({ ...noWsCtx, rowIndex: second.rowIndex, expectedRaw: second.raw }).conflict, false);
  assert.equal(fs.existsSync(path.join(ctx.rootDir, '.agents')), false);
  assert.match(fs.readFileSync(path.join(noWs.fonsDir, 'archive', `${A}.md`), 'utf8'), /改写一/);
  assert.equal(store.getMigrationWarning(noWsCtx), null);
  assert.deepEqual(store.migrateLegacyInbox(noWsCtx), { migrated: false });
});

test('attachments deduplicate by content hash, sanitize unsafe names, keep external markdown links intact, and prune only unreferenced files', (t) => {
  const ctx = fixture(t);
  const pngBytes = Buffer.from('89504e470d0a1a0a', 'hex');
  const docBytes = Buffer.from('# API Spec\n', 'utf8');

  // Add mixed note + two attachments (including unsafe display name and MIME-inferred extension)
  const firstAdd = store.addIdeas({
    ...ctx,
    texts: ['参考 [外部文档](https://example.com/spec) 核对样式'],
    attachments: [
      { name: '../CON.png', mimeType: 'image/png', dataBase64: pngBytes.toString('base64') },
      { name: '接口说明 [v1].md', mimeType: 'text/markdown', dataBase64: docBytes.toString('base64') },
    ],
  });
  assert.equal(firstAdd.count, 1);

  // Add pure-attachment item sharing the exact same PNG content
  const secondAdd = store.addIdeas({
    ...ctx,
    texts: [],
    attachments: [{ name: '', mimeType: 'image/png', dataBase64: pngBytes.toString('base64') }],
  });
  assert.equal(secondAdd.count, 1);

  const snap1 = snapshot(ctx);
  assert.equal(snap1.items.length, 2);
  const [mixed, pure] = snap1.items;
  assert.notEqual(mixed.id, pure.id);
  assert.equal(mixed.note, '参考 [外部文档](https://example.com/spec) 核对样式');
  assert.equal(mixed.attachments.length, 2);
  assert.equal(mixed.attachments[0].name, 'CON.png');
  assert.equal(mixed.attachments[0].isImage, true);
  assert.equal(mixed.attachments[0].missing, false);
  assert.equal(mixed.attachments[0].size, pngBytes.byteLength);
  assert.equal(mixed.attachments[1].name, '接口说明 (v1).md');
  assert.equal(mixed.attachments[1].isImage, false);

  assert.equal(pure.note, '');
  assert.equal(pure.attachments.length, 1);
  assert.equal(pure.attachments[0].name, 'paste.png');
  // Both items share the identical storedName because both sanitized to image-<hash8>.png
  assert.equal(pure.attachments[0].storedName, mixed.attachments[0].storedName);

  const loaded = store.readAttachment({ ...ctx, storedName: mixed.attachments[0].storedName });
  assert.equal(loaded.mimeType, 'image/png');
  assert.equal(loaded.dataBase64, pngBytes.toString('base64'));

  // Drop the markdown attachment and clear the note on the first item -> doc file is pruned, shared PNG stays
  const docFile = path.join(paths(ctx).attachmentsDir, mixed.attachments[1].storedName);
  const pngFile = path.join(paths(ctx).attachmentsDir, mixed.attachments[0].storedName);
  assert.equal(fs.existsSync(docFile), true);
  const updateRes = store.updateIdeaText({
    ...mutation(ctx, mixed),
    newText: '',
    keepAttachments: [mixed.attachments[0].storedName],
  });
  assert.equal(updateRes.conflict, false);
  assert.equal(fs.existsSync(docFile), false);
  assert.equal(fs.existsSync(pngFile), true);

  // Removing the first item still keeps shared PNG for the second item
  const updatedFirst = snapshot(ctx).items[0];
  assert.equal(store.removeIdea(mutation(ctx, updatedFirst)).conflict, false);
  assert.equal(fs.existsSync(pngFile), true);

  // Archiving a completed item rewrites link relative to archive/ while keeping duplicate deliveryId stable
  const remainingPure = snapshot(ctx).items[0];
  store.completeIdea({ ...ctx, token: remainingPure.token });
  // Add an identical pending item BEFORE archiving so we can verify its deliveryId never drifts across archive
  const dupBefore = store.addIdeas({
    ...ctx,
    texts: [],
    attachments: [{ name: '', mimeType: 'image/png', dataBase64: pngBytes.toString('base64') }],
  });
  assert.equal(dupBefore.count, 1);
  const idBeforeArchive = snapshot(ctx).items.find((row) => row.status === 'buffering').id;

  assert.equal(store.archiveCompleted(ctx).count, 1);
  assert.equal(fs.existsSync(pngFile), true);
  const archivedText = fs.readFileSync(paths(ctx).archive, 'utf8').trim();
  const hrefMatch = /\((\.\.\/attachments\/[^)]+)\)/.exec(archivedText);
  assert.ok(hrefMatch, `archive link should use ../attachments/...: ${archivedText}`);
  assert.equal(fs.existsSync(path.resolve(path.dirname(paths(ctx).archive), hrefMatch[1])), true);

  const dupAfterArchive = snapshot(ctx).items[0];
  assert.equal(dupAfterArchive.id, idBeforeArchive, 'deliveryId stays identical after moving completion to archive/');
  assert.equal(store.removeIdea(mutation(ctx, dupAfterArchive)).conflict, false);
  assert.equal(fs.existsSync(pngFile), true, 'archived reference still protects attachment from GC');

  // Add and remove a fresh unshared buffering attachment -> file is cleaned up
  const freshBytes = Buffer.from('temp-log', 'utf8');
  store.addIdeas({ ...ctx, texts: ['临时日志'], attachments: [{ name: 'run.log', buffer: freshBytes }] });
  const freshItem = snapshot(ctx).items[0];
  const freshPath = path.join(paths(ctx).attachmentsDir, freshItem.attachments[0].storedName);
  assert.equal(fs.existsSync(freshPath), true);
  assert.equal(store.removeIdea(mutation(ctx, freshItem)).conflict, false);
  assert.equal(fs.existsSync(freshPath), false);
});

test('editing an idea preserves leading list characters like "- " and single "-" without vanishing into an empty row', (t) => {
  const ctx = fixture(t);
  store.addIdeas({ ...ctx, texts: ['初始文本'] });
  const first = snapshot(ctx).items[0];

  const dashPrefixed = store.updateIdeaText({ ...mutation(ctx, first), newText: '- 调整参数' });
  assert.equal(dashPrefixed.conflict, false);
  const afterDashPrefix = snapshot(ctx).items[0];
  assert.equal(afterDashPrefix.text, '- 调整参数');
  assert.equal(afterDashPrefix.note, '- 调整参数');

  const singleDash = store.updateIdeaText({ ...mutation(ctx, afterDashPrefix), newText: '-' });
  assert.equal(singleDash.conflict, false);
  const afterSingleDash = snapshot(ctx).items[0];
  assert.equal(afterSingleDash.text, '-');
  assert.equal(afterSingleDash.note, '-');

  assert.throws(() => store.updateIdeaText({ ...mutation(ctx, afterSingleDash), newText: '   ' }), /不能为空/);
  assert.equal(snapshot(ctx).items[0].text, '-');
});

test('attachment bounds and foreign storedName references are rejected cleanly', (t) => {
  const ctx = fixture(t);
  assert.throws(
    () => store.addIdeas({ ...ctx, texts: ['empty'], attachments: [{ name: 'empty.png', dataBase64: '' }] }),
    { code: 'FONS_INVALID_ATTACHMENT' },
  );
  const tooMany = Array.from({ length: store.MAX_ITEM_ATTACHMENTS + 1 }, (_, i) => ({
    name: `f-${i}.txt`,
    buffer: Buffer.from(`v-${i}`),
  }));
  assert.throws(
    () => store.addIdeas({ ...ctx, texts: ['overflow'], attachments: tooMany }),
    { code: 'FONS_INVALID_ATTACHMENT' },
  );
  assert.throws(() => store.readAttachment({ ...ctx, storedName: '../secret-12345678.png' }), {
    code: 'FONS_INVALID_ATTACHMENT',
  });

  store.addIdeas({ ...ctx, texts: ['plain'] });
  const plain = snapshot(ctx).items[0];
  assert.throws(
    () => store.updateIdeaText({ ...mutation(ctx, plain), newText: 'plain', keepAttachments: ['foreign-12345678.png'] }),
    { code: 'FONS_INVALID_ATTACHMENT' },
  );
  assert.equal(fs.existsSync(paths(ctx).attachmentsDir), false);
});
