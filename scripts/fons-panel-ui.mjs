import { renderPoolBridgeHtml } from '../sidecars/fons-pool/main.mjs';

function installLocalPanelBridge(window) {
  const TOKEN_RE = /^[a-f0-9]{64}$/;
  const DISCONNECTED_ERROR = '无法连接本地 Fons 面板服务，请确认进程仍在运行。';

  function readToken() {
    const hash = window.location?.hash || '';
    const hashToken = hash.startsWith('#token=') ? hash.slice(7) : '';
    if (TOKEN_RE.test(hashToken)) {
      try { window.sessionStorage?.setItem('fons.panelToken', hashToken); } catch {}
      try { window.history?.replaceState?.(null, '', window.location.pathname || '/'); } catch {}
      return hashToken;
    }
    try {
      const saved = window.sessionStorage?.getItem('fons.panelToken') || '';
      if (TOKEN_RE.test(saved)) return saved;
    } catch {}
    return '';
  }

  function makeResponse(status, body) {
    return { status, ok: status >= 200 && status < 300, json: async () => body };
  }

  function sameContext(left, right) {
    return Boolean(left)
      && left.conversationId === right.conversationId
      && left.workspaceUris.length === right.workspaceUris.length
      && left.workspaceUris.every((uri, index) => uri === right.workspaceUris[index]);
  }

  const token = readToken();
  const subscribers = new Set();
  const state = {
    binding: null,
    revision: 0,
    statusMessage: token
      ? '正在定位当前活跃会话…'
      : '缺少本地面板访问令牌，请通过 fons panel 输出的完整链接打开。',
  };

  function notify(fn) {
    fn([...(state.binding?.workspaceUris ?? [])], state.revision);
  }

  function publish(next, message = '') {
    state.binding = next;
    state.statusMessage = message;
    state.revision += 1;
    subscribers.forEach(notify);
  }

  function setTitle(title) {
    window.document.title = title ? title + ' · Fons 灵感池' : 'Fons 灵感池';
  }

  function publishError(message) {
    if (state.binding === null && state.statusMessage === message) return;
    setTitle('');
    publish(null, message);
  }

  function postJson(pathname, bodyText) {
    return window.fetch(pathname, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Fons-Token': token },
      body: bodyText,
    });
  }

  async function fetchPool(pathname, options = {}) {
    if (!token || !state.binding) return makeResponse(403, { error: state.statusMessage });
    if (options.method !== 'POST' || !/^\/api\/pool(?:\/[a-z]+)?$/.test(pathname) || typeof options.body !== 'string') {
      return makeResponse(400, { error: '无效的灵感池请求。' });
    }
    try {
      return await postJson(pathname, options.body);
    } catch {
      return makeResponse(502, { error: DISCONNECTED_ERROR });
    }
  }

  let syncing = false;
  async function syncContext() {
    if (syncing) return;
    syncing = true;
    try {
      const response = await postJson('/api/panel/context', '{}');
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const errorText = typeof data?.error === 'string' && data.error ? data.error : '无法连接本地 Fons 面板服务。';
        publishError(errorText);
        return;
      }
      if (typeof data?.conversationId !== 'string' || !data.conversationId) {
        const message = typeof data?.message === 'string' && data.message ? data.message : '未找到活跃会话。';
        publishError(message);
        return;
      }
      const workspaceUris = Array.isArray(data.workspaceUris)
        ? data.workspaceUris.filter((u) => typeof u === 'string')
        : [];
      const next = { conversationId: data.conversationId, workspaceUris };
      setTitle(data.title || '');
      if (!sameContext(state.binding, next) || state.statusMessage) publish(next, '');
    } catch {
      publishError(DISCONNECTED_ERROR);
    } finally {
      syncing = false;
    }
  }

  window.sidecar = {
    get conversationId() { return state.binding?.conversationId ?? ''; },
    get contextMessage() { return state.statusMessage; },
    fetch: fetchPool,
    onWorkspaceChange(fn) {
      subscribers.add(fn);
      notify(fn);
      return () => subscribers.delete(fn);
    },
  };
  if (!token) return;

  const refresh = () => { void syncContext(); };
  refresh();
  window.setInterval(() => { if (!window.document.hidden) refresh(); }, 1000);
  window.document.addEventListener('visibilitychange', () => {
    if (!window.document.hidden) refresh();
  });
}

export function readFonsPanelHtml() {
  return renderPoolBridgeHtml([installLocalPanelBridge], 'installLocalPanelBridge(window);');
}
