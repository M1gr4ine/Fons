import { renderPoolBridgeHtml } from '../sidecars/fons-pool/main.mjs';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finishPending(pending, id, message) {
  const request = pending.get(id);
  if (!request) return;
  clearTimeout(request.timeout);
  pending.delete(id);
  if (message.error) request.reject(message.error);
  else request.resolve(message.result);
}

function dispatchHostMessage(parent, handlers, pending, event) {
  const message = event.data;
  if (event.source !== parent || !isRecord(message) || message.jsonrpc !== '2.0') return;
  if (typeof message.method === 'string') handlers.get(message.method)?.(message);
  else finishPending(pending, message.id, message);
}

function createHostRpc(window) {
  const parent = window.parent;
  const pending = new Map();
  const handlers = new Map();
  let nextId = 0;

  const send = (message) => parent.postMessage({ jsonrpc: '2.0', ...message }, '*');
  const receive = (event) => dispatchHostMessage(parent, handlers, pending, event);

  function call(method, params) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finishPending(pending, id, { error: new Error('Codex 响应超时。') }), 30_000);
      pending.set(id, { timeout, resolve, reject });
      try {
        send({ id, method, params });
      } catch (error) {
        finishPending(pending, id, { error });
      }
    });
  }

  function close() {
    window.removeEventListener('message', receive);
    for (const id of pending.keys()) finishPending(pending, id, { error: new Error('面板已关闭。') });
  }

  window.addEventListener('message', receive);
  return {
    send, call, close,
    notify: (method, params = {}) => send({ method, params }),
    on: (method, handle) => handlers.set(method, handle),
  };
}

function poolResponse(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

function parsePoolRequest(path, { method, body } = {}) {
  if (method !== 'POST' || !/^\/api\/pool(?:\/[a-z]+)?$/.test(path) || typeof body !== 'string') {
    return poolResponse(400, { error: '无效的灵感池请求。' });
  }
  const data = JSON.parse(body);
  return isRecord(data) ? { data } : poolResponse(400, { error: '无效的灵感池请求。' });
}

function readBinding(result) {
  const panel = result?._meta?.fonsPanel;
  if (!isRecord(panel) || typeof panel.token !== 'string' || !panel.token) return null;
  if (typeof panel.conversationId !== 'string' || !panel.conversationId) return null;
  const { workspaceUris } = panel;
  if (!Array.isArray(workspaceUris) || workspaceUris.some((uri) => typeof uri !== 'string')) return null;
  return panel;
}

function applyTheme(window, context) {
  const { theme } = context ?? {};
  if (theme === 'light' || theme === 'dark') {
    window.document.documentElement.style.setProperty('color-scheme', theme);
  }
}

function openError(result) {
  const text = result?.content?.find?.((item) => item?.type === 'text')?.text;
  if (result?.isError && typeof text === 'string' && text.trim()) return text;
  return '未收到当前会话的灵感池授权，请重新打开 Fons。';
}

function createPanelState() {
  const subscribers = new Set();
  let binding = null;
  let revision = 0;
  let statusMessage = '正在等待 Codex 打开当前会话的灵感池…';

  function update(subscriber) {
    subscriber([...(binding?.workspaceUris ?? [])], revision);
  }

  return {
    get binding() { return binding; },
    get statusMessage() { return statusMessage; },
    publish(next, message = '') {
      binding = next;
      statusMessage = message;
      revision += 1;
      subscribers.forEach(update);
    },
    subscribe(subscriber) {
      subscribers.add(subscriber);
      update(subscriber);
      return () => subscribers.delete(subscriber);
    },
  };
}

function unpackPoolResult(panel, result) {
  const { status, body } = result?.structuredContent ?? {};
  if (!Number.isInteger(status) || status < 200 || status > 599 || !isRecord(body)) {
    return poolResponse(502, { error: '未收到有效的灵感池响应。' });
  }
  if (status === 401 || status === 403) panel.publish(null, body.error || openError());
  return poolResponse(status, body);
}

async function fetchPool(rpc, panel, path, options) {
  const current = panel.binding;
  if (!current) return poolResponse(403, { error: panel.statusMessage });
  let request;
  try {
    request = parsePoolRequest(path, options);
  } catch {
    return poolResponse(400, { error: '无法读取灵感池请求。' });
  }
  if (!request.data) return request;

  let result;
  try {
    result = await rpc.call('tools/call', {
      name: 'fons_pool_request',
      arguments: { token: current.token, path, data: request.data },
    });
  } catch {
    return poolResponse(502, { error: 'Codex 未能完成灵感池操作，请重试。' });
  }
  if (current !== panel.binding) return poolResponse(409, { error: '面板会话已更换。' });
  return unpackPoolResult(panel, result);
}

function connectHost(window, rpc, panel) {
  let ready = false;
  let resultTimeout;

  function cancel(message) {
    if (!ready || panel.binding) return;
    clearTimeout(resultTimeout);
    panel.publish(null, message);
  }

  function handleToolResult({ params }) {
    if (!ready) return;
    const next = readBinding(params);
    if (!next) {
      cancel(openError(params));
      return;
    }
    clearTimeout(resultTimeout);
    if (next.token !== panel.binding?.token) panel.publish(next);
  }

  rpc.on('ui/notifications/tool-result', handleToolResult);
  rpc.on('ui/notifications/tool-cancelled', () => cancel('已取消打开灵感池，请重新打开 Fons。'));
  rpc.on('ui/notifications/host-context-changed', ({ params }) => applyTheme(window, params));
  rpc.on('ui/resource-teardown', ({ id }) => {
    clearTimeout(resultTimeout);
    ready = false;
    panel.publish(null, '灵感池已关闭，请重新打开 Fons。');
    rpc.send({ id, result: {} });
    rpc.close();
  });
  rpc.on('ping', ({ id }) => rpc.send({ id, result: {} }));

  rpc.call('ui/initialize', {
    appInfo: { name: 'Fons', version: '0.3.0' },
    appCapabilities: {},
    protocolVersion: '2026-01-26',
  }).then(({ hostContext }) => {
    applyTheme(window, hostContext);
    ready = true;
    resultTimeout = setTimeout(() => cancel(openError()), 60_000);
    rpc.notify('ui/notifications/initialized');
    // The pool fills a bounded viewport and scrolls its own list.
    rpc.notify('ui/notifications/size-changed', {
      width: window.document.documentElement.clientWidth,
      height: 448,
    });
  }).catch(() => {
    panel.publish(null, '无法连接 Codex，请重新打开 Fons 灵感池。');
    rpc.close();
  });
}

function installCodexBridge(window) {
  const panel = createPanelState();
  const rpc = createHostRpc(window);
  window.sidecar = {
    get conversationId() { return panel.binding?.conversationId ?? ''; },
    get contextMessage() { return panel.statusMessage; },
    fetch: (path, options) => fetchPool(rpc, panel, path, options),
    onWorkspaceChange: panel.subscribe,
  };
  if (window.parent === window) {
    panel.publish(null, '请在 Codex 会话中打开 Fons 灵感池。');
    rpc.close();
    return;
  }
  connectHost(window, rpc, panel);
}

export function readFonsMcpUi() {
  return renderPoolBridgeHtml([
    isRecord, finishPending, dispatchHostMessage, createHostRpc, poolResponse, parsePoolRequest, readBinding, applyTheme,
    openError, createPanelState, unpackPoolResult, fetchPool, connectHost, installCodexBridge,
  ], 'installCodexBridge(window);');
}
