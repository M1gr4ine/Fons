import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evaluateHook } from '../scripts/fons-hook.mjs';
import { openPanelUrl, startPanelServer } from '../scripts/fons-panel.mjs';
import { readFonsPanelHtml } from '../scripts/fons-panel-ui.mjs';

const CLI = fileURLToPath(new URL('../scripts/fons-cli.mjs', import.meta.url));
const SESSION_A = 'aaaa0001-1111-4111-8111-111111111111';
const SESSION_B = 'bbbb0002-2222-4222-8222-222222222222';

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fons-panel-server-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const claudeHome = path.join(root, 'claude-home');
  const workspace = path.join(root, 'workspace');
  const home = path.join(root, 'user-home');
  fs.mkdirSync(path.join(workspace, '.claude'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  const oldClaudeDir = process.env.CLAUDE_CONFIG_DIR;
  const oldProjectDir = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  delete process.env.CLAUDE_PROJECT_DIR;
  t.after(() => {
    restoreEnv('CLAUDE_CONFIG_DIR', oldClaudeDir);
    restoreEnv('CLAUDE_PROJECT_DIR', oldProjectDir);
  });

  const env = {
    CLAUDE_CONFIG_DIR: claudeHome,
    HOME: home,
    USERPROFILE: home,
    FONS_APP_DATA: '',
    FONS_ROOT: '',
    FONS_HOST: '',
    FONS_SESSION: '',
  };

  function transcriptFor(sessionId) {
    const file = path.join(claudeHome, 'projects', 'ws', sessionId + '.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    return file;
  }

  function startSession(sessionId, title) {
    const transcript_path = transcriptFor(sessionId);
    evaluateHook({
      hook_event_name: 'SessionStart',
      session_id: sessionId,
      cwd: workspace,
      transcript_path,
      source: 'startup',
      session_title: title,
    }, 'all', 'claude');
    return transcript_path;
  }

  function endSession(sessionId, transcript_path) {
    evaluateHook({
      hook_event_name: 'SessionEnd',
      session_id: sessionId,
      cwd: workspace,
      transcript_path,
      reason: 'clear',
    }, 'all', 'claude');
  }

  return { root, claudeHome, workspace, env, startSession, endSession };
}

function post(baseUrl, pathname, { token, headers = {}, body = '{}' } = {}) {
  const reqHeaders = { 'Content-Type': 'application/json', ...headers };
  if (token !== undefined) reqHeaders['X-Fons-Token'] = token;
  return fetch(baseUrl + pathname, {
    method: 'POST',
    headers: reqHeaders,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function rawHttpRequest({ port, method, pathname, headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('panel server binds strictly to 127.0.0.1 and rejects missing/wrong tokens, cross-origin, DNS rebinding, and malformed/oversize requests', async (t) => {
  const f = fixture(t);
  f.startSession(SESSION_A, '安全验证会话');

  const panel = await startPanelServer({ selector: { host: 'claude' }, env: f.env, cwd: f.workspace });
  t.after(() => panel.close());

  assert.equal(panel.host, '127.0.0.1');
  assert.ok(panel.port > 0);
  assert.match(panel.token, /^[a-f0-9]{64}$/);
  assert.equal(panel.url, `http://127.0.0.1:${panel.port}/#token=${panel.token}`);
  await assert.rejects(() => startPanelServer({ port: 'not-a-port', env: f.env, cwd: f.workspace }), /端口号/);
  assert.throws(() => openPanelUrl('http://127.0.0.1:8080/#token=bad&calc'), /面板地址/);

  const baseUrl = `http://127.0.0.1:${panel.port}`;
  const pageRes = await fetch(baseUrl + '/');
  assert.equal(pageRes.status, 200);
  const html = await pageRes.text();
  assert.doesNotMatch(html, /src="\/preload\.js"/);
  assert.match(html, /data-testid="fons-quick-add"/);
  assert.equal(html.includes(panel.token), false);
  assert.equal(html.includes(SESSION_A), false);

  // DNS rebinding via spoofed Host header is rejected on both GET / and POST.
  const rebindGet = await rawHttpRequest({ port: panel.port, method: 'GET', pathname: '/', headers: { Host: `evil.example:${panel.port}` } });
  assert.equal(rebindGet.status, 403);
  const rebindPost = await rawHttpRequest({
    port: panel.port,
    method: 'POST',
    pathname: '/api/panel/context',
    headers: { Host: `evil.example:${panel.port}`, 'X-Fons-Token': panel.token, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(rebindPost.status, 403);

  // Missing token and wrong token -> 403.
  assert.equal((await post(baseUrl, '/api/panel/context')).status, 403);
  assert.equal((await post(baseUrl, '/api/panel/context', { token: '0'.repeat(64) })).status, 403);
  assert.equal((await post(baseUrl, '/api/pool', { body: { conversationId: SESSION_A } })).status, 403);

  // Cross-origin Origin / Sec-Fetch-Site -> 403.
  assert.equal((await post(baseUrl, '/api/panel/context', {
    token: panel.token, headers: { Origin: 'https://evil.example' },
  })).status, 403);
  assert.equal((await post(baseUrl, '/api/panel/context', {
    token: panel.token, headers: { Origin: `http://localhost:${panel.port}` },
  })).status, 403);
  assert.equal((await post(baseUrl, '/api/panel/context', {
    token: panel.token, headers: { 'Sec-Fetch-Site': 'cross-site' },
  })).status, 403);

  // Wrong Content-Type -> 415; malformed/non-object JSON -> 400; unknown route -> 404; OPTIONS -> 405 without CORS.
  assert.equal((await post(baseUrl, '/api/panel/context', {
    token: panel.token, headers: { 'Content-Type': 'text/plain' },
  })).status, 415);
  assert.equal((await post(baseUrl, '/api/panel/context', { token: panel.token, body: '{bad' })).status, 400);
  assert.equal((await post(baseUrl, '/api/panel/context', { token: panel.token, body: '[]' })).status, 400);
  assert.equal((await post(baseUrl, '/api/pool/unknown', { token: panel.token, body: '{}' })).status, 404);
  const optRes = await fetch(baseUrl + '/api/pool', { method: 'OPTIONS' });
  assert.equal(optRes.status, 405);
  assert.equal(optRes.headers.get('access-control-allow-origin'), null);

  // Non-upload POST exceeding 256 KB -> 413.
  const oversizeRes = await post(baseUrl, '/api/pool', {
    token: panel.token,
    headers: { Origin: baseUrl, 'Sec-Fetch-Site': 'same-origin' },
    body: { conversationId: SESSION_A, etag: 'x'.repeat(260 * 1024) },
  });
  assert.equal(oversizeRes.status, 413);
});

test('panel server supports large attachment upload and preview read closed loop', async (t) => {
  const f = fixture(t);
  f.startSession(SESSION_A, '附件会话');

  const panel = await startPanelServer({ selector: { host: 'claude' }, env: f.env, cwd: f.workspace });
  t.after(() => panel.close());
  const baseUrl = `http://127.0.0.1:${panel.port}`;
  const sameOrigin = { Origin: baseUrl, 'Sec-Fetch-Site': 'same-origin' };
  const workspaceUris = [pathToFileURL(f.workspace).href];

  // Upload an attachment > 256 KB to verify the 112 MB upload limit on /api/pool/add.
  const payloadBytes = Buffer.alloc(320 * 1024, 0x5a);
  const addRes = await post(baseUrl, '/api/pool/add', {
    token: panel.token,
    headers: sameOrigin,
    body: {
      conversationId: SESSION_A,
      workspaceUris,
      texts: ['检查截图'],
      attachments: [{ name: 'capture.png', mimeType: 'image/png', dataBase64: payloadBytes.toString('base64') }],
    },
  });
  assert.equal(addRes.status, 200);
  assert.equal((await addRes.json()).count, 1);

  const listRes = await post(baseUrl, '/api/pool', {
    token: panel.token,
    headers: sameOrigin,
    body: { conversationId: SESSION_A, workspaceUris },
  });
  assert.equal(listRes.status, 200);
  const snapshot = await listRes.json();
  assert.equal(snapshot.items.length, 1);
  const [{ storedName }] = snapshot.items[0].attachments;

  const attRes = await post(baseUrl, '/api/pool/attachment', {
    token: panel.token,
    headers: sameOrigin,
    body: { conversationId: SESSION_A, workspaceUris, storedName },
  });
  assert.equal(attRes.status, 200);
  const att = await attRes.json();
  assert.equal(att.mimeType, 'image/png');
  assert.deepEqual(Buffer.from(att.dataBase64, 'base64'), payloadBytes);
});

test('panel dynamically switches active session after /clear while locked -s stays pinned', async (t) => {
  const f = fixture(t);
  const transcriptA = f.startSession(SESSION_A, '第一阶段');

  const panel = await startPanelServer({ selector: { host: 'claude' }, env: f.env, cwd: f.workspace });
  t.after(() => panel.close());
  const locked = await startPanelServer({
    selector: { host: 'claude', sessionId: SESSION_A }, env: f.env, cwd: f.workspace,
  });
  t.after(() => locked.close());

  const baseUrl = `http://127.0.0.1:${panel.port}`;
  const lockedUrl = `http://127.0.0.1:${locked.port}`;
  const headers = (origin) => ({ Origin: origin, 'Sec-Fetch-Site': 'same-origin' });
  const workspaceUris = [pathToFileURL(f.workspace).href];

  const ctx1 = await (await post(baseUrl, '/api/panel/context', {
    token: panel.token, headers: headers(baseUrl),
  })).json();
  assert.equal(ctx1.conversationId, SESSION_A);
  assert.deepEqual(ctx1.workspaceUris, workspaceUris);

  // Simulate /clear: SessionEnd on A + SessionStart on B.
  f.endSession(SESSION_A, transcriptA);
  f.startSession(SESSION_B, '清空后的新会话');

  const ctx2 = await (await post(baseUrl, '/api/panel/context', {
    token: panel.token, headers: headers(baseUrl),
  })).json();
  assert.equal(ctx2.conversationId, SESSION_B);
  assert.equal(ctx2.title, '清空后的新会话');

  // Stale conversationId A is rejected with 403 once active session moved to B.
  const staleAdd = await post(baseUrl, '/api/pool/add', {
    token: panel.token,
    headers: headers(baseUrl),
    body: { conversationId: SESSION_A, workspaceUris, texts: ['stale'] },
  });
  assert.equal(staleAdd.status, 403);

  const freshAdd = await post(baseUrl, '/api/pool/add', {
    token: panel.token,
    headers: headers(baseUrl),
    body: { conversationId: SESSION_B, workspaceUris, texts: ['fresh after clear'] },
  });
  assert.equal(freshAdd.status, 200);
  assert.match(fs.readFileSync(path.join(f.workspace, '.agents', 'fons', `ideas-${SESSION_B}.md`), 'utf8'), /fresh after clear/);

  // Locked panel remains pinned to SESSION_A.
  const lockedCtx = await (await post(lockedUrl, '/api/panel/context', {
    token: locked.token, headers: headers(lockedUrl),
  })).json();
  assert.equal(lockedCtx.conversationId, SESSION_A);

  // Two active sessions -> /api/panel/context returns null and /api/pool returns 409.
  const sessionC = 'cccc0003-3333-4333-8333-333333333333';
  f.startSession(sessionC, '并行会话');
  const multiCtx = await (await post(baseUrl, '/api/panel/context', {
    token: panel.token, headers: headers(baseUrl),
  })).json();
  assert.equal(multiCtx.conversationId, null);
  assert.match(multiCtx.message, /多个已登记会话/);
  const multiPool = await post(baseUrl, '/api/pool', {
    token: panel.token, headers: headers(baseUrl), body: { conversationId: SESSION_B },
  });
  assert.equal(multiPool.status, 409);
});

test('browser bridge strips #token, recovers from sessionStorage, updates title, and handles missing token', async () => {
  const html = readFonsPanelHtml();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const token = 'a'.repeat(64);
  const storage = new Map();
  let replacedPath = null;
  let intervalFn = null;
  const responses = [
    { conversationId: SESSION_A, workspaceUris: ['file:///ws'], title: '' },
    { conversationId: SESSION_A, workspaceUris: ['file:///ws'], title: '回填标题' },
    { conversationId: SESSION_B, workspaceUris: ['file:///ws'], title: 'B' },
  ];
  let callIndex = 0;

  const window = {
    location: { hash: '#token=' + token, pathname: '/' },
    sessionStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
    history: { replaceState: (_s, _t, nextPath) => { replacedPath = nextPath; } },
    document: { hidden: false, title: '', addEventListener() {} },
    setInterval: (fn) => { intervalFn = fn; return 1; },
    fetch: async (_path, opts) => {
      assert.equal(opts.headers['X-Fons-Token'], token);
      assert.equal(opts.headers['Content-Type'], 'application/json');
      const body = responses[Math.min(callIndex++, responses.length - 1)];
      return { ok: true, status: 200, json: async () => body };
    },
  };

  vm.runInNewContext(script, { window });
  assert.equal(replacedPath, '/');
  assert.equal(storage.get('fons.panelToken'), token);

  const revisions = [];
  window.sidecar.onWorkspaceChange((uris, revision) => revisions.push({ uris: Array.from(uris), revision }));
  await new Promise(setImmediate);
  assert.equal(window.sidecar.conversationId, SESSION_A);
  const revAfterA = revisions.at(-1).revision;

  // Backfilled title updates document.title without bumping revision/resetting panel.
  intervalFn();
  await new Promise(setImmediate);
  assert.equal(window.document.title, '回填标题 · Fons 灵感池');
  assert.equal(revisions.at(-1).revision, revAfterA);

  // Session switch bumps revision.
  intervalFn();
  await new Promise(setImmediate);
  assert.equal(window.sidecar.conversationId, SESSION_B);
  assert.equal(window.document.title, 'B · Fons 灵感池');
  assert.ok(revisions.at(-1).revision > revAfterA);

  // Page reload (empty hash) recovers token from sessionStorage.
  const reloadedWindow = {
    ...window,
    location: { hash: '', pathname: '/' },
    fetch: async (_path, opts) => {
      assert.equal(opts.headers['X-Fons-Token'], token);
      return { ok: true, status: 200, json: async () => ({ conversationId: SESSION_B, workspaceUris: [], title: 'B' }) };
    },
  };
  vm.runInNewContext(script, { window: reloadedWindow });
  await new Promise(setImmediate);
  assert.equal(reloadedWindow.sidecar.conversationId, SESSION_B);

  // Missing token fails closed without calling fetch.
  const emptyWindow = {
    location: { hash: '', pathname: '/' },
    sessionStorage: { getItem: () => null, setItem() {} },
    document: { hidden: false, title: '', addEventListener() {} },
    setInterval() { throw new Error('must not poll without token'); },
    fetch() { throw new Error('must not fetch without token'); },
  };
  vm.runInNewContext(script, { window: emptyWindow });
  assert.match(emptyWindow.sidecar.contextMessage, /令牌/);
  assert.equal((await emptyWindow.sidecar.fetch('/api/pool', { method: 'POST', body: '{}' })).status, 403);
});

test('CLI fons panel --no-open starts loopback server and serves /api/panel/context', async (t) => {
  const f = fixture(t);
  f.startSession(SESSION_A, 'CLI 面板');

  const child = spawn(process.execPath, [CLI, '--host', 'claude', '--no-open', 'panel'], {
    cwd: f.workspace,
    env: { ...process.env, ...f.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const rl = createInterface({ input: child.stdout });
  const exited = once(child, 'exit');
  try {
    const line = await new Promise((resolve) => rl.once('line', resolve));
    const match = /(http:\/\/127\.0\.0\.1:\d+)\/#token=([a-f0-9]{64})/.exec(line || '');
    assert.ok(match, 'unexpected panel startup output: ' + line);
    const [, baseUrl, token] = match;

    const res = await post(baseUrl, '/api/panel/context', {
      token, headers: { Origin: baseUrl, 'Sec-Fetch-Site': 'same-origin' },
    });
    assert.equal(res.status, 200);
    const ctx = await res.json();
    assert.equal(ctx.conversationId, SESSION_A);
    assert.equal(ctx.title, 'CLI 面板');
  } finally {
    rl.close();
    child.stdout.destroy();
    child.stderr.destroy();
    if (child.exitCode === null) child.kill();
    await exited;
  }
});
