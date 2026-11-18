import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../scripts/fons-cli.mjs', import.meta.url));
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function setup(t, content) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fons-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, '.agents', 'fons');
  fs.mkdirSync(dir, { recursive: true });
  const ideas = path.join(dir, `ideas-${A}.md`);
  fs.writeFileSync(ideas, content, 'utf8');
  register(root, A, root);
  return { root, ideas, archive: path.join(dir, 'archive', `${A}.md`) };
}

function register(root, sessionId, rootDir, appData = path.join(root, 'host')) {
  const index = path.join(appData, 'fons', 'conversations');
  fs.mkdirSync(index, { recursive: true });
  fs.writeFileSync(path.join(index, `${sessionId}.json`), JSON.stringify({ rootDir, title: sessionId, registeredAt: 1 }));
}

function run(root, args, nodeArgs = [], overrides = {}) {
  const env = { ...process.env, FONS_ROOT: root, FONS_APP_DATA: path.join(root, 'host'),
    HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), FONS_SESSION: '', ...overrides };
  return spawnSync(process.execPath, [...nodeArgs, cli, ...args], { cwd: root, encoding: 'utf8', env });
}

function tokens(root) {
  const result = run(root, ['list']);
  assert.equal(result.status, 0, result.stderr);
  return [...result.stdout.matchAll(/\[([0-9]+-[a-f0-9]{64})\]/g)].map((match) => match[1]);
}

test('bare done refuses to mark current items', (t) => {
  const { root, ideas } = setup(t, '- [ ] first\n');
  const result = run(root, ['done']);
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(ideas, 'utf8'), '- [ ] first\n');
});

test('explicit receipt leaves intervening same-text and unrelated entries pending', (t) => {
  const { root, ideas } = setup(t, '- [ ] first\r\n');
  const [token] = tokens(root);
  assert.ok(token);
  fs.appendFileSync(ideas, '- [ ] first\r\n- [ ] second\r\n');
  const result = run(root, ['done', token]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(ideas, 'utf8'), /【√】 first <!-- fons-ack:/);
  const list = run(root, ['list']).stdout;
  assert.match(list, /first/);
  assert.match(list, /second/);
});

test('append during completion is not lost or marked', (t) => {
  const { root, ideas } = setup(t, '- [ ] first\n');
  const [token] = tokens(root);
  const shim = path.join(root, 'append.cjs');
  fs.writeFileSync(shim, `const fs = require('node:fs');\nconst old = fs.appendFileSync;\nfs.appendFileSync = function(p, ...args) { if (String(p).endsWith('ideas-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.md')) old.call(fs, p, '- [ ] concurrent\\n'); return old.call(fs, p, ...args); };\n`);
  const result = run(root, ['done', token], ['--require', shim]);
  assert.equal(result.status, 0, result.stderr);
  const list = run(root, ['list']).stdout;
  assert.doesNotMatch(list, /first/);
  assert.match(list, /concurrent/);
});

test('archive removes scoped completion only, preserves pending and CRLF', (t) => {
  const { root, ideas, archive } = setup(t, '# ideas\r\n- [ ] first\r\n- [ ] second\r\n');
  const [token] = tokens(root);
  assert.equal(run(root, ['done', token]).status, 0);
  const result = run(root, ['archive']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(ideas, 'utf8'), '# ideas\r\n- [ ] second\r\n');
  assert.equal(fs.readFileSync(archive, 'utf8'), '【√】 first\n');
  assert.notEqual(run(root, ['archive', '--all']).status, 0);
});

test('archive detects a concurrent append before cleanup and leaves inbox intact', (t) => {
  const { root, ideas, archive } = setup(t, '【√】 first\n');
  const shim = path.join(root, 'archive-append.cjs');
  fs.writeFileSync(shim, `const fs = require('node:fs');\nconst old = fs.appendFileSync;\nfs.appendFileSync = function(p, ...args) { if (String(p) === ${JSON.stringify(archive)}) old.call(fs, ${JSON.stringify(ideas)}, '- [ ] concurrent\\n'); return old.call(fs, p, ...args); };\n`);
  const result = run(root, ['archive'], ['--require', shim]);
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(ideas, 'utf8'), '【√】 first\n- [ ] concurrent\n');
});

test('archive removes duplicate receipts for the same completed occurrence', (t) => {
  const { root, ideas, archive } = setup(t, '- [ ] first\n');
  const [token] = tokens(root);
  assert.equal(run(root, ['done', token]).status, 0);
  fs.appendFileSync(ideas, `【√】 first <!-- fons-ack:${token} -->\n`);
  assert.equal(run(root, ['archive']).status, 0);
  assert.equal(fs.existsSync(ideas), false);
  assert.equal(fs.readFileSync(archive, 'utf8'), '【√】 first\n');
});

test('CLI locates its only session through FONS_APP_DATA', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fons-cli-index-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const dir = path.join(root, '.agents', 'fons');
  const appData = path.join(root, 'host');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `ideas-${sessionId}.md`), '- [ ] indexed item\n');
  const index = path.join(appData, 'fons', 'conversations');
  fs.mkdirSync(index, { recursive: true });
  fs.writeFileSync(path.join(index, `${sessionId}.json`), JSON.stringify({ rootDir: root, title: 'test', registeredAt: 1 }));
  const result = spawnSync(process.execPath, [cli, 'list'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, FONS_ROOT: root, FONS_APP_DATA: appData, HOME: root, USERPROFILE: root, FONS_SESSION: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /indexed item/);
});

test('without an indexed session the CLI fails without creating an orphan inbox', (t) => {
  const { root, ideas } = setup(t, '- [ ] existing\n');
  fs.rmSync(path.join(root, 'host', 'fons', 'conversations', `${A}.json`));
  fs.rmSync(ideas);
  const result = run(root, ['new idea']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /开启会话/);
  assert.equal(fs.existsSync(ideas), false);
  assert.equal(fs.existsSync(path.join(root, '.agents', 'fons', 'ideas.md')), false);
});

test('multiple indexed sessions require selection and show candidate IDs and titles', (t) => {
  const { root } = setup(t, '- [ ] A item\n');
  register(root, B, root);
  const index = path.join(root, 'host', 'fons', 'conversations', B + '.json');
  fs.writeFileSync(index, JSON.stringify({ rootDir: root, title: '第二会话', registeredAt: 1 }));
  const result = run(root, ['list']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /第二会话/);
  assert.match(result.stderr, new RegExp(A));
  assert.match(result.stderr, new RegExp(B));
  assert.match(result.stderr, /-s/);
});

test('explicit session options and FONS_SESSION select one indexed session, with flags taking priority', (t) => {
  const { root, ideas } = setup(t, '- [ ] A item\n');
  register(root, B, root);
  const bIdeas = path.join(root, '.agents', 'fons', `ideas-${B}.md`);
  fs.writeFileSync(bIdeas, '- [ ] B item\n');
  const byEnv = run(root, ['list'], [], { FONS_SESSION: B });
  assert.equal(byEnv.status, 0, byEnv.stderr);
  assert.match(byEnv.stdout, /B item/);
  const byShort = run(root, ['-s', A, 'list'], [], { FONS_SESSION: B });
  assert.equal(byShort.status, 0, byShort.stderr);
  assert.match(byShort.stdout, /A item/);
  const byLong = run(root, ['list', '--session', B]);
  assert.equal(byLong.status, 0, byLong.stderr);
  assert.match(byLong.stdout, /B item/);
  assert.doesNotMatch(byLong.stdout, /A item/);
  assert.equal(fs.readFileSync(ideas, 'utf8'), '- [ ] A item\n');
  assert.notEqual(run(root, ['list', '-s', '../escape']).status, 0);
});

test('explicit registered ID uses the indexed workspace even when cwd and FONS_ROOT differ', (t) => {
  const { root, ideas } = setup(t, '- [ ] local\n');
  const other = path.join(root, 'other');
  const otherFons = path.join(other, '.agents', 'fons');
  fs.mkdirSync(otherFons, { recursive: true });
  register(root, B, other);
  const result = run(root, ['--session', B, 'from other']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(otherFons, `ideas-${B}.md`), 'utf8'), '- [ ] from other\n');
  assert.equal(fs.readFileSync(ideas, 'utf8'), '- [ ] local\n');
  assert.notEqual(run(root, ['-s', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'list']).status, 0);
});

test('implicit selection filters other workspaces before resolving the unique candidate', (t) => {
  const { root } = setup(t, '- [ ] local\n');
  register(root, B, path.join(root, 'other'));
  const result = run(root, ['list']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /local/);
});

test('default app data uses the temporary user home and FONS_APP_DATA overrides it exclusively', (t) => {
  const { root } = setup(t, '- [ ] from override\n');
  const defaultApp = path.join(root, 'home', '.gemini', 'antigravity');
  register(root, B, root, defaultApp);
  const bIdeas = path.join(root, '.agents', 'fons', `ideas-${B}.md`);
  fs.writeFileSync(bIdeas, '- [ ] from default\n');
  const fallback = run(root, ['list'], [], { FONS_APP_DATA: undefined });
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.match(fallback.stdout, /from default/);
  assert.doesNotMatch(fallback.stdout, /from override/);
  const override = run(root, ['list']);
  assert.equal(override.status, 0, override.stderr);
  assert.match(override.stdout, /from override/);
  assert.doesNotMatch(override.stdout, /from default/);
});

test('a batch of done tokens is all or nothing and preserves CRLF', (t) => {
  const { root, ideas } = setup(t, '- [ ] first\r\n- [ ] second\r\n');
  const [first, second] = tokens(root);
  const before = fs.readFileSync(ideas, 'utf8');
  const invalid = run(root, ['done', first, '0-invalid']);
  assert.notEqual(invalid.status, 0);
  assert.equal(fs.readFileSync(ideas, 'utf8'), before);
  const valid = run(root, ['done', first, second]);
  assert.equal(valid.status, 0, valid.stderr);
  const content = fs.readFileSync(ideas, 'utf8');
  assert.match(content, /【√】 first <!-- fons-ack:/);
  assert.match(content, /【√】 second <!-- fons-ack:/);
  assert.doesNotMatch(content, /(?<!\r)\n/);
  assert.doesNotMatch(run(root, ['list']).stdout, /first|second/);
});

test('legacy inbox without a lock blocks writes and leaves both legacy and session files intact', (t) => {
  const { root, ideas } = setup(t, '- [ ] current\n');
  const legacy = path.join(root, '.agents', 'fons', 'ideas.md');
  const ledger = path.join(root, '.agents', 'fons', '.state.json');
  fs.writeFileSync(legacy, '- [ ] legacy\n');
  fs.writeFileSync(ledger, '{"old":{}}');
  for (const args of [['extra'], ['list'], ['archive'], ['done', '0-invalid']]) {
    const result = run(root, args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Hook/);
  }
  assert.equal(fs.readFileSync(ideas, 'utf8'), '- [ ] current\n');
  assert.equal(fs.readFileSync(legacy, 'utf8'), '- [ ] legacy\n');
  assert.equal(fs.readFileSync(ledger, 'utf8'), '{"old":{}}');
});

test('a residual migration lock warns but permits reading and creating a session inbox', (t) => {
  const { root, ideas } = setup(t, '- [ ] current\n');
  const dir = path.join(root, '.agents', 'fons');
  const lock = path.join(dir, '.migration.lock');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: 99999999, startedAt: 1, step: 'publishing' }));
  fs.writeFileSync(path.join(dir, 'ideas.md'), '- [ ] legacy\n');
  const existing = run(root, ['list']);
  assert.equal(existing.status, 0, existing.stderr);
  assert.match(existing.stderr, /旧.*迁移|迁移.*旧/);
  assert.match(existing.stdout, /current/);
  fs.rmSync(ideas);
  const added = run(root, ['new session item']);
  assert.equal(added.status, 0, added.stderr);
  assert.match(added.stderr, /旧.*迁移|迁移.*旧/);
  assert.equal(fs.readFileSync(ideas, 'utf8'), '- [ ] new session item\n');
  assert.equal(fs.readFileSync(path.join(dir, 'ideas.md'), 'utf8'), '- [ ] legacy\n');
  assert.equal(fs.existsSync(lock), true);
});

test('an unindexed workspace with a legacy inbox is told to trigger Hook and leaves data intact', (t) => {
  const { root, ideas } = setup(t, '- [ ] current\n');
  const legacy = path.join(root, '.agents', 'fons', 'ideas.md');
  fs.writeFileSync(legacy, '- [ ] old\n');
  fs.rmSync(path.join(root, 'host', 'fons', 'conversations', `${A}.json`));
  const result = run(root, ['new item']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Hook/);
  assert.equal(fs.readFileSync(legacy, 'utf8'), '- [ ] old\n');
  assert.equal(fs.readFileSync(ideas, 'utf8'), '- [ ] current\n');
});

test('add output matches the normalized item stored for multiline input', (t) => {
  const { root, ideas } = setup(t, '');
  const result = run(root, ['- [ ] first\nsecond']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(ideas, 'utf8'), '- [ ] first second\n');
  assert.match(result.stdout, /first second/);
});

test('ambiguous candidate output renders the registration time as a readable date', (t) => {
  const { root } = setup(t, '');
  register(root, B, root);
  const result = run(root, ['list']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /1970-01-01/);
});
