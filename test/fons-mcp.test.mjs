import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lookupConversation, registerConversation, sessionPaths } from '../scripts/fons-store.mjs';

const SERVER = fileURLToPath(new URL('../codex/fons-mcp.mjs', import.meta.url));
const FIRST = '12345678-1234-7234-8234-123456789aaa';
const OTHER = '12345678-1234-7234-8234-123456789bbb';
const UNKNOWN = '12345678-1234-7234-8234-123456789ccc';
const FOREIGN = '12345678-1234-7234-8234-123456789ddd';
const NO_WORKSPACE = '12345678-1234-7234-8234-123456789eee';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fons-mcp-'));
  const appData = path.join(root, 'codex-home');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  for (const sessionId of [FIRST, OTHER]) {
    registerConversation({ appData, sessionId, host: 'codex', rootDir: workspace });
  }
  registerConversation({ appData, sessionId: NO_WORKSPACE, host: 'codex' });
  registerConversation({ appData, sessionId: FOREIGN, host: 'antigravity', rootDir: workspace });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const inbox = (sessionId) => sessionPaths({
    ...lookupConversation({ appData, sessionId }), sessionId,
  }).ideas;
  return { appData, workspace, inbox };
}

async function connect(t, appData) {
  const processEnv = { ...process.env, CODEX_HOME: appData, CODEX_THREAD_ID: FIRST };
  const child = spawn(process.execPath, [SERVER], { env: processEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  t.after(async () => {
    child.stdin.end();
    await closed;
  });
  let id = 0;
  const write = (message) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  const request = async (method, params) => {
    id += 1;
    write({ id, method, params });
    const { value, done } = await lines.next();
    assert.equal(done, false, 'The MCP server closed without a response');
    const response = JSON.parse(value);
    assert.equal(response.id, id);
    return response;
  };
  const call = async (name, args, meta) => (await request('tools/call', {
    name, arguments: args, _meta: meta,
  })).result;
  const hello = await request('initialize', {
    protocolVersion: '2025-11-25', clientInfo: { name: 'codex-test', version: '1.0.0' }, capabilities: {},
  });
  assert.equal(hello.result.protocolVersion, '2025-11-25');
  write({ method: 'notifications/initialized' });
  return { request, call };
}

test('MCP publishes a static Fons UI resource without private session metadata', async (t) => {
  const { request } = await connect(t, fixture(t).appData);
  assert.deepEqual((await request('ping', {})).result, {});
  const { tools } = (await request('tools/list', {})).result;
  const threadMenuTools = tools.filter(({ _meta }) =>
    _meta?.['openai/ui']?.entrypoints?.some(({ type }) => type === 'thread'));
  assert.deepEqual(threadMenuTools.map(({ name }) => name), ['open_fons_pool']);
  const [open] = threadMenuTools;
  assert.equal(open.title, '灵感池');
  const uri = open._meta.ui.resourceUri;
  assert.equal(uri, 'ui://fons/pool.html');
  assert.deepEqual(open.inputSchema.properties, {});
  assert.deepEqual(open.inputSchema.required ?? [], []);
  assert.equal(open.inputSchema.additionalProperties, false);
  const action = tools.find(({ name }) => name === 'fons_pool_request');
  assert.deepEqual(action._meta.ui.visibility, ['app']);
  assert.equal(action._meta.ui.resourceUri, uri);
  const { resources } = (await request('resources/list', {})).result;
  assert.equal(resources[0].uri, uri);
  const read = async (_meta) => (await request('resources/read', { uri, _meta })).result.contents[0];
  const anonymous = await read();
  assert.equal(anonymous.mimeType, 'text/html;profile=mcp-app');
  assert.match(anonymous.text, /Fons/);
  assert.deepEqual(anonymous._meta['openai/ui'], {
    sidePanelTitle: 'Fons 灵感池',
    preferredDisplayMode: 'fullscreen',
    availableDisplayModes: ['fullscreen', 'inline'],
  });
  assert.deepEqual(await read({ threadId: OTHER }), anonymous);
  assert.equal((await request('resources/read', { uri: 'file:///elsewhere' })).error.code, -32602);
});

test('the open tool trusts the registered root Codex thread metadata exclusively', async (t) => {
  const { appData, workspace } = fixture(t);
  const { call } = await connect(t, appData);
  for (const meta of [undefined, { sessionId: FIRST }, { threadId: UNKNOWN }, { threadId: FOREIGN },
    { threadId: '../other' }]) {
    const rejected = await call('open_fons_pool', {}, meta);
    assert.equal(rejected.isError, true);
    assert.equal(rejected._meta, undefined);
  }
  const forged = await call('open_fons_pool', { threadId: OTHER, cwd: workspace }, { threadId: FIRST });
  assert.equal(forged.isError, true);
  const opened = await call('open_fons_pool', undefined, { threadId: FIRST, sessionId: OTHER });
  const binding = opened._meta.fonsPanel;
  assert.equal(binding.conversationId, FIRST);
  assert.deepEqual(binding.workspaceUris, [pathToFileURL(workspace).href]);
  assert.match(binding.token, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify({ ...opened, _meta: undefined }).includes(binding.token), false);
});

test('app route requests require the per-panel secret and the matching Codex thread', async (t) => {
  const { appData, inbox } = fixture(t);
  const { call } = await connect(t, appData);
  const open = async (threadId) => (await call('open_fons_pool', {}, { threadId }))._meta.fonsPanel;
  const panel = await open(FIRST);
  const otherPanel = await open(OTHER);
  assert.notEqual(panel.token, otherPanel.token);
  const add = { token: panel.token, path: '/api/pool/add', data: { texts: ['kept in this pool'] } };
  const run = async (args, meta) => (await call('fons_pool_request', args, meta)).structuredContent;
  assert.equal((await run(add)).status, 403);
  assert.equal((await run(add, { threadId: OTHER })).status, 403);
  assert.equal((await run({ ...add, token: otherPanel.token }, { threadId: FIRST })).status, 403);
  assert.equal((await run({ ...add, data: { ...add.data, conversationId: OTHER } }, { threadId: FIRST })).status, 403);
  assert.equal((await run({ ...add, path: '/api/pool/add?alias=true' }, { threadId: FIRST })).status, 404);
  assert.equal((await run({ ...add, path: '/api/pool', data: { etag: 'x'.repeat(256 * 1024) } }, { threadId: FIRST })).status, 413);
  assert.equal(fs.existsSync(inbox(FIRST)), false);
  assert.equal(fs.existsSync(inbox(OTHER)), false);
  assert.equal((await run(add, { threadId: FIRST })).body.count, 1);
  assert.match(fs.readFileSync(inbox(FIRST), 'utf8'), /kept in this pool/);
  assert.equal(fs.existsSync(inbox(OTHER)), false);
  const listed = await run({ token: panel.token, path: '/api/pool', data: {} }, { threadId: FIRST });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.items.map(({ text }) => text), ['kept in this pool']);
});

test('a No Project panel stays on its registered scope', async (t) => {
  const { appData, workspace } = fixture(t);
  const { call } = await connect(t, appData);
  const meta = { threadId: NO_WORKSPACE };
  const { fonsPanel } = (await call('open_fons_pool', {}, meta))._meta;
  assert.deepEqual(fonsPanel.workspaceUris, []);
  const input = { token: fonsPanel.token, path: '/api/pool', data: {} };
  const listed = await call('fons_pool_request', input, meta);
  assert.equal(listed.structuredContent.body.scope, 'no-workspace');
  const wrongScope = await call('fons_pool_request', {
    ...input, data: { workspaceUris: [pathToFileURL(workspace).href] },
  }, meta);
  assert.equal(wrongScope.structuredContent.status, 409);
});

test('the bound app can upload and preview an attachment larger than the text request limit', async (t) => {
  const { appData } = fixture(t);
  const { call } = await connect(t, appData);
  const meta = { threadId: FIRST };
  const { token } = (await call('open_fons_pool', {}, meta))._meta.fonsPanel;
  const request = async (path, data) => (await call('fons_pool_request', { token, path, data }, meta)).structuredContent;
  const bytes = Buffer.alloc(300 * 1024, 0xd5);
  const dataBase64 = bytes.toString('base64');
  const attached = await request('/api/pool/add', {
    texts: ['attached'], attachments: [{ name: 'preview.png', mimeType: 'image/png', dataBase64 }],
  });
  assert.equal(attached.status, 200);
  const { body } = await request('/api/pool', {});
  const [{ storedName }] = body.items[0].attachments;
  const preview = await request('/api/pool/attachment', { storedName });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.mimeType, 'image/png');
  assert.deepEqual(Buffer.from(preview.body.dataBase64, 'base64'), bytes);
});
