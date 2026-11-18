import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function fixture(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fons-sidecar-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  return { rootDir, appData: path.join(rootDir, 'host') };
}

function appFixture() {
  const routes = new Map();
  const app = {
    config: { conversationId: SESSION },
    api(route, handler, method) { routes.set(`${method} ${route}`, handler); },
    page() {},
  };
  return { app, routes };
}

test('the Sidecar reports an unregistered current session without requiring the SDK', async (t) => {
  const { appData } = fixture(t);
  const { app, routes } = appFixture();
  let sidecar;
  try { sidecar = await import('../sidecars/fons-pool/main.mjs'); }
  catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
  assert.equal(typeof sidecar?.mountPoolRoutes, 'function', 'Sidecar exports its route mount without loading the SDK');
  sidecar.mountPoolRoutes(app, appData);
  assert.equal(routes.has('GET /api/pool'), false);
  assert.deepEqual(await routes.get('POST /api/pool')({ conversationId: SESSION }), { registered: false });
});

const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

async function mounted(t) {
  const env = fixture(t);
  const { app, routes } = appFixture();
  const { mountPoolRoutes } = await import('../sidecars/fons-pool/main.mjs');
  await mountPoolRoutes(app, env.appData);
  return { ...env, app, routes };
}

function route(ctx, method, url, payload = {}) {
  const handler = ctx.routes.get(`${method} ${url}`);
  assert.equal(typeof handler, 'function', `missing ${method} ${url}`);
  return handler(payload);
}

function post(ctx, action, payload = {}) {
  return route(ctx, 'POST', `/api/pool/${action}`, { conversationId: SESSION, ...payload });
}

async function register(ctx, sessionId = SESSION, rootDir = ctx.rootDir) {
  const { registerConversation } = await import('../scripts/fons-store.mjs');
  registerConversation({ appData: ctx.appData, sessionId, rootDir, title: 'test' });
}

async function read(ctx, payload = {}) {
  return route(ctx, 'POST', '/api/pool', { conversationId: SESSION, ...payload });
}

test('request IDs must be explicit valid UUIDs', async (t) => {
  const ctx = await mounted(t);
  await register(ctx);
  for (const conversationId of [undefined, '', '../escape', 'CON']) {
    assert.equal((await read(ctx, { conversationId })).status, 400);
    for (const action of ['add', 'complete', 'update', 'remove', 'reopen', 'flush', 'archive']) {
      assert.equal((await post(ctx, action, { conversationId })).status, 400);
    }
  }
  assert.equal(fs.existsSync(path.join(ctx.rootDir, '.agents')), false);
});

test('the indexed root and requested conversation override client path and session fields', async (t) => {
  const ctx = await mounted(t);
  await register(ctx);
  const otherRoot = path.join(ctx.rootDir, 'attacker');
  await post(ctx, 'add', { texts: ['safe'], rootDir: otherRoot, sessionId: OTHER, ideasPath: path.join(otherRoot, 'x') });
  const snapshot = await read(ctx, { conversationId: SESSION, rootDir: otherRoot, sessionId: OTHER });
  assert.deepEqual(snapshot.items.map((item) => item.text), ['safe']);
  const ideas = path.join(ctx.rootDir, '.agents', 'fons', `ideas-${SESSION}.md`);
  assert.equal(fs.readFileSync(ideas, 'utf8'), '- [ ] safe\n');
  assert.equal(fs.existsSync(otherRoot), false);
  assert.equal(fs.existsSync(path.join(ctx.rootDir, '.agents', 'fons', `ideas-${OTHER}.md`)), false);
});

test('etag reports unchanged snapshots and changes after a write', async (t) => {
  const ctx = await mounted(t);
  await register(ctx);
  const first = await read(ctx);
  assert.ok(first.etag);
  assert.equal(first.migrationWarning, null);
  assert.deepEqual(await read(ctx, { etag: first.etag }), { unchanged: true, etag: first.etag });
  await post(ctx, 'add', { texts: ['new'] });
  const next = await read(ctx, { etag: first.etag });
  assert.equal(next.unchanged, undefined);
  assert.notEqual(next.etag, first.etag);
  assert.deepEqual(next.items.map((item) => item.text), ['new']);
});

test('route operations add, complete, reopen, edit, remove, flush and archive the current inbox', async (t) => {
  const ctx = await mounted(t);
  await register(ctx);
  await post(ctx, 'add', { texts: ['one', 'two'] });
  let snapshot = await read(ctx);
  const one = snapshot.items.find((item) => item.text === 'one');
  await post(ctx, 'complete', { token: one.token });
  snapshot = await read(ctx);
  const done = snapshot.items.find((item) => item.text === 'one');
  assert.equal(done.status, 'done');
  await post(ctx, 'reopen', { rowIndex: done.rowIndex, expectedRaw: done.raw });
  snapshot = await read(ctx);
  const reopened = snapshot.items.find((item) => item.text === 'one');
  assert.equal(reopened.status, 'buffering');
  await post(ctx, 'update', { rowIndex: reopened.rowIndex, expectedRaw: reopened.raw, newText: 'edited' });
  snapshot = await read(ctx);
  assert.deepEqual(snapshot.items.map((item) => item.text), ['edited', 'two']);
  const two = snapshot.items.find((item) => item.text === 'two');
  await post(ctx, 'remove', { rowIndex: two.rowIndex, expectedRaw: two.raw });
  await post(ctx, 'flush');
  snapshot = await read(ctx);
  assert.equal(snapshot.flushPending, true);
  assert.deepEqual(snapshot.items.map((item) => item.text), ['edited']);
  await post(ctx, 'complete', { token: snapshot.items[0].token });
  await post(ctx, 'archive');
  assert.equal(fs.existsSync(path.join(ctx.rootDir, '.agents', 'fons', `ideas-${SESSION}.md`)), false);
  assert.match(fs.readFileSync(path.join(ctx.rootDir, '.agents', 'fons', 'archive', `${SESSION}.md`), 'utf8'), /edited/);
});

test('a stale row update surfaces conflict and leaves the current text intact', async (t) => {
  const ctx = await mounted(t);
  await register(ctx);
  await post(ctx, 'add', { texts: ['initial'] });
  const original = (await read(ctx)).items[0];
  await post(ctx, 'update', { rowIndex: original.rowIndex, expectedRaw: original.raw, newText: 'new' });
  const conflict = await post(ctx, 'update', { rowIndex: original.rowIndex, expectedRaw: original.raw, newText: 'stale' });
  assert.equal(conflict.conflict, true);
  assert.deepEqual((await read(ctx)).items.map((item) => item.text), ['new']);
});

test('a retained migration lock is visible even with an unchanged data etag and new items remain usable', async (t) => {
  const ctx = await mounted(t);
  await register(ctx);
  const before = await read(ctx);
  const lock = path.join(ctx.rootDir, '.agents', 'fons', '.migration.lock');
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: 99999999, startedAt: 1, step: 'publishing' }));
  const warned = await read(ctx, { etag: before.etag });
  assert.equal(warned.migrationWarning.status, 'interrupted');
  await post(ctx, 'add', { texts: ['new item'] });
  const after = await read(ctx);
  assert.equal(after.migrationWarning.status, 'interrupted');
  assert.deepEqual(after.items.map((item) => item.text), ['new item']);
  assert.equal(fs.existsSync(lock), true);
});


test('mutation routes reject malformed payloads without changing the inbox', async (t) => {
  const ctx = await mounted(t);
  await register(ctx);
  const invalid = [
    ['add', { texts: 'not an array' }],
    ['complete', { token: 'invalid' }],
    ['update', { rowIndex: -1, expectedRaw: '', newText: 'bad' }],
    ['remove', { rowIndex: 0, expectedRaw: null }],
    ['reopen', { rowIndex: 0, expectedRaw: null }],
  ];
  for (const [action, payload] of invalid) {
    const response = await post(ctx, action, payload);
    assert.equal(response.status, 400);
    assert.equal(response.contentType, 'application/json');
    assert.ok(JSON.parse(response.body).error);
  }
  assert.deepEqual((await read(ctx)).items, []);
  assert.equal(fs.existsSync(path.join(ctx.rootDir, '.agents')), false);
});

test('unregistered sessions cannot create data through any mutation route', async (t) => {
  const ctx = await mounted(t);
  for (const action of ['add', 'complete', 'update', 'remove', 'reopen', 'flush', 'archive']) {
    const response = await post(ctx, action, {});
    assert.equal(response.status, 404);
    assert.match(JSON.parse(response.body).error, /尚未.*登记/);
  }
  assert.deepEqual(await read(ctx), { registered: false });
  assert.equal(fs.existsSync(path.join(ctx.rootDir, '.agents')), false);
});

test('explicit page UUID selects registered data despite process conversation ID', async (t) => {
  const ctx = await mounted(t);
  await register(ctx);
  await register(ctx, OTHER);
  ctx.app.config.conversationId = SESSION;
  await Promise.all([
    post(ctx, 'add', { conversationId: SESSION, texts: ['A'] }),
    post(ctx, 'add', { conversationId: OTHER, texts: ['B'] }),
  ]);
  const [a, b] = await Promise.all([
    read(ctx, { conversationId: SESSION }),
    read(ctx, { conversationId: OTHER }),
  ]);
  assert.deepEqual(a.items.map((item) => item.text), ['A']);
  assert.deepEqual(b.items.map((item) => item.text), ['B']);
  ctx.app.config.conversationId = undefined;
  assert.deepEqual((await read(ctx, { conversationId: OTHER })).items.map((item) => item.text), ['B']);
  assert.equal(ctx.routes.has('GET /api/pool'), false);
});

test('a missing host data directory is distinguished from an unregistered conversation', async () => {
  const { app, routes } = appFixture();
  const { mountPoolRoutes } = await import('../sidecars/fons-pool/main.mjs');
  mountPoolRoutes(app, undefined);
  const response = await routes.get('POST /api/pool')({ conversationId: SESSION });
  assert.equal(response.status, 503);
  assert.match(JSON.parse(response.body).error, /宿主数据目录/);
});

const sdkDirectory = path.join(os.homedir(), '.gemini', 'antigravity', 'lib', 'node_modules', 'sidecar_sdk');
const sdkIndex = path.join(sdkDirectory, 'index.mjs');
const sdkLoader = path.join(sdkDirectory, 'register_loader.js');
const mainPath = path.resolve('sidecars/fons-pool/main.mjs');
const syntheticEnv = {
  ANTIGRAVITY_LS_ADDRESS: 'synthetic', ANTIGRAVITY_CSRF_TOKEN: 'synthetic',
  ANTIGRAVITY_SIDECAR_WEB_PORT: '0',
};

test('entry point fails closed when the host UI token is missing', { skip: !fs.existsSync(sdkLoader) }, () => {
  const child = spawnSync(process.execPath, ['--import', pathToFileURL(sdkLoader).href, mainPath], {
    env: syntheticEnv, encoding: 'utf8', timeout: 2000,
  });
  assert.equal(child.signal, null, 'process should exit without waiting for a timeout');
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /ANTIGRAVITY_SIDECAR_UI_TOKEN/);
});

test('SDK rejects missing and invalid tokens for every data route', { skip: !fs.existsSync(sdkIndex) }, (t) => {
  const { rootDir, appData } = fixture(t);
  const source = `
    import assert from 'node:assert/strict';
    const { SidecarApp } = await import(process.argv[1]);
    const { mountPoolRoutes } = await import(process.argv[2]);
    const { registerConversation } = await import(process.argv[3]);
    const [rootDir, appData, sessionId, otherId] = process.argv.slice(4);
    registerConversation({ rootDir, appData, sessionId, title: 'test' });
    registerConversation({ rootDir, appData, sessionId: otherId, title: 'other' });
    const app = new SidecarApp();
    mountPoolRoutes(app, appData);
    const server = await app.run();
    try {
      const base = 'http://127.0.0.1:' + server.address().port;
      for (const route of ['/api/pool', ...['add','complete','update','remove','reopen','flush','archive'].map(x => '/api/pool/' + x)]) {
        for (const token of [null, 'incorrect']) {
          const headers = { 'Content-Type': 'application/json' };
          if (token) headers['X-Sidecar-Token'] = token;
          const response = await fetch(base + route, { method: 'POST', headers, body: JSON.stringify({ conversationId: sessionId }) });
          assert.equal(response.status, 401, route);
        }
        const get = await fetch(base + route);
        assert.equal(get.status, 405, route);
      }
      const response = await fetch(base + '/api/pool', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sidecar-Token': 'synthetic-token' },
        body: JSON.stringify({ conversationId: sessionId })
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).registered, true);
      const send = (route, data) => fetch(base + route, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sidecar-Token': 'synthetic-token' },
        body: JSON.stringify(data)
      });
      const writes = await Promise.all([
        send('/api/pool/add', { conversationId: sessionId, texts: ['A'] }),
        send('/api/pool/add', { conversationId: otherId, texts: ['B'] }),
      ]);
      for (const write of writes) assert.equal(write.status, 200);
      const reads = await Promise.all([sessionId, otherId].map(conversationId => send('/api/pool', { conversationId })));
      const snapshots = await Promise.all(reads.map(read => read.json()));
      assert.deepEqual(snapshots.map(snapshot => snapshot.items.map(item => item.text)), [['A'], ['B']]);
    } finally { await app.close(); }
  `;
  const child = spawnSync(process.execPath, [
    '--input-type=module', '-e', source, pathToFileURL(sdkIndex).href,
    pathToFileURL(mainPath).href, pathToFileURL(path.resolve('scripts/fons-store.mjs')).href,
    rootDir, appData, SESSION, OTHER,
  ], { env: { ...syntheticEnv, ANTIGRAVITY_SIDECAR_UI_TOKEN: 'synthetic-token' }, encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
});
