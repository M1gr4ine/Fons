import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  lookupConversation, registerConversation, sessionPaths,
} from '../scripts/fons-store.mjs';
import { mountPoolRoutes } from '../sidecars/fons-pool/main.mjs';

const SESSION = '12345678-1234-7234-8234-123456789aaa';
const OTHER = '12345678-1234-7234-8234-123456789bbb';
const ATTACHMENT = 'preview-12345678.png';

function setup(t, scope = 'workspace') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fons-bound-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appData = path.join(root, 'host');
  const rootDir = scope === 'workspace' ? root : null;
  registerConversation({ appData, sessionId: SESSION, rootDir, scope, host: 'codex' });
  const boundSession = { ...lookupConversation({ appData, sessionId: SESSION }), appData, sessionId: SESSION };
  const paths = sessionPaths(boundSession);
  return { root, rootDir, appData, boundSession, paths };
}

function mount(ctx, boundSession = ctx.boundSession) {
  const routes = new Map();
  const app = {
    page() {},
    api(url, handler, method) { routes.set(method + ' ' + url, handler); },
  };
  mountPoolRoutes(app, ctx.appData, { boundSession });
  return (action = '', data = {}) => routes.get('POST /api/pool' + (action ? '/' + action : ''))(data);
}

function writeAttachment(paths, name = ATTACHMENT) {
  fs.mkdirSync(paths.attachmentsDir, { recursive: true });
  fs.writeFileSync(path.join(paths.attachmentsDir, name), 'preview bytes');
  fs.writeFileSync(paths.ideas, '- [ ] [preview](attachments/' + SESSION + '/' + name + ')\n');
}

test('bound routes refuse a different registered session and keep their fixed scope', (t) => {
  const ctx = setup(t);
  const otherRoot = path.join(ctx.root, 'elsewhere');
  fs.mkdirSync(otherRoot);
  registerConversation({ appData: ctx.appData, sessionId: OTHER, rootDir: otherRoot, host: 'codex' });
  const call = mount(ctx);
  assert.equal(call('add', { conversationId: OTHER, texts: ['wrong'] }).status, 403);
  assert.equal(call('', { workspaceUris: [pathToFileURL(otherRoot).href] }).status, 409);
  assert.equal(call('add', { workspaceUris: [], texts: ['wrong'] }).status, 409);
  assert.equal(call('', { workspaceUris: 'bad' }).status, 400);
  assert.equal(fs.existsSync(ctx.paths.ideas), false);

  const workspaceUris = [pathToFileURL(ctx.root).href];
  const result = call('add', { conversationId: SESSION, workspaceUris, texts: ['safe'], fonsDir: otherRoot, sessionId: OTHER });
  assert.equal(result.count, 1);
  assert.deepEqual(call().items.map(({ text }) => text), ['safe']);
  assert.deepEqual(fs.readdirSync(otherRoot), []);
});

test('bound mounting rejects a server session with no matching registration', (t) => {
  const ctx = setup(t);
  assert.throws(() => mount(ctx, { ...ctx.boundSession, sessionId: OTHER }), /会话/);
  assert.throws(() => mount(ctx, { ...ctx.boundSession, rootDir: ctx.appData }), /会话/);
});

test('no-workspace bound routes use the session appData even if supplied paths differ', (t) => {
  const ctx = setup(t, 'no-workspace');
  const call = mount(ctx);
  assert.equal(call('', { workspaceUris: [pathToFileURL(ctx.root).href] }).status, 409);
  const added = call('add', { workspaceUris: [], texts: ['isolated'], rootDir: ctx.root });
  assert.equal(added.count, 1);
  assert.equal(fs.readFileSync(ctx.paths.ideas, 'utf8'), '- [ ] isolated\n');
  assert.equal(fs.existsSync(path.join(ctx.root, '.agents')), false);
});

test('bound attachment reads serve session attachments and reject traversal names', (t) => {
  const ctx = setup(t);
  const call = mount(ctx);
  assert.equal(call('attachment', { storedName: ATTACHMENT }).status, 404);
  assert.equal(call('attachment', { storedName: '../' + ATTACHMENT }).status, 400);
  writeAttachment(ctx.paths);
  const expected = {
    storedName: ATTACHMENT,
    mimeType: 'image/png',
    size: Buffer.byteLength('preview bytes'),
    dataBase64: Buffer.from('preview bytes').toString('base64'),
  };
  assert.deepEqual(call('attachment', { storedName: ATTACHMENT }), expected);
  const [{ token }] = call().items;
  assert.equal(call('complete', { token }).count, 1);
  assert.equal(call('archive').count, 1);
  assert.equal(fs.existsSync(ctx.paths.ideas), false);
  assert.deepEqual(call('attachment', { storedName: ATTACHMENT }), expected);
});

test('bound settings route updates config, enforces session isolation, and respects disabled workspaces', (t) => {
  const ctx = setup(t);
  const call = mount(ctx);
  const workspaceUris = [pathToFileURL(ctx.root).href];

  assert.equal(call('settings', { conversationId: OTHER }).status, 403);
  const initial = call('settings', { workspaceUris });
  assert.equal(initial.sessionRegistered, true);
  assert.equal(initial.canRegisterSession, false);
  assert.equal(initial.currentWorkspace.enabled, true);

  const saved = call('settings', { workspaceUris, update: { debounceSec: 0, stopWaitDebounce: true } });
  assert.equal(saved.config.debounceSec, 0);
  assert.equal(saved.config.stopWaitDebounce, true);

  call('settings', { workspaceUris, update: { workspaceAction: { path: ctx.root, mode: 'disable' } } });
  assert.deepEqual(call('', { workspaceUris }), { registered: true, workspaceDisabled: true, scope: 'workspace' });
  assert.equal(call('add', { workspaceUris, texts: ['blocked'] }).status, 409);

  call('settings', { workspaceUris, update: { workspaceAction: { path: ctx.root, mode: 'enable' } } });
  assert.equal(call('', { workspaceUris }).registered, true);
});
