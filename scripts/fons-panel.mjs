import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { readFonsPanelHtml } from './fons-panel-ui.mjs';
import { resolveSession, sessionSelector } from './fons-sessions.mjs';
import {
  POOL_BODY_LIMIT, POOL_TOKEN_PATTERN, POOL_UPLOAD_LIMIT, POOL_UPLOAD_ROUTES, createBoundPoolRoutes,
} from '../sidecars/fons-pool/main.mjs';

const LOOPBACK_HOST = '127.0.0.1';
const CONTEXT_ROUTE = '/api/panel/context';
export const PANEL_URL_PATTERN = /^http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]{64}$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function tokensMatch(expected, provided) {
  if (typeof provided !== 'string' || !POOL_TOKEN_PATTERN.test(provided)) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(provided, 'utf8'));
}

function isJsonContentType(header) {
  if (typeof header !== 'string') return false;
  return header.split(';', 1)[0].trim().toLowerCase() === 'application/json';
}

function isAllowedHost(hostHeader, expectedHost) {
  return typeof hostHeader === 'string' && hostHeader.toLowerCase() === expectedHost;
}

function isSameOrigin(headers, expectedHost) {
  if (!isAllowedHost(headers.host, expectedHost)) return false;
  const expectedOrigin = 'http://' + expectedHost;
  if (headers.origin !== undefined && headers.origin.toLowerCase() !== expectedOrigin) return false;
  const fetchSite = headers['sec-fetch-site'];
  if (fetchSite !== undefined && fetchSite.toLowerCase() !== 'same-origin') return false;
  return true;
}

function validatePostRequest(req, token, expectedHost) {
  if (!tokensMatch(token, req.headers['x-fons-token'])) {
    return { status: 403, error: '无效或缺少访问令牌。' };
  }
  if (!isSameOrigin(req.headers, expectedHost)) {
    return { status: 403, error: '拒绝跨源请求。' };
  }
  if (!isJsonContentType(req.headers['content-type'])) {
    return { status: 415, error: '仅接受 application/json 请求。' };
  }
  return null;
}

function sendResponse(res, { status, contentType, body }) {
  const headers = {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (status === 413) headers.Connection = 'close';
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, payload) {
  sendResponse(res, { status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(payload) });
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function parseJsonObject(buffer) {
  let parsed;
  try {
    parsed = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw httpError(400, '无效的 JSON 请求体。');
  }
  if (!isPlainObject(parsed)) throw httpError(400, '请求体必须为 JSON 对象。');
  return parsed;
}

async function readJsonBody(req, limit) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    req.pause();
    throw httpError(413, '请求体超过允许的大小。');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      req.pause();
      throw httpError(413, '请求体超过允许的大小。');
    }
    chunks.push(chunk);
  }
  return parseJsonObject(Buffer.concat(chunks, size));
}

function createRouteCache() {
  let cacheKey = '';
  let cachedRoutes = null;
  return (session) => {
    const key = JSON.stringify([session.sessionId, session.appData, session.scope, session.rootDir, session.host]);
    if (key === cacheKey && cachedRoutes) return cachedRoutes;
    cachedRoutes = createBoundPoolRoutes(session);
    cacheKey = key;
    return cachedRoutes;
  };
}

function createSessionResolver({ selector, env, cwd }) {
  const parsed = sessionSelector(selector, env);
  const lockedSession = parsed.sessionId ? resolveSession(selector, { env, cwd }) : null;
  return () => {
    if (lockedSession) return { session: lockedSession };
    try {
      return { session: resolveSession(selector, { env, cwd }) };
    } catch (error) {
      if (error.exitCode === 2) return { session: null, message: error.message };
      throw error;
    }
  };
}

function formatContextPayload({ session, message }) {
  if (!session) return { conversationId: null, workspaceUris: [], message };
  return {
    conversationId: session.sessionId,
    workspaceUris: session.rootDir ? [pathToFileURL(session.rootDir).href] : [],
    host: session.host,
    scope: session.scope,
    title: session.title || '',
  };
}

function writeRouteResult(res, result) {
  if (Number.isInteger(result?.status) && Object.hasOwn(result, 'body')) {
    sendResponse(res, { status: result.status, contentType: 'application/json; charset=utf-8', body: result.body });
    return;
  }
  sendJson(res, 200, result ?? {});
}

async function handlePost(req, res, { pathname, token, expectedHost, resolveActive, getRoutes }) {
  const rejected = validatePostRequest(req, token, expectedHost);
  if (rejected) return sendJson(res, rejected.status, { error: rejected.error });
  const limit = POOL_UPLOAD_ROUTES.has(pathname) ? POOL_UPLOAD_LIMIT : POOL_BODY_LIMIT;
  const data = await readJsonBody(req, limit);
  if (pathname === CONTEXT_ROUTE) {
    return sendJson(res, 200, formatContextPayload(resolveActive()));
  }
  const active = resolveActive();
  if (!active.session) return sendJson(res, 409, { error: active.message });
  const handle = getRoutes(active.session).get(pathname);
  if (!handle) return sendJson(res, 404, { error: '面板接口不存在。' });
  return writeRouteResult(res, handle(data));
}

function requestPath(urlValue) {
  try {
    return new URL(urlValue || '/', 'http://' + LOOPBACK_HOST).pathname;
  } catch {
    return null;
  }
}

function parsePanelPort(raw) {
  if (raw === undefined) return 0;
  if (!/^\d+$/.test(String(raw))) throw new Error('无效的端口号：' + raw);
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('端口号必须在 0 到 65535 之间。');
  return port;
}

export function openPanelUrl(url) {
  if (typeof url !== 'string' || !PANEL_URL_PATTERN.test(url)) {
    throw new Error('无效的本地面板地址。');
  }
  const launch = process.platform === 'win32'
    ? ['cmd.exe', ['/d', '/c', 'start', '', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  const child = spawn(launch[0], launch[1], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
}

async function handlePanelRequest(req, res, state) {
  const pathname = requestPath(req.url);
  if (!pathname) return sendJson(res, 400, { error: '无效的请求路径。' });
  if (req.method === 'GET' && pathname === '/') {
    if (!isAllowedHost(req.headers.host, state.expectedHost)) return sendJson(res, 403, { error: '拒绝非法 Host 请求。' });
    return sendResponse(res, { status: 200, contentType: 'text/html; charset=utf-8', body: state.html });
  }
  if (req.method !== 'POST') return sendJson(res, 405, { error: '不支持的请求方法。' });
  try {
    await handlePost(req, res, { ...state, pathname });
  } catch (error) {
    if (Number.isInteger(error?.status)) return sendJson(res, error.status, { error: error.message });
    sendJson(res, 500, { error: '面板服务内部错误。' });
  }
}

export async function startPanelServer({ port = 0, selector = {}, env = process.env, cwd = process.cwd() } = {}) {
  const listenPort = parsePanelPort(port);
  const state = {
    resolveActive: createSessionResolver({ selector, env, cwd }),
    getRoutes: createRouteCache(),
    html: readFonsPanelHtml(),
    token: crypto.randomBytes(32).toString('hex'),
    expectedHost: '',
  };

  const server = http.createServer((req, res) => { void handlePanelRequest(req, res, state); });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, LOOPBACK_HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  state.expectedHost = LOOPBACK_HOST + ':' + address.port;
  const url = 'http://' + state.expectedHost + '/#token=' + state.token;
  const close = () => new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
  return { server, host: address.address, port: address.port, token: state.token, url, close };
}
