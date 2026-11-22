import assert from 'node:assert/strict';
import vm from 'node:vm';
import test from 'node:test';
import { readFonsMcpUi } from '../codex/fons-mcp-ui.mjs';

const workspaceUris = ['file:///project'];
const conversationId = '12345678-1234-7234-8234-123456789abc';
const binding = { token: 'opaque-one', conversationId, workspaceUris };
const settle = () => new Promise(setImmediate);

function mockHost() {
  const messages = [];
  const listeners = new Map();
  const attributes = {};
  const root = {
    dataset: attributes, style: { setProperty(name, value) { attributes[name] = value; } },
    clientWidth: 768, clientHeight: 450,
  };
  const parent = { postMessage: (message) => messages.push(JSON.parse(JSON.stringify(message))) };
  const window = {
    parent,
    document: { documentElement: root },
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type) => listeners.delete(type),
  };
  const html = readFonsMcpUi();
  const bridge = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const timers = new Map();
  let timerId = 0;
  vm.runInNewContext(bridge, {
    window,
    setTimeout: (callback) => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: (id) => timers.delete(id),
  });
  const deliver = (message, source = parent) => {
    listeners.get('message')?.({ source, data: { jsonrpc: '2.0', ...message } });
  };
  const result = (data, source) => deliver({
    method: 'ui/notifications/tool-result',
    params: { _meta: { fonsPanel: data } },
  }, source);
  const connect = async (theme = 'dark') => {
    deliver({ id: messages[0].id, result: { protocolVersion: '2026-01-26', hostContext: { theme } } });
    await settle();
  };
  return { html, window, attributes, messages, deliver, result, connect, timers };
}

function poolRequest(sidecar, data = {}) {
  return sidecar.fetch('/api/pool', { method: 'POST', body: JSON.stringify(data) });
}

test('Codex embeds the existing pool and only its parent can connect and bind it', async () => {
  const host = mockHost();
  const { sidecar } = host.window;
  assert.doesNotMatch(host.html, /src="\/preload\.js"/);
  assert.match(host.html, /data-testid="fons-quick-add"/);
  assert.match(host.html, /data-testid="fons-attach"/);
  assert.equal(host.messages[0].method, 'ui/initialize');
  assert.equal(host.messages[0].params.protocolVersion, '2026-01-26');
  assert.equal(sidecar.conversationId, '');
  assert.equal((await poolRequest(sidecar)).status, 403);
  const workspaces = [];
  sidecar.onWorkspaceChange((uris) => workspaces.push(Array.from(uris)));

  host.result(binding, {});
  await host.connect();
  assert.equal(host.messages[1].method, 'ui/notifications/initialized');
  assert.equal(host.messages[2].method, 'ui/notifications/size-changed');
  assert.equal(host.attributes['color-scheme'], 'dark');
  assert.equal(sidecar.conversationId, '');
  assert.match(sidecar.contextMessage, /Codex/);
  host.result(binding);
  assert.equal(sidecar.contextMessage, '');
  assert.equal(sidecar.conversationId, conversationId);
  assert.deepEqual(workspaces.at(-1), workspaceUris);

  host.deliver({ method: 'ui/notifications/host-context-changed', params: { theme: 'light' } });
  assert.equal(host.attributes['color-scheme'], 'light');
});

test('pool requests carry the opaque binding and translate structured and transport errors', async () => {
  const { window: { sidecar }, messages, result, connect, deliver } = mockHost();
  await connect();
  result(binding);

  const read = poolRequest(sidecar, { conversationId, workspaceUris, etag: 'preview' });
  const call = messages.at(-1);
  assert.equal(call.method, 'tools/call');
  assert.deepEqual(call.params, {
    name: 'fons_pool_request',
    arguments: { token: binding.token, path: '/api/pool', data: { conversationId, workspaceUris, etag: 'preview' } },
  });
  deliver({ id: call.id, result: { structuredContent: { status: 200, body: { unchanged: true } } } });
  assert.equal((await read).ok, true);
  assert.equal((await (await read).json()).unchanged, true);

  const bad = poolRequest(sidecar);
  deliver({ id: messages.at(-1).id, result: { structuredContent: { status: 409, body: { error: '工作区不匹配' } } } });
  assert.equal((await bad).status, 409);
  assert.equal((await (await bad).json()).error, '工作区不匹配');

  const unavailable = poolRequest(sidecar);
  deliver({ id: messages.at(-1).id, error: { code: -32000, message: 'Host failed' } });
  assert.equal((await unavailable).status, 502);
  assert.equal((await sidecar.fetch('https://example.com', { method: 'POST', body: '{}' })).status, 400);
});

test('a fresh result rebinds a no-workspace panel and ignores the previous binding’s in-flight response', async () => {
  const { window: { sidecar }, messages, result, connect, deliver } = mockHost();
  await connect();
  const events = [];
  sidecar.onWorkspaceChange((uris, revision) => events.push({ length: uris.length, revision }));
  result({ ...binding, workspaceUris: [] });
  const old = poolRequest(sidecar);
  const oldId = messages.at(-1).id;
  const previous = events.at(-1);

  result({ ...binding, workspaceUris: [] });
  assert.equal(events.at(-1), previous);
  result({ ...binding, token: 'opaque-two', workspaceUris: [] });
  assert.equal(events.at(-1).length, 0);
  assert.notEqual(events.at(-1).revision, previous.revision);

  deliver({ id: oldId, result: { structuredContent: { status: 200, body: { text: 'old panel' } } } });
  assert.equal((await old).ok, false);
  const current = poolRequest(sidecar);
  assert.equal(messages.at(-1).params.arguments.token, 'opaque-two');
  deliver({ id: messages.at(-1).id, result: { structuredContent: { status: 200, body: { text: 'new panel' } } } });
  assert.equal((await (await current).json()).text, 'new panel');

  deliver({ method: 'ui/resource-teardown', id: 'close' });
  assert.equal(messages.at(-1).id, 'close');
  assert.deepEqual(messages.at(-1).result, {});
  assert.equal(sidecar.conversationId, '');
  assert.equal((await poolRequest(sidecar)).status, 403);
});

test('setup and tool errors leave a readable unbound panel and permit a later valid result', async () => {
  const { window: { sidecar }, result, connect, deliver, timers } = mockHost();
  const timeout = Array.from(timers.values())[0];
  timeout();
  await settle();
  assert.match(sidecar.contextMessage, /重新打开/);
  assert.equal((await poolRequest(sidecar)).status, 403);

  // Remounting starts a fresh handshake and can receive its own binding.
  const recovered = mockHost();
  await recovered.connect();
  recovered.deliver({ method: 'ui/notifications/tool-result', params: { isError: true } });
  assert.match(recovered.window.sidecar.contextMessage, /重新打开/);
  recovered.result(binding);
  assert.equal(recovered.window.sidecar.conversationId, conversationId);

  // Teardown arriving before ui/initialize settles preserves teardown state without clobbering.
  const closing = mockHost();
  closing.deliver({ method: 'ui/resource-teardown', id: 'early-close' });
  await settle();
  assert.equal(closing.messages.at(-1).id, 'early-close');
  assert.equal(closing.window.sidecar.contextMessage, '灵感池已关闭，请重新打开 Fons。');
  assert.equal(closing.messages.some((m) => m.method === 'ui/notifications/initialized'), false);
});
