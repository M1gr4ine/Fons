const PANE_ID = 'fons-pool';
const PANE_TITLE = 'Fons · 灵感池';
const DEFAULT_DEBOUNCE_SEC = 15;
const DEBOUNCE_PRESETS = [0, 15, 30, 45];
const TICK_MS = 1000;
const POLL_MS = 2500;
const HOLD_RENEW_MS = 10_000;
const BRIDGE_TIMEOUT_MS = 8000;
const BAR_WIDTH = 8;

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
    error: '',
    draftSeq: 0,
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
  if (state.editing) {
    const stillBuffering = (snapshot.items ?? []).some(
      (item) => item.id === state.editing.id && item.status === 'buffering',
    );
    if (!stillBuffering) {
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
    if (response.ok) {
      state.error = '';
      await applySnapshot($, state, response);
    } else {
      state.error = response.error || '读取 Fons 灵感池失败。';
    }
  } catch (error) {
    if (gen === state.snapshotGen) {
      state.error = errorMessage(error);
    }
  } finally {
    state.activeOps -= 1;
    $.ui.invalidate('ui.render');
    flushQueuedRefresh($, state);
  }
}

async function runPoolOp($, state, { op, data }) {
  state.activeOps += 1;
  // Bump before awaiting so any in-flight refreshSnapshot discards its stale result; bump again after syncSessionMeta so this op claims the newest generation.
  state.snapshotGen += 1;
  try {
    await syncSessionMeta($, state);
    const gen = ++state.snapshotGen;
    const response = await invokeBridge($, state, { action: 'pool', payload: { op, data } });
    if (gen === state.snapshotGen && response.snapshot?.ok) {
      await applySnapshot($, state, response.snapshot);
    }
    if (!response.ok) {
      state.error = response.error || 'Fons 操作失败。';
      $.ui.toast(state.error);
      return response;
    }
    state.error = '';
    if (response.result?.conflict) {
      $.ui.toast('条目已变化，已自动刷新列表。');
    }
    return response;
  } catch (error) {
    state.error = errorMessage(error);
    $.ui.toast(state.error);
    return { ok: false, error: state.error };
  } finally {
    state.activeOps -= 1;
    $.ui.invalidate('ui.render');
    flushQueuedRefresh($, state);
  }
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
  if (state.editing?.id === item.id) return;
  if (state.editing) await cancelEdit($, state);
  state.editing = {
    id: item.id,
    rowIndex: item.rowIndex,
    raw: item.raw,
    initialText: item.note || item.text,
    keepAttachments: (item.attachments || []).map((att) => att.storedName),
  };
  const response = await runPoolOp($, state, { op: 'hold', data: { id: item.id } });
  if (!response.ok) {
    if (state.editing?.id === item.id) state.editing = null;
    $.ui.invalidate('ui.render');
    return;
  }
  if (state.editing?.id !== item.id) return;
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
  state.editing = null;
  stopHoldRenew(state);
  const payload = {
    rowIndex: editing.rowIndex,
    expectedRaw: editing.raw,
    newText: nextText,
  };
  if (editing.keepAttachments.length) payload.keepAttachments = editing.keepAttachments;
  await runPoolOp($, state, { op: 'update', data: payload });
}

async function submitDraft($, state, rawValue) {
  const lines = splitDraftLines(rawValue);
  if (!lines.length) return;
  state.draftSeq += 1;
  $.ui.invalidate('ui.render');
  const response = await runPoolOp($, state, { op: 'add', data: { texts: lines } });
  if (response.ok) $.ui.toast('已入池 ' + lines.length + ' 条灵感');
}

async function updateSettings($, state, patch) {
  const response = await runPoolOp($, state, { op: 'settings', data: { update: patch } });
  if (response.ok) $.ui.toast('已保存 Fons 设置');
}

function summarizeItems(items) {
  let buffering = 0;
  let delivered = 0;
  let done = 0;
  for (const item of items || []) {
    if (item.status === 'buffering') buffering += 1;
    else if (item.status === 'delivered') delivered += 1;
    else if (item.status === 'done') done += 1;
  }
  return { buffering, delivered, done };
}

function formatCountsSummary(counts, { includeDone = false } = {}) {
  const parts = [];
  if (counts.buffering) parts.push('蓄水 ' + counts.buffering);
  if (counts.delivered) parts.push('已投递 ' + counts.delivered);
  if (includeDone && counts.done) parts.push('已完成 ' + counts.done);
  return parts.join(' · ');
}

function liveRemainingMs(state, item, now) {
  if (item.status !== 'buffering') return 0;
  if (item.editingHold || state.editing?.id === item.id) return item.remainingMs;
  const elapsed = Math.max(0, now - state.snapshotAt);
  return Math.max(0, item.remainingMs - elapsed);
}

function hasActiveCountdown(state, now) {
  const snapshot = state.snapshot;
  if (!snapshot?.items?.length || !snapshot.debounceMs) return false;
  return snapshot.items.some(
    (item) => item.status === 'buffering' && !item.editingHold && state.editing?.id !== item.id && liveRemainingMs(state, item, now) > 0,
  );
}

function progressBar(remainingMs, debounceMs) {
  if (!debounceMs || remainingMs <= 0) return '▓'.repeat(BAR_WIDTH) + ' 就绪';
  const ratio = Math.max(0, Math.min(1, 1 - remainingMs / debounceMs));
  const filled = Math.round(ratio * BAR_WIDTH);
  const secs = Math.ceil(remainingMs / 1000);
  return '▓'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled) + ' ' + secs + 's';
}

function renderSettingsPanel($, state, ui, snapshot) {
  const { Box, Text, Button } = ui;
  const settings = snapshot?.settings;
  const config = settings?.config || { debounceSec: DEFAULT_DEBOUNCE_SEC, stopWaitDebounce: false };
  const overrides = settings?.envOverrides || {};
  const workspace = settings?.currentWorkspace;

  const presetButtons = DEBOUNCE_PRESETS.map((sec) => {
    const active = config.debounceSec === sec;
    return Button({
      key: 'db-' + sec,
      label: active ? sec + 's ●' : sec + 's',
      plain: true,
      dimColor: !active,
      onPress: () => updateSettings($, state, { debounceSec: sec }),
    });
  });

  const rows = [
    Box({
      flexDirection: 'row',
      justifyContent: 'space-between',
      children: [
        Text({ bold: true, color: 'cyan', children: '⚙ 灵感池设置' }),
        Button({
          key: 'close-settings',
          label: '收起',
          plain: true,
          onPress: () => { state.showSettings = false; $.ui.invalidate('ui.render'); },
        }),
      ],
    }),
    Box({
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 1,
      children: [
        Text({ dimColor: true, children: '蓄水时长:' }),
        ...presetButtons,
      ],
    }),
  ];
  if (overrides.debounceSec) {
    rows.push(Text({ dimColor: true, children: '  （当前受环境变量 FONS_DEBOUNCE_SEC 覆盖）' }));
  }

  rows.push(Box({
    flexDirection: 'row',
    gap: 1,
    children: [
      Text({ dimColor: true, children: '收尾等蓄水满:' }),
      Button({
        key: 'toggle-stop-wait',
        label: config.stopWaitDebounce ? '已开启 ●' : '已关闭 ○',
        plain: true,
        dimColor: !config.stopWaitDebounce,
        onPress: () => updateSettings($, state, { stopWaitDebounce: !config.stopWaitDebounce }),
      }),
    ],
  }));
  if (overrides.stopWaitDebounce) {
    rows.push(Text({ dimColor: true, children: '  （当前受环境变量 FONS_STOP_WAIT_DEBOUNCE 覆盖）' }));
  }

  if (workspace?.path) {
    rows.push(Box({
      flexDirection: 'row',
      gap: 1,
      children: [
        Text({ dimColor: true, children: '工作区 ' + workspace.name + ':' }),
        Button({
          key: 'toggle-ws',
          label: workspace.enabled ? '已启用 ●' : '已停用 ○',
          plain: true,
          dimColor: !workspace.enabled,
          onPress: () => updateSettings($, state, {
            workspaceAction: { path: workspace.path, mode: workspace.enabled ? 'disable' : 'enable' },
          }),
        }),
      ],
    }));
  }

  return Box({
    key: 'settings-box',
    flexDirection: 'column',
    borderStyle: 'round',
    borderColor: 'gray',
    paddingX: 1,
    marginBottom: 1,
    children: rows,
  });
}

function renderItemRow($, ui, { state, item, debounceMs, now }) {
  const { Box, Text, Button } = ui;
  const attCount = item.attachments?.length || 0;
  const displayText = item.note || (attCount ? '（仅附件）' : item.text);
  const attSuffix = attCount ? '  📎 ' + attCount : '';
  const isEditingThis = state.editing?.id === item.id;

  let glyph = '○';
  let glyphColor = 'cyan';
  let statusLine = '';
  const actions = [];

  if (item.status === 'buffering') {
    const remMs = liveRemainingMs(state, item, now);
    statusLine = (item.editingHold || isEditingThis) ? '✎ 编辑暂缓' : progressBar(remMs, debounceMs);
    actions.push(
      Button({ key: 'edit-' + item.rowIndex, label: isEditingThis ? '编辑中' : '编辑', plain: true, onPress: () => startEdit($, state, item) }),
      Button({ key: 'done-' + item.rowIndex, label: '完成', plain: true, onPress: () => runPoolOp($, state, { op: 'complete', data: { token: item.token } }) }),
      Button({ key: 'del-' + item.rowIndex, label: '删除', plain: true, dimColor: true, onPress: () => runPoolOp($, state, { op: 'remove', data: { rowIndex: item.rowIndex, expectedRaw: item.raw } }) }),
    );
  } else if (item.status === 'delivered') {
    glyph = '◉';
    glyphColor = 'yellow';
    statusLine = '已投递 · 等待回执';
    actions.push(
      Button({ key: 'done-' + item.rowIndex, label: '完成', plain: true, onPress: () => runPoolOp($, state, { op: 'complete', data: { token: item.token } }) }),
      Button({ key: 'ret-' + item.rowIndex, label: '撤回', plain: true, onPress: () => runPoolOp($, state, { op: 'remove', data: { rowIndex: item.rowIndex, expectedRaw: item.raw } }) }),
    );
  } else {
    glyph = '✓';
    glyphColor = 'green';
    statusLine = '已完成';
    actions.push(
      Button({ key: 'reopen-' + item.rowIndex, label: '重开', plain: true, dimColor: true, onPress: () => runPoolOp($, state, { op: 'reopen', data: { rowIndex: item.rowIndex, expectedRaw: item.raw } }) }),
    );
  }

  return Box({
    key: 'item-' + item.rowIndex + '-' + item.id,
    flexDirection: 'column',
    marginBottom: 1,
    children: [
      Box({
        flexDirection: 'row',
        children: [
          Text({ color: glyphColor, bold: item.status !== 'done', children: glyph + ' ' }),
          Text({ dimColor: item.status === 'done', wrap: 'wrap', children: displayText + attSuffix }),
        ],
      }),
      Box({
        flexDirection: 'row',
        gap: 1,
        children: [
          Text({ dimColor: true, color: item.status === 'delivered' ? 'yellow' : undefined, children: '  ' + statusLine }),
          ...actions,
        ],
      }),
    ],
  });
}

function renderHeader($, state, ui, snapshot, items) {
  const { Box, Text, Button } = ui;
  const summaryText = formatCountsSummary(summarizeItems(items), { includeDone: true }) || '空闲';
  const headerButtons = [
    Button({ key: 'refresh', label: '↻', plain: true, onPress: () => refreshSnapshot($, state) }),
  ];
  if (snapshot?.canArchive) {
    headerButtons.push(Button({ key: 'archive', label: '归档', plain: true, onPress: () => runPoolOp($, state, { op: 'archive', data: {} }) }));
  }
  headerButtons.push(
    Button({
      key: 'settings',
      label: state.showSettings ? '⚙ ●' : '⚙',
      plain: true,
      dimColor: !state.showSettings,
      onPress: () => { state.showSettings = !state.showSettings; $.ui.invalidate('ui.render'); },
    }),
    Button({ key: 'web', label: '网页版', plain: true, onPress: () => openWebPanel($, state) }),
  );
  return Box({
    key: 'header',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 1,
    children: [
      Box({
        flexDirection: 'row',
        gap: 1,
        children: [
          Text({ bold: true, color: 'cyan', children: '💧 ' + PANE_TITLE }),
          Text({ dimColor: true, children: summaryText }),
        ],
      }),
      Box({ flexDirection: 'row', gap: 1, children: headerButtons }),
    ],
  });
}

function renderComposerOrNotice($, state, ui, snapshot, canWrite) {
  const { Box, Text, Button, Input } = ui;
  const workspace = snapshot?.settings?.currentWorkspace;
  if (snapshot?.workspaceDisabled && workspace?.path) {
    return Box({
      key: 'ws-disabled',
      flexDirection: 'column',
      marginBottom: 1,
      children: [
        Text({ color: 'yellow', children: '当前工作区已停用 Fons：' + workspace.name }),
        Button({
          key: 'enable-ws',
          label: '启用当前工作区',
          variant: 'primary',
          onPress: () => updateSettings($, state, { workspaceAction: { path: workspace.path, mode: 'enable' } }),
        }),
      ],
    });
  }
  if (snapshot && !snapshot.registered) {
    return Box({
      key: 'unregistered',
      flexDirection: 'column',
      marginBottom: 1,
      children: [
        Text({ dimColor: true, wrap: 'wrap', children: '当前会话尚未登记到 Fons（若是刚安装或启用插件，请新开会话或点击刷新）。' }),
        Button({ key: 'refresh-unreg', label: '刷新状态', plain: true, onPress: () => refreshSnapshot($, state) }),
      ],
    });
  }
  if (!canWrite || !('Input' in ui)) return null;
  if (state.editing) {
    return Box({
      key: 'edit-box',
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: 'cyan',
      paddingX: 1,
      marginBottom: 1,
      children: [
        Box({
          flexDirection: 'row',
          justifyContent: 'space-between',
          children: [
            Text({ color: 'cyan', children: '编辑中（已暂缓该条蓄水计时）' }),
            Button({ key: 'cancel-edit', label: '取消', plain: true, onPress: () => cancelEdit($, state) }),
          ],
        }),
        Input({
          key: 'edit-input-' + state.editing.id,
          label: '✎ ',
          placeholder: '修改灵感内容，Enter 保存…',
          submitLabel: '保存',
          autoFocus: true,
          value: state.editing.initialText,
          onSubmit: (value) => saveEdit($, state, value),
        }),
      ],
    });
  }
  return Box({
    key: 'draft-box',
    marginBottom: 1,
    children: [
      Input({
        key: 'draft-' + state.draftSeq,
        label: '+ ',
        placeholder: '记下补充灵感，Enter 入池…',
        submitLabel: '入池',
        value: '',
        onSubmit: (value) => submitDraft($, state, value),
      }),
    ],
  });
}

function renderPaneBody($, state, ui, now) {
  const { Box, Text, Button } = ui;
  const snapshot = state.snapshot;
  const items = snapshot?.items || [];
  const canWrite = Boolean(snapshot?.registered && !snapshot?.workspaceDisabled);

  const sections = [renderHeader($, state, ui, snapshot, items)];
  if (state.showSettings) {
    sections.push(renderSettingsPanel($, state, ui, snapshot));
  }
  if (state.error) {
    sections.push(Box({
      key: 'err',
      flexDirection: 'row',
      gap: 1,
      marginBottom: 1,
      children: [
        Text({ color: 'red', wrap: 'wrap', children: state.error }),
        Button({ key: 'retry', label: '重试', plain: true, onPress: () => refreshSnapshot($, state) }),
      ],
    }));
  }

  const primary = renderComposerOrNotice($, state, ui, snapshot, canWrite);
  if (primary) sections.push(primary);

  if (canWrite && !items.length) {
    sections.push(Text({
      key: 'empty',
      dimColor: true,
      wrap: 'wrap',
      children: '灵感池为空。边看 Claude 干活边记下不紧急的补充；蓄水到期后自动注入，不打断当前心流。传截图/附件请点右上角「网页版」。',
    }));
  } else if (items.length) {
    sections.push(Box({
      key: 'items',
      flexDirection: 'column',
      children: items.map((item) => renderItemRow($, ui, { state, item, debounceMs: snapshot.debounceMs, now })),
    }));
  }

  sections.push(Box({
    key: 'footer',
    marginTop: 1,
    children: [
      Text({ dimColor: true, children: '/fons 开关侧栏 · /fons <内容> 速记 · /fons web 网页版' }),
    ],
  }));

  return Box({
    flexDirection: 'column',
    paddingX: 1,
    children: sections,
  });
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
  const response = await runPoolOp($, state, { op: 'add', data: { texts: lines } });
  if (!response.ok) return { text: '入池失败：' + (response.error || '未知错误') };
  return { text: '已加入 Fons 灵感池：' + lines.join(' / ') };
}

async function tickCountdown($, state) {
  const now = await $.clock.now();
  const active = hasActiveCountdown(state, now);
  if (active || state.hadActiveCountdown) {
    state.hadActiveCountdown = active;
    $.ui.invalidate('ui.render');
  }
}

function startTimers($, state) {
  state.tickTimer?.cancel();
  state.tickTimer = $.clock.every(TICK_MS, () => {
    if (!state.isOpen) return;
    void tickCountdown($, state).catch(() => undefined);
  });
  state.pollTimer?.cancel();
  state.pollTimer = $.clock.every(POLL_MS, () => {
    if (state.isOpen && state.activeOps === 0 && !state.editing) {
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
    return renderPaneBody($, state, ui, now);
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (state.isOpen || e.props?.hasSurvey) return next(e);
    const counts = summarizeItems(state.snapshot?.items);
    if (!counts.buffering && !counts.delivered) return next(e);
    const drawn = await Promise.resolve(next(e)).catch(() => null);
    const below = drawn && typeof drawn === 'object' && drawn.type !== 'engine' ? drawn : null;
    const { Box, Text, Button } = $.ui.resolve(e);
    const row = Box({
      key: 'fons-band',
      flexDirection: 'row',
      gap: 1,
      children: [
        Text({ color: 'cyan', bold: true, children: '💧 Fons' }),
        Text({ dimColor: true, children: formatCountsSummary(counts) }),
        Button({ key: 'open-fons-pane', label: '打开侧栏', plain: true, onPress: () => openPane($, state, { focus: true, manual: true, refresh: 'always' }) }),
      ],
    });
    return below ? Box({ flexDirection: 'column', children: [row, below] }) : row;
  });
}
