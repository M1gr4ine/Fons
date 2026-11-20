import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { stdin, stdout, stderr } from 'node:process';
import { pathToFileURL } from 'node:url';
import { codexAppData } from '../adapters/codex.mjs';
import { isValidSessionId, lookupConversation } from '../scripts/fons-store.mjs';
import { mountPoolRoutes } from '../sidecars/fons-pool/main.mjs';

const UI_URI = 'ui://fons/pool.html';
const UI_MIME = 'text/html;profile=mcp-app';
const UI_OPTIONS = {
  'openai/ui': {
    sidePanelTitle: 'Fons 灵感池',
    preferredDisplayMode: 'fullscreen',
    availableDisplayModes: ['fullscreen', 'inline'],
  },
};
const OPEN_TOOL = 'open_fons_pool';
const REQUEST_TOOL = 'fons_pool_request';
const SERVER_INFO = { name: 'fons', version: '1.0.0' };
const PROTOCOL_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']);
const BODY_LIMIT = 256 * 1024;
const UPLOAD_LIMIT = 112 * 1024 * 1024;
const MESSAGE_LIMIT = UPLOAD_LIMIT + BODY_LIMIT;
const UPLOAD_ROUTES = new Set(['/api/pool/add', '/api/pool/update']);
const MAX_PANELS = 128;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

const resource = {
  uri: UI_URI,
  name: 'Fons 灵感池',
  mimeType: UI_MIME,
};

const tools = [
  {
    name: OPEN_TOOL,
    title: '灵感池',
    description: '在当前 Codex 会话内打开可交互的 Fons 灵感池。直接调用，无需提供会话 ID 或工作区路径。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: {
      ui: { resourceUri: UI_URI },
      'openai/ui': { entrypoints: [{ type: 'thread' }] },
    },
  },
  {
    name: REQUEST_TOOL,
    title: 'Fons 灵感池操作',
    description: '供已绑定的 Fons 面板处理当前会话的灵感池请求。',
    inputSchema: {
      type: 'object',
      properties: {
        token: { type: 'string', minLength: 64, maxLength: 64 },
        path: { type: 'string' },
        data: { type: 'object' },
      },
      required: ['token', 'path', 'data'],
      additionalProperties: false,
    },
    _meta: { ui: { resourceUri: UI_URI, visibility: ['app'] } },
  },
];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function threadIdFromMeta(meta) {
  // Codex injects the originating thread ID into request metadata. The distinct
  // sessionId identifies an agent family and does not select a pool.
  const threadId = isObject(meta) ? meta.threadId : undefined;
  return isValidSessionId(threadId) ? threadId : null;
}

function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

function openError(message) {
  return { ...textResult(message), isError: true };
}

function routeResult(status, body) {
  return { content: [], structuredContent: { status, body } };
}

function routeError(status, error) {
  return routeResult(status, { error });
}

function readRouteResult(result) {
  if (Number.isInteger(result?.status) && Object.hasOwn(result, 'body')) {
    return routeResult(result.status, JSON.parse(result.body));
  }
  return routeResult(200, result ?? {});
}

function createPoolRoutes(boundSession) {
  const routes = new Map();
  mountPoolRoutes({
    page() {},
    api(path, handle, method) {
      if (method !== 'POST') throw new Error('Fons MCP 只支持 POST 面板操作。');
      routes.set(path, handle);
    },
  }, boundSession.appData, { boundSession });
  return routes;
}

function openPanel({ appData, panels }, args, threadId) {
  if (!isObject(args) || Object.keys(args).length) return openError('打开面板无需提供任何参数。');
  if (!threadId) return openError('Codex 未提供当前会话身份，请在 Codex 桌面会话中打开 Fons。');
  const entry = lookupConversation({ appData, sessionId: threadId });
  if (entry?.host !== 'codex') {
    return openError('当前 Codex 会话尚未由 Fons Hook 登记。请确认 Fons Hook 已启用并受信任，再打开面板。');
  }

  const routes = createPoolRoutes({ ...entry, appData, sessionId: threadId });
  const token = randomBytes(32).toString('hex');
  const workspaceUris = entry.rootDir ? [pathToFileURL(entry.rootDir).href] : [];
  if (panels.size >= MAX_PANELS) panels.delete(panels.keys().next().value);
  panels.set(token, { threadId, routes });
  return {
    ...textResult('已打开当前会话的 Fons 灵感池。'),
    _meta: { fonsPanel: { token, conversationId: threadId, workspaceUris } },
  };
}

function validRouteArgs(args) {
  return isObject(args) && Object.keys(args).length === 3 &&
    typeof args.token === 'string' && TOKEN_PATTERN.test(args.token) &&
    typeof args.path === 'string' && isObject(args.data);
}

function runPoolRoute(panels, args, threadId) {
  if (!validRouteArgs(args)) return routeError(400, '无效的面板请求参数。');
  const { token, path, data } = args;
  const panel = panels.get(token);
  if (!panel || panel.threadId !== threadId) {
    return routeError(403, '当前面板未绑定此会话或已失效。请重新打开 Fons 灵感池。');
  }
  const handle = panel.routes.get(path);
  if (!handle) return routeError(404, '面板接口不存在。');
  const limit = UPLOAD_ROUTES.has(path) ? UPLOAD_LIMIT : BODY_LIMIT;
  if (Buffer.byteLength(JSON.stringify(data)) > limit) return routeError(413, '请求体超过允许的大小。');
  panels.delete(token);
  panels.set(token, panel);
  return readRouteResult(handle(data));
}

function rpcError(code, message) {
  return { error: { code, message } };
}

function callTool(context, { name, arguments: args = {}, _meta }) {
  const threadId = threadIdFromMeta(_meta);
  switch (name) {
    case OPEN_TOOL: return { result: openPanel(context, args, threadId) };
    case REQUEST_TOOL: return { result: runPoolRoute(context.panels, args, threadId) };
    default: return rpcError(-32602, '未知的 Fons 工具。');
  }
}

function initialize({ protocolVersion }) {
  return {
    protocolVersion: PROTOCOL_VERSIONS.has(protocolVersion) ? protocolVersion : '2025-11-25',
    capabilities: { tools: {}, resources: {} },
    serverInfo: SERVER_INFO,
  };
}

async function readResource({ uri }) {
  if (uri !== UI_URI) return rpcError(-32602, '未知的 Fons 面板资源。');
  const { readFonsMcpUi } = await import('./fons-mcp-ui.mjs');
  const content = { uri, mimeType: UI_MIME, text: readFonsMcpUi(), _meta: UI_OPTIONS };
  return { result: { contents: [content] } };
}

async function dispatch(context, method, params) {
  switch (method) {
    case 'initialize': return { result: initialize(params) };
    case 'ping': return { result: {} };
    case 'tools/list': return { result: { tools } };
    case 'tools/call': return callTool(context, params);
    case 'resources/list': return { result: { resources: [resource] } };
    case 'resources/templates/list': return { result: { resourceTemplates: [] } };
    case 'resources/read': return readResource(params);
    default: return rpcError(-32601, '未知的 MCP 请求方法。');
  }
}

function parseFrame(frame) {
  if (!frame) return rpcError(-32700, 'Fons MCP 消息超过允许的大小。');
  try {
    return { message: JSON.parse(frame.toString('utf8')) };
  } catch {
    return rpcError(-32700, 'Fons MCP 消息不是有效的 JSON。');
  }
}

function validRequest({ jsonrpc, id, method, params }) {
  const validId = id === undefined || typeof id === 'string' || Number.isSafeInteger(id);
  return jsonrpc === '2.0' && validId && typeof method === 'string' &&
    (params === undefined || isObject(params));
}

async function respond(context, frame) {
  const parsed = parseFrame(frame);
  if (parsed.error) return { id: null, ...parsed };
  const { message } = parsed;
  if (!isObject(message) || !validRequest(message)) {
    return { id: null, ...rpcError(-32600, '无效的 Fons MCP 请求。') };
  }
  const { id, method, params = {} } = message;
  if (id === undefined) return null;

  try {
    return { id, ...await dispatch(context, method, params) };
  } catch (error) {
    stderr.write('[FONS] MCP 请求处理失败。' + (error.code ? ' ' + error.code : '') + '\n');
    return { id, ...rpcError(-32603, '无法完成 Fons MCP 请求。') };
  }
}

class Frames {
  parts = [];
  size = 0;

  append(bytes) {
    this.size += bytes.length;
    if (this.size > MESSAGE_LIMIT) {
      this.parts = [];
      return;
    }
    if (bytes.length) this.parts.push(bytes);
  }

  take() {
    const frame = this.size > MESSAGE_LIMIT ? null : Buffer.concat(this.parts, this.size);
    this.parts = [];
    this.size = 0;
    return frame;
  }
}

async function* readFrames(input) {
  const frames = new Frames();
  for await (const chunk of input) {
    let offset = 0;
    for (let newline = chunk.indexOf(10); newline !== -1; newline = chunk.indexOf(10, offset)) {
      frames.append(chunk.subarray(offset, newline));
      yield frames.take();
      offset = newline + 1;
    }
    frames.append(chunk.subarray(offset));
  }
}

const context = { appData: codexAppData(), panels: new Map() };
for await (const frame of readFrames(stdin)) {
  const response = await respond(context, frame);
  if (response && !stdout.write(JSON.stringify({ jsonrpc: '2.0', ...response }) + '\n')) {
    await once(stdout, 'drain');
  }
}
