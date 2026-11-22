import { renderPoolBridgeHtml } from '../sidecars/fons-pool/main.mjs';

function readPanelToken(window) {
  const match = /^#token=([a-f0-9]{64})$/.exec(window.location?.hash || '');
  if (match) {
    const token = match[1];
    try { window.sessionStorage?.setItem('fons.panelToken', token); } catch {}
    try { window.history?.replaceState?.(null, '', window.location.pathname || '/'); } catch {}
    return token;
  }
  try {
    const saved = window.sessionStorage?.getItem('fons.panelToken') || '';
    if (/^[a-f0-9]{64}$/.test(saved)) return saved;
  } catch {}
  return '';
}

function panelResponse(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

function samePanelContext(left, right) {
  if (!left || !right) return left === right;
  return left.conversationId === right.conversationId
    && JSON.stringify(left.workspaceUris) === JSON.stringify(right.workspaceUris);
}

function createLocalPanelState(initialMessage) {
  const subscribers = new Set();
  const state = { binding: null, revision: 0, statusMessage: initialMessage };
  const notify = (fn) => fn([...(state.binding?.workspaceUris ?? [])], state.revision);
  return {
    state,
    publish(next, message = '') {
      state.binding = next;
      state.statusMessage = message;
      state.revision += 1;
      subscribers.forEach(notify);
    },
    subscribe(fn) {
      subscribers.add(fn);
      notify(fn);
      return () => subscribers.delete(fn);
    },
  };
}

function postPanelJson(window, token, pathname, bodyText) {
  return window.fetch(pathname, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Fons-Token': token },
    body: bodyText,
  });
}

async function fetchLocalPool(client, pathname, options = {}) {
  const { window, token, panel } = client;
  if (!token || !panel.state.binding) return panelResponse(403, { error: panel.state.statusMessage });
  if (options.method !== 'POST' || !/^\/api\/pool(?:\/[a-z]+)?$/.test(pathname) || typeof options.body !== 'string') {
    return panelResponse(400, { error: '无效的灵感池请求。' });
  }
  try {
    return await postPanelJson(window, token, pathname, options.body);
  } catch {
    return panelResponse(502, { error: '无法连接本地 Fons 面板服务，请确认进程仍在运行。' });
  }
}

function setPanelTitle(window, title) {
  if (!window.document) return;
  window.document.title = title ? title + ' · Fons 灵感池' : 'Fons 灵感池';
}

function publishPanelError(window, panel, message) {
  if (panel.state.binding === null && panel.state.statusMessage === message) return;
  setPanelTitle(window, '');
  panel.publish(null, message);
}

function applyPanelContext(window, panel, data) {
  if (typeof data?.conversationId !== 'string' || !data.conversationId) {
    const message = typeof data?.message === 'string' && data.message ? data.message : '未找到活跃会话。';
    publishPanelError(window, panel, message);
    return;
  }
  const uris = Array.isArray(data.workspaceUris) ? data.workspaceUris.filter((u) => typeof u === 'string') : [];
  const next = { conversationId: data.conversationId, workspaceUris: uris, title: data.title || '' };
  setPanelTitle(window, next.title);
  if (!samePanelContext(panel.state.binding, next) || panel.state.statusMessage) {
    panel.publish(next, '');
  }
}

async function syncPanelContext(client, gate) {
  const { window, token, panel } = client;
  if (gate.pending) return;
  gate.pending = true;
  try {
    const response = await postPanelJson(window, token, '/api/panel/context', '{}');
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const errorText = typeof data?.error === 'string' && data.error ? data.error : '无法连接本地 Fons 面板服务。';
      publishPanelError(window, panel, errorText);
      return;
    }
    applyPanelContext(window, panel, data);
  } catch {
    publishPanelError(window, panel, '无法连接本地 Fons 面板服务，请确认进程仍在运行。');
  } finally {
    gate.pending = false;
  }
}

function installLocalPanelBridge(window) {
  const token = readPanelToken(window);
  const initialMessage = token
    ? '正在定位当前活跃会话…'
    : '缺少本地面板访问令牌，请通过 fons panel 输出的完整链接打开。';
  const panel = createLocalPanelState(initialMessage);
  const client = { window, token, panel };
  window.sidecar = {
    get conversationId() { return panel.state.binding?.conversationId ?? ''; },
    get contextMessage() { return panel.state.statusMessage; },
    fetch: (pathname, options) => fetchLocalPool(client, pathname, options),
    onWorkspaceChange: panel.subscribe,
  };
  if (!token) return;

  const gate = { pending: false };
  const refresh = () => { void syncPanelContext(client, gate); };
  refresh();
  window.setInterval(() => { if (!window.document?.hidden) refresh(); }, 1000);
  window.document?.addEventListener?.('visibilitychange', () => {
    if (!window.document.hidden) refresh();
  });
}

export function readFonsPanelHtml() {
  return renderPoolBridgeHtml([
    readPanelToken, panelResponse, samePanelContext, createLocalPanelState,
    postPanelJson, fetchLocalPool, setPanelTitle, publishPanelError,
    applyPanelContext, syncPanelContext, installLocalPanelBridge,
  ], 'installLocalPanelBridge(window);');
}
