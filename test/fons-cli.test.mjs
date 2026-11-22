import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../scripts/fons-cli.mjs', import.meta.url));
const fonsBin = fileURLToPath(new URL(process.platform === 'win32' ? '../bin/fons.cmd' : '../bin/fons', import.meta.url));
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
    HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
    CODEX_HOME: undefined, FONS_HOST: '', FONS_SESSION: '', ...overrides };
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

test('multiple indexed sessions require selection and show candidate IDs, titles and dates', (t) => {
  const { root } = setup(t, '- [ ] A item\n');
  register(root, B, root);
  const index = path.join(root, 'host', 'fons', 'conversations', B + '.json');
  fs.writeFileSync(index, JSON.stringify({ rootDir: root, title: '第二会话', registeredAt: 1 }));
  const result = run(root, ['list']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /第二会话/);
  assert.match(result.stderr, /1970-01-01/);
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

test('add output matches the normalized item stored for multiline input', (t) => {
  const { root, ideas } = setup(t, '');
  const result = run(root, ['- [ ] first\nsecond']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(ideas, 'utf8'), '- [ ] first second\n');
  assert.match(result.stdout, /first second/);
});

test('bin/fons launcher handles usage/help, subdirectory root lookup, and rejects panel options on non-panel commands', (t) => {
  const { root } = setup(t, '- [ ] parent item\n');
  const subDir = path.join(root, 'src', 'nested');
  fs.mkdirSync(subDir, { recursive: true });
  const env = {
    ...process.env,
    FONS_ROOT: '',
    FONS_APP_DATA: path.join(root, 'host'),
    HOME: path.join(root, 'home'),
    USERPROFILE: path.join(root, 'home'),
    FONS_HOST: '',
    FONS_SESSION: '',
  };
  const invokeBin = (args, cwd = root) => (
    process.platform === 'win32'
      ? spawnSync('cmd.exe', ['/c', fonsBin, ...args], { cwd, encoding: 'utf8', env })
      : spawnSync(fonsBin, args, { cwd, encoding: 'utf8', env })
  );

  const noArg = invokeBin([]);
  assert.equal(noArg.status, 1);
  assert.match(noArg.stderr, /用法:/);

  const helpRes = invokeBin(['help']);
  assert.equal(helpRes.status, 0, helpRes.stderr);
  assert.match(helpRes.stdout, /fons.*archive/);

  const nestedList = invokeBin(['list'], subDir);
  assert.equal(nestedList.status, 0, nestedList.stderr);
  assert.match(nestedList.stdout, /1\. parent item/);

  const badPort = run(root, ['--port', '8080', 'sessions']);
  assert.notEqual(badPort.status, 0);
  assert.match(badPort.stderr, /--port/);
});

test('CLI supports no-workspace sessions via -s and --no-workspace without leaking into workspace lookups', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fons-cli-nows-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appData = path.join(root, 'host');
  const indexDir = path.join(appData, 'fons', 'conversations');
  fs.mkdirSync(indexDir, { recursive: true });
  fs.writeFileSync(path.join(indexDir, `${A}.json`), JSON.stringify({ scope: 'no-workspace', rootDir: null, title: '自由问答', registeredAt: 1 }));

  // Normal workspace lookup never falls back to no-workspace sessions
  const implicit = run(root, ['list']);
  assert.notEqual(implicit.status, 0);
  assert.match(implicit.stderr, /开启会话/);

  // Explicit --no-workspace / -n and -s operate on <appData>/fons/no-workspace
  const added = run(root, ['--no-workspace', '无工作区灵感一']);
  assert.equal(added.status, 0, added.stderr);
  assert.equal(fs.existsSync(path.join(root, '.agents')), false);
  const noWsIdeas = path.join(appData, 'fons', 'no-workspace', `ideas-${A}.md`);
  assert.equal(fs.readFileSync(noWsIdeas, 'utf8'), '- [ ] 无工作区灵感一\n');

  const listed = run(root, ['-s', A, 'list']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /无工作区灵感一/);
  const token = /\[([0-9]+-[a-f0-9]{64})\]/.exec(listed.stdout)[1];

  // Explicit -n overrides FONS_SESSION
  const completed = run(root, ['-n', 'done', token], [], { FONS_SESSION: B });
  assert.equal(completed.status, 0, completed.stderr);
  const archived = run(root, ['--no-workspace', 'archive']);
  assert.equal(archived.status, 0, archived.stderr);
  assert.equal(fs.existsSync(noWsIdeas), false);
  assert.match(fs.readFileSync(path.join(appData, 'fons', 'no-workspace', 'archive', `${A}.md`), 'utf8'), /无工作区灵感一/);

  // Mutual exclusion between -s and --no-workspace
  const conflict = run(root, ['-s', A, '--no-workspace', 'list']);
  assert.notEqual(conflict.status, 0);
  assert.match(conflict.stderr, /不能同时指定/);

  // Multiple no-workspace sessions require -s
  fs.writeFileSync(path.join(indexDir, `${B}.json`), JSON.stringify({ scope: 'no-workspace', rootDir: null, title: '第二自由会话', registeredAt: 2 }));
  const ambiguous = run(root, ['--no-workspace', 'list']);
  assert.equal(ambiguous.status, 2);
  assert.match(ambiguous.stderr, /第二自由会话/);
  assert.match(ambiguous.stderr, new RegExp(A));
  assert.match(ambiguous.stderr, new RegExp(B));
});

test('CLI -a / --attach stores attachments, supports pure-attachment items, and formats list output', (t) => {
  const { root } = setup(t, '');
  const imgFile = path.join(root, 'ui-shot.png');
  const docFile = path.join(root, 'notes.md');
  fs.writeFileSync(imgFile, Buffer.from('png-bytes'));
  fs.writeFileSync(docFile, '# Ref\n', 'utf8');

  const mixed = run(root, ['-a', imgFile, `--attach=${docFile}`, '核对边距']);
  assert.equal(mixed.status, 0, mixed.stderr);
  assert.match(mixed.stdout, /核对边距 \[附件: ui-shot\.png, notes\.md\]/);

  const pure = run(root, ['-a', imgFile]);
  assert.equal(pure.status, 0, pure.stderr);
  assert.match(pure.stdout, /\[附件: ui-shot\.png\]/);

  const listed = run(root, ['list']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /1\. 核对边距 \[附件: ui-shot\.png, notes\.md\]/);
  assert.match(listed.stdout, /2\. \[附件: ui-shot\.png\]/);

  assert.notEqual(run(root, ['-a', path.join(root, 'missing.png'), 'bad']).status, 0);
  assert.notEqual(run(root, ['-a', imgFile, 'list']).status, 0);
});

function registerCodex(appData, sessionId, entry) {
  const index = path.join(appData, 'fons', 'conversations');
  fs.mkdirSync(index, { recursive: true });
  fs.writeFileSync(path.join(index, sessionId + '.json'), JSON.stringify({
    host: 'codex', title: 'Codex 会话', registeredAt: 2, ...entry,
  }));
}

test('CLI finds both hosts and requires explicit selection before writing', (t) => {
  const { root, ideas } = setup(t, '- [ ] AG item\n');
  const antigravityData = path.join(root, 'home', '.gemini', 'antigravity');
  const codexData = path.join(root, 'Codex home');
  const env = { FONS_APP_DATA: undefined, CODEX_HOME: codexData };
  register(root, A, root, antigravityData);
  registerCodex(codexData, B, { rootDir: root });
  const bIdeas = path.join(root, '.agents', 'fons', `ideas-${B}.md`);
  const ambiguous = run(root, ['new item'], [], env);
  assert.equal(ambiguous.status, 2, ambiguous.stderr);
  assert.match(ambiguous.stderr, new RegExp(`\\[antigravity\\]\\s+${A}`));
  assert.match(ambiguous.stderr, new RegExp(`\\[codex\\]\\s+${B}.*Codex 会话.*1970-01-01`));
  assert.match(ambiguous.stderr, /--host/);
  assert.equal(fs.existsSync(bIdeas), false);

  const sessions = run(root, ['sessions'], [], env);
  assert.equal(sessions.status, 0, sessions.stderr);
  assert.match(sessions.stdout, new RegExp(B));
  assert.match(sessions.stdout, new RegExp(A));

  const added = run(root, ['--host=codex', 'from Codex'], [], { ...env, FONS_HOST: 'antigravity' });
  assert.equal(added.status, 0, added.stderr);
  assert.equal(fs.readFileSync(bIdeas, 'utf8'), '- [ ] from Codex\n');
  assert.equal(fs.readFileSync(ideas, 'utf8'), '- [ ] AG item\n');

  const selected = run(root, ['list'], [], { ...env, FONS_HOST: 'codex' });
  assert.equal(selected.status, 0, selected.stderr);
  assert.match(selected.stdout, /from Codex/);
});

test('an explicit ID shared by two host indexes also requires a host', (t) => {
  const { root } = setup(t, '- [ ] AG item\n');
  const antigravityData = path.join(root, 'home', '.gemini', 'antigravity');
  const codexData = path.join(root, 'Codex home');
  const other = path.join(root, 'another workspace');
  fs.mkdirSync(other);
  const env = { FONS_APP_DATA: undefined, CODEX_HOME: codexData };
  register(root, A, root, antigravityData);
  registerCodex(codexData, A, { rootDir: other });
  const ambiguous = run(root, ['list', '-s', A], [], env);
  assert.equal(ambiguous.status, 2, ambiguous.stderr);
  assert.match(ambiguous.stderr, /\[codex\]/);
  assert.match(ambiguous.stderr, /\[antigravity\]/);
  const added = run(root, ['-s', A, '--host', 'codex', 'from Codex'], [], env);
  assert.equal(added.status, 0, added.stderr);
  assert.equal(fs.readFileSync(path.join(other, '.agents', 'fons', `ideas-${A}.md`), 'utf8'), '- [ ] from Codex\n');
});

test('CODEX_HOME and FONS_APP_DATA resolve isolated no-workspace indexes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fons-cli-codex-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexData = path.join(root, 'custom Codex home');
  registerCodex(codexData, A, { scope: 'no-workspace', rootDir: null });
  const defaultEnv = { FONS_APP_DATA: undefined, CODEX_HOME: codexData };
  const missing = run(root, ['--host', 'codex', 'list'], [], defaultEnv);
  assert.equal(missing.status, 2, missing.stderr);
  assert.match(missing.stderr, /Codex/);
  const added = run(root, ['-n', 'standalone idea'], [], { ...defaultEnv, FONS_SESSION: B });
  assert.equal(added.status, 0, added.stderr);
  const inbox = path.join(codexData, 'fons', 'no-workspace', `ideas-${A}.md`);
  assert.equal(fs.readFileSync(inbox, 'utf8'), '- [ ] standalone idea\n');
  assert.equal(fs.existsSync(path.join(root, '.agents')), false);
  const hidden = run(root, ['-n', '--host', 'codex', 'sessions'], [], { CODEX_HOME: codexData });
  assert.equal(hidden.status, 2, hidden.stderr);
});

test('Codex workspace selection sees a .codex marker from a child directory', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fons-cli-codex-workspace-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appData = path.join(root, 'host');
  registerCodex(appData, A, { rootDir: root });
  fs.mkdirSync(path.join(root, '.codex'));
  const subdir = path.join(root, 'child');
  fs.mkdirSync(subdir);
  const env = { FONS_ROOT: undefined, FONS_APP_DATA: appData };
  const added = run(subdir, ['new idea'], [], env);
  assert.equal(added.status, 0, added.stderr);
  const listed = run(subdir, ['--host', 'codex', 'list'], [], env);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /new idea/);
});
