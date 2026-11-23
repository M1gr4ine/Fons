import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runBridgeAction } from '../claude/pane-bridge.mjs';
import { holdEditing, lookupConversation, registerConversation } from '../scripts/fons-store.mjs';

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fons-claude-bridge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const appData = path.join(home, '.claude');
  const project = path.join(home, 'work');
  const sessionId = '55555555-5555-4555-8555-555555555505';
  const transcript = path.join(appData, 'projects', 'work', sessionId + '.jsonl');
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, '');
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: appData,
    CLAUDE_PROJECT_DIR: project, FONS_APP_DATA: undefined, FONS_ROOT: undefined,
    FONS_DEBOUNCE_SEC: undefined, FONS_STOP_WAIT_DEBOUNCE: undefined };
  const bridge = (action, payload = {}) => runBridgeAction({ action, payload: { sessionId, ...payload }, env, cwd: project });
  return { appData, project, sessionId, transcript, bridge, env };
}

test('register binds a unique main transcript and produces a usable session', async (t) => {
  const c = setup(t);
  const before = await c.bridge('snapshot');
  assert.equal(before.settings.canRegisterSession, true);
  const result = await c.bridge('pool', { op: 'register' });
  assert.equal(result.ok, true);
  assert.equal(result.snapshot.registered, true);
  assert.notEqual(result.snapshot.etag, before.etag);
  assert.equal(lookupConversation(c).transcriptPath, fs.realpathSync.native(c.transcript));
  assert.equal((await c.bridge('pool', { op: 'add', data: { texts: ['hello'] } })).snapshot.items[0].note, 'hello');
  assert.equal((await c.bridge('pool', { op: 'register' })).ok, true);
  const hook = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/fons-hook.mjs', import.meta.url)), '--host=claude'], {
    env: { ...c.env, FONS_DEBOUNCE_SEC: '0' }, cwd: c.project, encoding: 'utf8',
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: c.sessionId, transcript_path: c.transcript }),
  });
  assert.equal(hook.status, 0, hook.stderr);
  assert.match(JSON.parse(hook.stdout).hookSpecificOutput.additionalContext, /hello/);
});

test('registration refuses absent, ambiguous, disabled or foreign sessions', async (t) => {
  const c = setup(t);
  fs.rmSync(c.transcript);
  assert.equal((await c.bridge('snapshot')).settings.canRegisterSession, false);
  assert.equal((await c.bridge('pool', { op: 'register' })).ok, false);
  assert.equal((await c.bridge('snapshot', { sessionId: '../invalid' })).settings.canRegisterSession, false);
  const subagent = path.join(path.dirname(c.transcript), 'subagents', c.sessionId + '.jsonl');
  fs.mkdirSync(path.dirname(subagent));
  fs.writeFileSync(subagent, '');
  assert.equal((await c.bridge('snapshot')).settings.canRegisterSession, false);
  fs.writeFileSync(c.transcript, '');
  const second = path.join(c.appData, 'projects', 'other', c.sessionId + '.jsonl');
  fs.mkdirSync(path.dirname(second), { recursive: true });
  fs.writeFileSync(second, '');
  assert.equal((await c.bridge('snapshot')).settings.canRegisterSession, false);
  assert.equal((await c.bridge('pool', { op: 'register' })).ok, false);
  fs.rmSync(second);
  await c.bridge('pool', { op: 'settings', data: { update: { workspaceAction: { path: c.project, mode: 'disable' } } } });
  assert.equal((await c.bridge('snapshot')).settings.canRegisterSession, false);
  assert.equal((await c.bridge('pool', { op: 'register' })).ok, false);
  await c.bridge('pool', { op: 'settings', data: { update: { workspaceAction: { path: c.project, mode: 'enable' } } } });
  registerConversation({ appData: c.appData, sessionId: c.sessionId, host: 'codex', rootDir: c.project });
  assert.equal((await c.bridge('snapshot')).settings.canRegisterSession, false);
  assert.equal((await c.bridge('pool', { op: 'register' })).ok, false);
  assert.equal(lookupConversation(c).host, 'codex');
});

test('register supports a session without a workspace', async (t) => {
  const c = setup(t);
  const env = { ...c.env, CLAUDE_PROJECT_DIR: c.env.HOME };
  const result = await runBridgeAction({ action: 'pool', payload: { sessionId: c.sessionId, op: 'register' }, env, cwd: c.env.HOME });
  assert.equal(result.ok, true);
  assert.equal(result.snapshot.scope, 'no-workspace');
  assert.equal(lookupConversation(c).rootDir, null);
});

test('snapshot etag covers settings and holds while ignoring elapsed countdown', async (t) => {
  const c = setup(t);
  const first = await c.bridge('snapshot');
  const setting = await c.bridge('pool', { op: 'settings', data: { update: { stopWaitDebounce: true } } });
  assert.notEqual(setting.snapshot.etag, first.etag);
  const registered = await c.bridge('pool', { op: 'register' });
  const added = await c.bridge('pool', { op: 'add', data: { texts: ['pending'] } });
  assert.notEqual(registered.snapshot.etag, added.snapshot.etag);
  await new Promise((resolve) => setTimeout(resolve, 35));
  const later = await c.bridge('snapshot');
  assert.ok(later.items[0].remainingMs < added.snapshot.items[0].remainingMs);
  assert.equal(later.etag, added.snapshot.etag);
  const held = await c.bridge('pool', { op: 'hold', data: { id: later.items[0].id } });
  assert.notEqual(held.snapshot.etag, later.etag);
  const released = await c.bridge('pool', { op: 'release', data: { id: later.items[0].id } });
  assert.notEqual(released.snapshot.etag, held.snapshot.etag);
  assert.notEqual(released.snapshot.etag, later.etag);
  const updated = await c.bridge('pool', { op: 'settings', data: { update: { autoAttachWorkspaces: false } } });
  assert.notEqual(updated.snapshot.etag, released.snapshot.etag);
});

test('etag reflects expiration of an editing hold without a file write', async (t) => {
  const c = setup(t);
  await c.bridge('pool', { op: 'register' });
  const added = await c.bridge('pool', { op: 'add', data: { texts: ['pending'] } });
  const now = Date.now();
  holdEditing({ rootDir: c.project, sessionId: c.sessionId, id: added.snapshot.items[0].id, now: now - 10_000 });
  const held = await c.bridge('snapshot');
  assert.equal(held.items[0].editingHold, true);
  const realNow = Date.now;
  try {
    Date.now = () => now + 6_000;
    const expired = await c.bridge('snapshot');
    assert.equal(expired.items[0].editingHold, false);
    assert.notEqual(expired.etag, held.etag);
  } finally {
    Date.now = realNow;
  }
});
