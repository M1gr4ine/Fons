import { renderPoolBridgeHtml } from '../sidecars/fons-pool/main.mjs';

function installCodexBridge(window) {
  const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const poolResponse = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

  function openError(result) {
    const text = result?.content?.find?.((item) => item?.type === 'text')?.text;
    if (result?.isError && typeof text === 'string' && text.trim()) return text;
    return '未收到当前会话的灵感池授权，请重新打开 Fons。';
  }

  function applyTheme(context) {
    const { theme } = context ?? {};
    if (theme === 'light' || theme === 'dark') {
      window.document.documentElement.style.setProperty('color-scheme', theme);
    }
  }

  function readBinding(result) {
    const panel = result?._meta?.fonsPanel;
    if (!isRecord(panel) || typeof panel.token !== 'string' || !panel.token) return null;
    if (typeof panel.conversationId !== 'string' || !panel.conversationId) return null;
    const { workspaceUris } = panel;
    if (!Array.isArray(workspaceUris) || workspaceUris.some((uri) => typeof uri !== 'string')) return null;
    return panel;
  }

  function parsePoolRequest(path, { method, body } = {}) {
    if (method !== 'POST' || !/^\/api\/pool(?:\/[a-z]+)?$/.test(path) || typeof body !== 'string') {
      return { error: '无效的灵感池请求。' };
    }
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return { error: '无法读取灵感池请求。' };
    }
    return isRecord(data) ? { data } : { error: '无效的灵感池请求。' };
  }

  const subscribers = new Set();
  let binding = null;
  let revision = 0;
  let statusMessage = '正在等待 Codex 打开当前会话的灵感池…';

  const notifySubscriber = (subscriber) => subscriber([...(binding?.workspaceUris ?? [])], revision);

  function publish(next, message = '') {
    binding = next;
    statusMessage = message;
    revision += 1;
    subscribers.forEach(notifySubscriber);
  }

  function subscribe(subscriber) {
    subscribers.add(subscriber);
    notifySubscriber(subscriber);
    return () => subscribers.delete(subscriber);
  }

  const parent = window.parent;
  const pending = new Map();
  const handlers = new Map();
  let nextId = 0;

  const send = (message) => parent.postMessage({ jsonrpc: '2.0', ...message }, '*');
  const notify = (method, params = {}) => send({ method, params });

  function finishPending(id, message) {
    const request = pending.get(id);
    if (!request) return;
    clearTimeout(request.timeout);
    pending.delete(id);
    if (message.error) request.reject(message.error);
    else request.resolve(message.result);
  }

  function receive(event) {
    const message = event.data;
    if (event.source !== parent || !isRecord(message) || message.jsonrpc !== '2.0') return;
    if (typeof message.method === 'string') handlers.get(message.method)?.(message);
    else finishPending(message.id, message);
  }

  function call(method, params) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finishPending(id, { error: new Error('Codex 响应超时。') }), 30_000);
      pending.set(id, { timeout, resolve, reject });
      try {
        send({ id, method, params });
      } catch (error) {
        finishPending(id, { error });
      }
    });
  }

  function closeRpc() {
    window.removeEventListener('message', receive);
    for (const id of pending.keys()) finishPending(id, { error: new Error('面板已关闭。') });
  }

  async function fetchPool(path, options) {
    const current = binding;
    if (!current) return poolResponse(403, { error: statusMessage });
    const request = parsePoolRequest(path, options);
    if (request.error) return poolResponse(400, { error: request.error });

    let result;
    try {
      result = await call('tools/call', {
        name: 'fons_pool_request',
        arguments: { token: current.token, path, data: request.data },
      });
    } catch {
      return poolResponse(502, { error: 'Codex 未能完成灵感池操作，请重试。' });
    }
    if (current !== binding) return poolResponse(409, { error: '面板会话已更换。' });
    const { status, body } = result?.structuredContent ?? {};
    if (!Number.isInteger(status) || status < 200 || status > 599 || !isRecord(body)) {
      return poolResponse(502, { error: '未收到有效的灵感池响应。' });
    }
    if (status === 401 || status === 403) publish(null, body.error || openError());
    return poolResponse(status, body);
  }

  window.sidecar = {
    get conversationId() { return binding?.conversationId ?? ''; },
    get contextMessage() { return statusMessage; },
    fetch: fetchPool,
    onWorkspaceChange: subscribe,
  };

  if (parent === window) {
    publish(null, '请在 Codex 会话中打开 Fons 灵感池。');
    return;
  }

  window.addEventListener('message', receive);
  let ready = false;
  let closed = false;
  let resultTimeout;

  function cancel(message) {
    if (!ready || binding) return;
    clearTimeout(resultTimeout);
    publish(null, message);
  }

  handlers.set('ui/notifications/tool-result', ({ params }) => {
    if (!ready) return;
    const next = readBinding(params);
    if (!next) {
      cancel(openError(params));
      return;
    }
    clearTimeout(resultTimeout);
    if (next.token !== binding?.token) publish(next);
  });
  handlers.set('ui/notifications/tool-cancelled', () => cancel('已取消打开灵感池，请重新打开 Fons。'));
  handlers.set('ui/notifications/host-context-changed', ({ params }) => applyTheme(params));
  handlers.set('ui/resource-teardown', ({ id }) => {
    closed = true;
    ready = false;
    clearTimeout(resultTimeout);
    publish(null, '灵感池已关闭，请重新打开 Fons。');
    if (id !== undefined) send({ id, result: {} });
    closeRpc();
  });
  handlers.set('ping', ({ id }) => {
    if (id !== undefined) send({ id, result: {} });
  });

  call('ui/initialize', {
    appInfo: { name: 'Fons', version: '0.3.0' },
    appCapabilities: {},
    protocolVersion: '2026-01-26',
  }).then(({ hostContext }) => {
    if (closed) return;
    applyTheme(hostContext);
    ready = true;
    resultTimeout = setTimeout(() => cancel(openError()), 60_000);
    notify('ui/notifications/initialized');
    // The pool fills a bounded viewport and scrolls its own list.
    notify('ui/notifications/size-changed', {
      width: window.document.documentElement.clientWidth,
      height: 448,
    });
  }).catch(() => {
    if (closed) return;
    publish(null, '无法连接 Codex，请重新打开 Fons 灵感池。');
    closeRpc();
  });
}

export function readFonsMcpUi() {
  return renderPoolBridgeHtml([installCodexBridge], 'installCodexBridge(window);');
}
