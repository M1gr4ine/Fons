import { formatCountsSummary, liveRemainingMs, renderPaneBody, summarizeItems } from './pane-view.mjs';

const PANE_ID = 'fons-pool';
const PANE_TITLE = 'Fons · 灵感池';
const TICK_MS = 1000;
const POLL_MS = 2500;
const HOLD_RENEW_MS = 10_000;
const BRIDGE_TIMEOUT_MS = 8000;

function createInitialState(options) {
  return {
    sessionId: '',
    cwd: '',
    bridgePath: '',
    openAtStart: options?.openAtStart !== 'off',
    isOpen: false,
    openedManually: false,
    userTouchedPane: false,
    snapshot: null,
    snapshotAt: 0,
    snapshotGen: 0,
    activeOps: 0,
    refreshQueued: false,
    hadActiveCountdown: false,
    hadReadyItem: false,
    pendingOps: new Set(),
    doneCollapsed: null,
    error: '',
    draftSeq: 0,
    draftText: '',
    editing: null,
    showSettings: false,
    webPanel: null,
    tickTimer: null,
    pollTimer: null,
    holdTimer: null,
  };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function joinPath(base, ...parts) {
  const raw = String(base || '').replace(/\\/g, '/');
  let out = raw.replace(/\/+$/, '');
  if (!out && raw.startsWith('/')) out = '/';
  for (const part of parts) {
    const clean = String(part || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '');
    if (!clean) continue;
    if (!out) out = clean;
    else if (out === '/') out = '/' + clean;
    else out += '/' + clean;
  }
  return out;
}

function parseJson(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  try { return JSON.parse(text); }
  catch { return null; }
}

function splitDraftLines(raw) {
  return String(raw ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

async function readOptionalJson($, filePath) {
  return parseJson(await $.fs.read(filePath).catch(() => ''));
}

async function pickExistingBridge($, state, candidate) {
  if (!candidate || !(await $.fs.exists(candidate).catch(() => false))) return '';
  state.bridgePath = candidate;
  return candidate;
}

function stopHoldRenew(state) {
  state.holdTimer?.cancel();
  state.holdTimer = null;
}

async function resolveBridgePath($, state) {
  if (await pickExistingBridge($, state, state.bridgePath)) return state.bridgePath;

  const pluginRoot = ((await $.env.get('CLAUDE_PLUGIN_ROOT')) || '').trim();
  if (pluginRoot) {
    const found = await pickExistingBridge($, state, joinPath(pluginRoot, 'claude/pane-bridge.mjs'));
    if (found) return found;
  }

  const configDir = ((await $.env.get('CLAUDE_CONFIG_DIR')) || '').trim();
  const home = ((await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || '').trim();
  const claudeHome = configDir || (home ? joinPath(home, '.claude') : '');
  if (claudeHome) {
    const marketDir = joinPath(claudeHome, 'fons/plugin-marketplace');
    const catalog = await readOptionalJson($, joinPath(marketDir, '.claude-plugin/marketplace.json'));
    const entry = Array.isArray(catalog?.plugins) ? catalog.plugins.find((p) => p?.name === 'fons') : null;
    const source = typeof entry?.source === 'string' ? entry.source.trim() : '';
    if (source) {
      const found = await pickExistingBridge($, state, joinPath(marketDir, source, 'claude/pane-bridge.mjs'));
      if (found) return found;
    }

    const installed = await readOptionalJson($, joinPath(claudeHome, 'plugins/installed_plugins.json'));
    const records = installed?.plugins?.['fons@fons-local'];
    const rawPath = Array.isArray(records) ? records[0]?.installPath : '';
    const installPath = typeof rawPath === 'string' ? rawPath.trim() : '';
    if (installPath) {
      const found = await pickExistingBridge($, state, joinPath(installPath, 'claude/pane-bridge.mjs'));
      if (found) return found;
    }
  }

  state.bridgePath = '';
  return '';
}

async function syncSessionMeta($, state) {
  const nextId = await $.session.id().catch(() => '');
  const nextCwd = await $.session.cwd().catch(() => '');
  const changed = Boolean(nextId && state.sessionId && nextId !== state.sessionId);
  if (nextId) state.sessionId = nextId;
  if (nextCwd) state.cwd = nextCwd;
  if (changed) {
    state.snapshotGen += 1;
    state.snapshot = null;
    state.snapshotAt = 0;
    state.hadActiveCountdown = false;
    state.hadReadyItem = false;
    state.pendingOps = new Set();
    state.doneCollapsed = null;
    state.draftSeq += 1;
    state.draftText = '';
    state.editing = null;
    state.error = '';
    state.webPanel = null;
    stopHoldRenew(state);
    $.ui.invalidate('ui.render');
  }
}

async function invokeBridge($, state, { action, payload, sessionId = state.sessionId }) {
  try {
    const bridgePath = await resolveBridgePath($, state);
    if (!bridgePath) {
      return { ok: false, error: '找不到 Fons 桥接脚本，请重新运行 fons claude init 并 /reload-plugins。' };
    }
    const run = await $.process.run(['node', bridgePath, action], {
      cwd: state.cwd || undefined,
      env: { FONS_BRIDGE_INPUT: JSON.stringify({ ...payload, sessionId }) },
      timeoutMs: BRIDGE_TIMEOUT_MS,
    });
    const parsed = parseJson(run?.stdout);
    if (isPlainObject(parsed)) return parsed;
    const stderr = String(run?.stderr ?? '').trim().split('\n')[0];
    return { ok: false, error: stderr || ('Fons 桥接返回异常（exit ' + run?.exitCode + '）。') };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

async function applySnapshot($, state, snapshot) {
  state.snapshot = snapshot;
  state.snapshotAt = await $.clock.now();
  state.hadActiveCountdown = hasActiveCountdown(state, state.snapshotAt);
  state.hadReadyItem = hasReadyItem(state, state.snapshotAt);
  if (!snapshot.canArchive) state.doneCollapsed = null;
  if (state.editing) {
    const matches = snapshot.items.filter((item) => item.id === state.editing.id && item.status === 'buffering');
    const row = matches.find((item) => item.rowIndex === state.editing.rowIndex)
      ?? (matches.length === 1 ? matches[0] : null);
    if (row) {
      state.editing.rowIndex = row.rowIndex;
    } else {
      state.editing = null;
      stopHoldRenew(state);
    }
  }
}

function flushQueuedRefresh($, state) {
  if (state.activeOps === 0 && state.refreshQueued) {
    state.refreshQueued = false;
    void refreshSnapshot($, state);
  }
}

async function refreshSnapshot($, state) {
  if (state.activeOps > 0) {
    state.refreshQueued = true;
    return;
  }
  state.activeOps += 1;
  let gen = state.snapshotGen;
  try {
    await syncSessionMeta($, state);
    if (state.activeOps > 1) {
      state.refreshQueued = true;
      return;
    }
    gen = state.snapshotGen;
    const response = await invokeBridge($, state, { action: 'snapshot', payload: {} });
    if (gen !== state.snapshotGen) return;
    const previousError = state.error;
    if (response.ok) {
      state.error = '';
      if (state.snapshot && state.snapshot.etag === response.etag) {
        if (previousError) $.ui.invalidate('ui.render');
        return;
      }
      await applySnapshot($, state, response);
    } else {
      state.error = response.error || '读取 Fons 灵感池失败。';
      if (state.error === previousError) return;
    }
    $.ui.invalidate('ui.render');
  } catch (error) {
    if (gen === state.snapshotGen) {
      state.error = errorMessage(error);
      $.ui.invalidate('ui.render');
    }
  } finally {
    state.activeOps -= 1;
    flushQueuedRefresh($, state);
  }
}

async function runPoolOp($, state, operation) {
  const { pendingKey, sessionId = state.sessionId } = operation;
  const pending = state.pendingOps;
  if (pendingKey) {
    if (pending.has(pendingKey)) return { ok: false };
    pending.add(pendingKey);
    $.ui.invalidate('ui.render');
  }
  state.activeOps += 1;
  // An older poll may already be awaiting its bridge response.
  state.snapshotGen += 1;
  try {
    await syncSessionMeta($, state);
    if (sessionId && state.sessionId !== sessionId) return { ok: false, error: '会话已切换。' };
    return await executePoolMutation($, state, operation);
  } catch (error) {
    state.error = errorMessage(error);
    $.ui.toast(state.error);
    return { ok: false, error: state.error };
  } finally {
    pending.delete(pendingKey);
    state.activeOps -= 1;
    $.ui.invalidate('ui.render');
    flushQueuedRefresh($, state);
  }
}

async function executePoolMutation($, state, { op, data }) {
  const sessionId = state.sessionId;
  const gen = ++state.snapshotGen;
  const response = await invokeBridge($, state, { action: 'pool', payload: { op, data }, sessionId });
  if (sessionId !== state.sessionId) return { ok: false, error: '会话已切换。' };
  if (gen !== state.snapshotGen) {
    state.refreshQueued = true;
  } else if (response.snapshot?.ok) {
    await applySnapshot($, state, response.snapshot);
  }
  if (!response.ok) {
    state.error = response.error || 'Fons 操作失败。';
    $.ui.toast(state.error);
  } else {
    state.error = '';
    if (response.result.conflict) $.ui.toast('条目已变化，已自动刷新列表。');
  }
  return response;
}

async function openPane($, state, { focus = true, manual = true, refresh = 'always' } = {}) {
  state.openedManually = manual;
  if (manual) state.userTouchedPane = true;
  // Claude host rejects focus: false; omit focus unless true.
  const openOptions = focus
    ? { id: PANE_ID, title: PANE_TITLE, focus: true }
    : { id: PANE_ID, title: PANE_TITLE };
  const placed = await $.ui.open(openOptions);
  state.isOpen = placed?.isPlaced !== false;
  $.ui.invalidate('ui.render');
  if (state.isOpen && (refresh === 'always' || !state.snapshot)) {
    await refreshSnapshot($, state);
  }
}

function clearClosedPaneState($, state) {
  state.userTouchedPane = true;
  state.isOpen = false;
  state.showSettings = false;
  const releasing = cancelEdit($, state);
  $.ui.invalidate('ui.render');
  return releasing;
}

async function closePane($, state) {
  const releasing = clearClosedPaneState($, state);
  await Promise.all([
    releasing,
    $.ui.close({ id: PANE_ID }).catch(() => undefined),
  ]);
}

async function togglePane($, state) {
  const panes = await $.ui.panes().catch(() => []);
  const currentlyOpen = panes.some((pane) => pane.id === PANE_ID);
  if (currentlyOpen) {
    await closePane($, state);
    return false;
  }
  await openPane($, state, { focus: true, manual: true, refresh: 'always' });
  return true;
}

async function openWebPanel($, state) {
  await syncSessionMeta($, state);
  const targetSessionId = state.sessionId;
  const existing = state.webPanel?.sessionId === targetSessionId ? state.webPanel : null;
  const response = await invokeBridge($, state, {
    action: 'open-web',
    sessionId: targetSessionId,
    payload: {
      scope: state.snapshot?.scope,
      existingPid: existing?.pid,
      existingUrl: existing?.url,
    },
  });
  if (response.ok) {
    if (state.sessionId === targetSessionId) {
      state.webPanel = { sessionId: targetSessionId, pid: response.pid, url: response.url };
    }
    $.ui.toast(response.reused ? '已唤起 Fons 网页版面板' : '已在浏览器打开 Fons 网页版面板');
  } else {
    $.ui.toast(response.error || '无法打开 Fons 网页版面板');
  }
  return response;
}

async function startEdit($, state, item) {
  if (state.editing?.rowIndex === item.rowIndex && state.editing.id === item.id) return;
  if (state.editing) await cancelEdit($, state);
  const editing = {
    id: item.id,
    rowIndex: item.rowIndex,
    raw: item.raw,
    initialText: item.note,
    keepAttachments: item.attachments.map((att) => att.storedName),
  };
  state.editing = editing;
  const pendingKey = 'item-' + item.rowIndex + '-' + item.id;
  const response = await runPoolOp($, state, { op: 'hold', data: { id: item.id }, pendingKey });
  if (state.editing !== editing) return;
  if (!response.ok || !response.result.editingHold) {
    state.editing = null;
    $.ui.invalidate('ui.render');
    return;
  }
  stopHoldRenew(state);
  state.holdTimer = $.clock.every(HOLD_RENEW_MS, () => {
    if (state.editing?.id !== item.id) {
      stopHoldRenew(state);
      return;
    }
    void invokeBridge($, state, { action: 'pool', payload: { op: 'hold', data: { id: item.id } } });
  });
  $.ui.invalidate('ui.render');
}

async function cancelEdit($, state) {
  if (!state.editing) return;
  const id = state.editing.id;
  state.editing = null;
  stopHoldRenew(state);
  await runPoolOp($, state, { op: 'release', data: { id } });
}

async function saveEdit($, state, rawValue) {
  const editing = state.editing;
  if (!editing) return;
  const nextText = String(rawValue ?? '').trim();
  if (!nextText && !editing.keepAttachments.length) {
    $.ui.toast('灵感内容不能为空；如需删除请点击删除按钮。');
    return;
  }
  editing.initialText = nextText;
  const payload = {
    rowIndex: editing.rowIndex,
    expectedRaw: editing.raw,
    newText: nextText,
    keepAttachments: editing.keepAttachments,
  };
  const pendingKey = 'item-' + editing.rowIndex + '-' + editing.id;
  const response = await runPoolOp($, state, { op: 'update', data: payload, pendingKey });
  if (response.ok && state.editing === editing) {
    if (response.result.conflict) {
      await cancelEdit($, state);
    } else {
      state.editing = null;
      stopHoldRenew(state);
      $.ui.invalidate('ui.render');
    }
  }
}

async function submitDraft($, state, rawValue) {
  const lines = splitDraftLines(rawValue);
  if (!lines.length) return;
  state.draftText = rawValue;
  const response = await runPoolOp($, state, { op: 'add', data: { texts: lines }, pendingKey: 'draft' });
  if (!response.ok) return;
  if (state.draftText === rawValue) {
    state.draftText = '';
    state.draftSeq += 1;
    $.ui.invalidate('ui.render');
  }
  $.ui.toast('已入池 ' + lines.length + ' 条灵感');
}

async function updateSettings($, state, patch) {
  const response = await runPoolOp($, state, { op: 'settings', data: { update: patch }, pendingKey: 'settings' });
  if (response.ok) $.ui.toast('已保存 Fons 设置');
}

function hasActiveCountdown(state, now) {
  const snapshot = state.snapshot;
  if (!snapshot?.items?.length || !snapshot.debounceMs) return false;
  return snapshot.items.some(
    (item) => item.status === 'buffering' && !item.editingHold && state.editing?.id !== item.id && liveRemainingMs(state, item, now) > 0,
  );
}

function hasReadyItem(state, now) {
  return state.snapshot?.items.some((item) =>
    item.status === 'buffering' && !item.editingHold && state.editing?.id !== item.id && liveRemainingMs(state, item, now) === 0,
  ) ?? false;
}

async function handleFonsCommand($, state, rawArgs) {
  const arg = String(rawArgs ?? '').trim();
  if (!arg) {
    const opened = await togglePane($, state);
    return { text: opened ? '已打开 Fons 灵感池侧栏。' : '已关闭 Fons 灵感池侧栏。' };
  }
  const lower = arg.toLowerCase();
  if (lower === 'open') {
    await openPane($, state, { focus: true, manual: true, refresh: 'always' });
    return { text: '已打开 Fons 灵感池侧栏。' };
  }
  if (lower === 'close') {
    await closePane($, state);
    return { text: '已关闭 Fons 灵感池侧栏。' };
  }
  if (lower === 'web') {
    const result = await openWebPanel($, state);
    return { text: result.ok ? '已在浏览器打开 Fons 网页版面板。' : (result.error || '无法打开 Fons 网页版面板。') };
  }
  const lines = splitDraftLines(arg);
  const response = await runPoolOp($, state, { op: 'add', data: { texts: lines }, sessionId: '' });
  if (!response.ok) return { text: '入池失败：' + (response.error || '未知错误') };
  return { text: '已加入 Fons 灵感池：' + lines.join(' / ') };
}

async function tickCountdown($, state) {
  const now = await $.clock.now();
  const active = hasActiveCountdown(state, now);
  const ready = hasReadyItem(state, now);
  if (state.isOpen ? active || state.hadActiveCountdown : ready !== state.hadReadyItem) {
    $.ui.invalidate('ui.render');
  }
  state.hadActiveCountdown = active;
  state.hadReadyItem = ready;
}

function startTimers($, state) {
  state.tickTimer?.cancel();
  state.tickTimer = $.clock.every(TICK_MS, () => {
    void tickCountdown($, state).catch(() => undefined);
  });
  state.pollTimer?.cancel();
  state.pollTimer = $.clock.every(POLL_MS, () => {
    if (state.isOpen && state.activeOps === 0) {
      void refreshSnapshot($, state);
    }
  });
}

async function syncAndRefreshWithRetry($, state) {
  await syncSessionMeta($, state);
  await refreshSnapshot($, state);
  if (!state.snapshot?.registered) {
    $.clock.after(600, () => {
      if (!state.snapshot?.registered) void refreshSnapshot($, state);
    });
  }
}

async function autoOpenOnStart($, state, surface) {
  try {
    await syncAndRefreshWithRetry($, state);
    if (!state.openAtStart || state.userTouchedPane) return;
    const surfaces = await $.session.surfaces().catch(() => []);
    if (surface === 'terminal' || surfaces.includes('terminal')) return;
    await openPane($, state, { focus: false, manual: false, refresh: 'if-missing' });
  } catch (error) {
    $.ui.log('fons auto-open failed: ' + errorMessage(error), { to: 'debug' });
  }
}

export function register(on, options) {
  const state = createInitialState(options);

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'fons',
      description: '开关 Fons 灵感池侧栏，或 /fons <内容> 直接入池（支持 open / close / web）',
      argumentHint: '[open | close | web | <灵感内容>]',
      immediate: true,
    });
    startTimers($, state);
    $.clock.after(0, () => { void autoOpenOnStart($, state, e?.surface); });
    return next(e);
  });

  on('turn.complete', async ($, e, next) => {
    const result = await next(e);
    if (!e.agentId) {
      $.clock.after(350, () => { void refreshSnapshot($, state); });
    }
    return result;
  });

  on('command.run', { command: 'fons' }, async ($, e) => handleFonsCommand($, state, e.args));

  on('ui.focus', { component: 'Pane', requestId: PANE_ID }, async ($, e, next) => {
    const result = await next(e);
    void refreshSnapshot($, state);
    return result;
  });

  on('ui.close', ($, e, next) => {
    if (e.id === PANE_ID || e.requestId === PANE_ID) {
      void clearClosedPaneState($, state);
    }
    return next(e);
  });

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e, next) => {
    if (e.surface !== 'terminal' && e.surface !== 'desktop') return next(e);
    if (e.surface === 'terminal' && e.props?.placement === 'inline' && !state.openedManually) {
      state.isOpen = false;
      void $.ui.close({ id: PANE_ID }).catch(() => undefined);
      const { Box } = $.ui.resolve(e);
      return Box({});
    }
    if (!state.isOpen) {
      state.isOpen = true;
      if (!state.snapshot) void refreshSnapshot($, state);
    }
    const ui = $.ui.resolve(e);
    const now = await $.clock.now();
    return renderPaneBody(state, ui, now, e.surface, {
      redraw: () => $.ui.invalidate('ui.render'),
      toast: (message) => $.ui.toast(message),
      refreshSnapshot: () => refreshSnapshot($, state),
      runPoolOp: (operation) => runPoolOp($, state, operation),
      startEdit: (item) => startEdit($, state, item),
      cancelEdit: () => cancelEdit($, state),
      saveEdit: (value) => saveEdit($, state, value),
      submitDraft: (value) => submitDraft($, state, value),
      updateSettings: (patch) => updateSettings($, state, patch),
      openWebPanel: () => openWebPanel($, state),
    });
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (state.isOpen || e.props?.hasSurvey) return next(e);
    const counts = summarizeItems(state.snapshot?.items);
    if (!counts.buffering && !counts.delivered) return next(e);
    const drawn = await Promise.resolve(next(e)).catch(() => null);
    const below = drawn && typeof drawn === 'object' && drawn.type !== 'engine' ? drawn : null;
    const { Box, Text, Button } = $.ui.resolve(e);
    const ready = hasReadyItem(state, await $.clock.now());
    const row = Box({
      key: 'fons-band',
      flexDirection: 'row',
      gap: 1,
      children: [
        Text({ color: 'cyan', bold: true, children: '💧 Fons' }),
        Text({ dimColor: true, children: formatCountsSummary(counts) + (ready ? '（含就绪待投）' : '') }),
        Button({ key: 'open-fons-pane', label: '打开侧栏', plain: true, onPress: () => openPane($, state, { focus: true, manual: true, refresh: 'always' }) }),
      ],
    });
    return below ? Box({ flexDirection: 'column', children: [row, below] }) : row;
  });
}
