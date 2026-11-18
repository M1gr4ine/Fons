import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../scripts/fons-cli.mjs', import.meta.url));

function setup(t, content) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fons-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, '.agents', 'fons');
  fs.mkdirSync(dir, { recursive: true });
  const ideas = path.join(dir, 'ideas.md');
  fs.writeFileSync(ideas, content, 'utf8');
  return { root, ideas, archive: path.join(dir, 'archive.md') };
}

function run(root, args, nodeArgs = []) {
  return spawnSync(process.execPath, [...nodeArgs, cli, ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, FONS_ROOT: root },
  });
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
  fs.writeFileSync(shim, `const fs = require('node:fs');\nconst old = fs.appendFileSync;\nfs.appendFileSync = function(p, ...args) { if (String(p).endsWith('ideas.md')) old.call(fs, p, '- [ ] concurrent\\n'); return old.call(fs, p, ...args); };\n`);
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
  const { root, ideas } = setup(t, '【√】 first\n');
  const shim = path.join(root, 'archive-append.cjs');
  fs.writeFileSync(shim, `const fs = require('node:fs');\nconst old = fs.appendFileSync;\nfs.appendFileSync = function(p, ...args) { if (String(p).endsWith('archive.md')) old.call(fs, ${JSON.stringify(ideas)}, '- [ ] concurrent\\n'); return old.call(fs, p, ...args); };\n`);
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
  assert.equal(fs.readFileSync(ideas, 'utf8'), '');
  assert.equal(fs.readFileSync(archive, 'utf8'), '【√】 first\n');
});
