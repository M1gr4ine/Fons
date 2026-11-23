const DEBOUNCE_PRESETS = [0, 15, 30, 45];

export function summarizeItems(items = []) {
  const counts = { buffering: 0, delivered: 0, done: 0 };
  for (const item of items) counts[item.status] += 1;
  return counts;
}

export function formatCountsSummary(counts, { includeDone = false } = {}) {
  const parts = [];
  if (counts.buffering) parts.push('蓄水 ' + counts.buffering);
  if (counts.delivered) parts.push('已投递 ' + counts.delivered);
  if (includeDone && counts.done) parts.push('已完成 ' + counts.done);
  return parts.join(' · ');
}

export function liveRemainingMs(state, item, now) {
  if (item.status !== 'buffering') return 0;
  if (item.editingHold || state.editing?.id === item.id) return item.remainingMs;
  return Math.max(0, item.remainingMs - Math.max(0, now - state.snapshotAt));
}

function renderHeader(ctx, items) {
  const { state, ui, snapshot, actions } = ctx;
  const { Box, Text, Button } = ui;
  const summary = snapshot
    ? (formatCountsSummary(summarizeItems(items), { includeDone: true }) || '空闲')
    : '同步中…';
  const workspace = snapshot?.settings?.currentWorkspace?.name || '无工作区';
  return Box({
    key: 'header',
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    marginBottom: 1,
    children: [
      Box({
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 1,
        children: [
          Text({ bold: true, color: 'cyan', children: '📁 ' + workspace }),
          Text({ dimColor: true, children: summary }),
        ],
      }),
      Box({
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 1,
        children: [
          Button({ key: 'refresh', label: '↻', plain: true, onPress: actions.refreshSnapshot }),
          Button({
            key: 'settings',
            label: state.showSettings ? '⚙ ●' : '⚙',
            plain: true,
            dimColor: !state.showSettings,
            onPress: () => {
              state.showSettings = !state.showSettings;
              actions.redraw();
            },
          }),
          Button({ key: 'web', label: '网页版', plain: true, onPress: actions.openWebPanel }),
        ],
      }),
    ],
  });
}

function toggleSetting(ui, key, title, value, onPress) {
  const { Box, Text, Button } = ui;
  return Box({
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 1,
    children: [
      Text({ dimColor: true, children: title }),
      Button({ key, label: value ? '已开启 ●' : '已关闭 ○', plain: true, dimColor: !value, onPress }),
    ],
  });
}

function renderSettingsPanel(ctx) {
  const { state, ui, snapshot, actions } = ctx;
  const { Box, Text, Button } = ui;
  const settings = snapshot?.settings;
  const rows = [Box({
    flexDirection: 'row',
    justifyContent: 'space-between',
    children: [
      Text({ bold: true, color: 'cyan', children: '⚙ 灵感池设置' }),
      Button({
        key: 'close-settings',
        label: '收起',
        plain: true,
        onPress: () => {
          state.showSettings = false;
          actions.redraw();
        },
      }),
    ],
  })];
  if (!settings) {
    rows.push(Text({ dimColor: true, children: '同步中…' }));
  } else if (state.pendingOps.has('settings')) {
    rows.push(Text({ dimColor: true, children: '处理中…' }));
  } else {
    rows.push(...renderSettingsControls(ctx, settings));
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

function renderSettingsControls(ctx, settings) {
  const { ui, actions } = ctx;
  const { Box, Text, Button, Input } = ui;
  const { config, envOverrides: overrides, currentWorkspace: workspace } = settings;
  const presets = DEBOUNCE_PRESETS.map((sec) => Button({
    key: 'db-' + sec,
    label: sec + 's' + (config.debounceSec === sec ? ' ●' : ''),
    plain: true,
    dimColor: config.debounceSec !== sec,
    onPress: () => actions.updateSettings({ debounceSec: sec }),
  }));
  const presetRow = [Text({ dimColor: true, children: '蓄水时长' }), ...presets];
  if (!DEBOUNCE_PRESETS.includes(config.debounceSec)) {
    presetRow.push(Text({ color: 'cyan', children: '当前 ' + config.debounceSec + 's ●' }));
  }
  const rows = [Box({ flexDirection: 'row', flexWrap: 'wrap', gap: 1, children: presetRow })];
  if ('Input' in ui) {
    rows.push(Input({
      key: 'debounce-input',
      label: '自定义(秒): ',
      placeholder: '0–3600',
      submitLabel: '应用',
      value: String(config.debounceSec),
      onSubmit: (value) => {
        const raw = String(value).trim();
        if (!/^\d+$/.test(raw) || Number(raw) > 3600) {
          actions.toast('请输入 0–3600 的整数秒数');
          return;
        }
        return actions.updateSettings({ debounceSec: Number(raw) });
      },
    }));
  }
  if (overrides.debounceSec) {
    rows.push(Text({ dimColor: true, children: '受环境变量 FONS_DEBOUNCE_SEC 覆盖' }));
  }
  rows.push(toggleSetting(ui, 'toggle-stop-wait', '收尾等蓄水满', config.stopWaitDebounce,
    () => actions.updateSettings({ stopWaitDebounce: !config.stopWaitDebounce })));
  if (overrides.stopWaitDebounce) {
    rows.push(Text({ dimColor: true, children: '受环境变量 FONS_STOP_WAIT_DEBOUNCE 覆盖' }));
  }
  rows.push(toggleSetting(ui, 'toggle-auto-attach', '所有工作区默认自动启用', config.autoAttachWorkspaces,
    () => actions.updateSettings({ autoAttachWorkspaces: !config.autoAttachWorkspaces })));
  if (workspace?.path) rows.push(renderWorkspaceSetting(ctx, workspace));
  return rows;
}

function renderWorkspaceSetting(ctx, workspace) {
  const { ui, actions } = ctx;
  const { Box, Text, Button } = ui;
  const children = [
    Text({ dimColor: true, children: '工作区 ' + workspace.name }),
    Button({
      key: 'toggle-ws',
      label: workspace.enabled ? '已启用 ●' : '已停用 ○',
      plain: true,
      dimColor: !workspace.enabled,
      onPress: () => actions.updateSettings({
        workspaceAction: { path: workspace.path, mode: workspace.enabled ? 'disable' : 'enable' },
      }),
    }),
  ];
  if (workspace.explicitState !== 'default') {
    children.push(Button({
      key: 'reset-ws',
      label: '恢复默认',
      plain: true,
      onPress: () => actions.updateSettings({ workspaceAction: { path: workspace.path, mode: 'reset' } }),
    }));
  }
  return Box({ flexDirection: 'row', flexWrap: 'wrap', gap: 1, children });
}

function renderComposerOrNotice(ctx) {
  const { state, ui, snapshot, actions } = ctx;
  const { Box, Text, Button, Input } = ui;
  if (!snapshot) return null;
  const workspace = snapshot.settings?.currentWorkspace;
  if (snapshot.workspaceDisabled && workspace?.path) {
    return Box({
      key: 'ws-disabled',
      flexDirection: 'column',
      marginBottom: 1,
      children: [
        Text({ color: 'yellow', children: '当前工作区已停用 Fons：' + workspace.name }),
        state.pendingOps.has('settings')
          ? Text({ dimColor: true, children: '处理中…' })
          : Button({
            key: 'enable-ws',
            label: '启用当前工作区',
            variant: 'primary',
            onPress: () => actions.updateSettings({ workspaceAction: { path: workspace.path, mode: 'enable' } }),
          }),
      ],
    });
  }
  if (!snapshot.registered) {
    const children = [Text({ dimColor: true, wrap: 'wrap', children: '当前会话尚未登记到 Fons' })];
    if (state.pendingOps.has('register')) {
      children.push(Text({ dimColor: true, children: '处理中…' }));
    } else if (snapshot.settings?.canRegisterSession) {
      children.push(Button({
        key: 'register-session',
        label: '立即启用当前会话',
        variant: 'primary',
        onPress: () => actions.runPoolOp({ op: 'register', data: {}, pendingKey: 'register' }),
      }));
    }
    children.push(Button({ key: 'refresh-unreg', label: '刷新状态', plain: true, onPress: actions.refreshSnapshot }));
    return Box({ key: 'unregistered', flexDirection: 'column', marginBottom: 1, children });
  }
  if (!('Input' in ui)) return null;
  return Box({
    key: 'draft-box',
    marginBottom: 1,
    children: [Input({
      key: 'draft-' + state.draftSeq,
      label: '+ ',
      placeholder: '记下补充灵感，Enter 入池…',
      submitLabel: state.pendingOps.has('draft') ? '入池中…' : '入池',
      value: state.draftText,
      onInput: (value) => { state.draftText = value; },
      onSubmit: actions.submitDraft,
    })],
  });
}

function renderEditRow(ctx, item) {
  const { state, ui, actions, surface } = ctx;
  const { Box, Text, Button, Input } = ui;
  const pendingKey = 'item-' + item.rowIndex + '-' + item.id;
  const children = [];
  if (state.pendingOps.has(pendingKey)) {
    children.push(Text({ dimColor: true, children: '处理中…' }));
  } else {
    children.push(Box({
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'space-between',
      children: [
        Text({ color: 'cyan', children: '⏸ 编辑中（已暂缓计时）' }),
        Button({ key: 'cancel-edit', label: '取消', plain: true, onPress: actions.cancelEdit }),
      ],
    }));
    if ('Input' in ui) children.push(Input({
      key: 'edit-input-' + item.id,
      label: '✎ ',
      placeholder: '修改灵感内容，Enter 保存…',
      submitLabel: '保存',
      autoFocus: true,
      value: state.editing.initialText,
      onSubmit: actions.saveEdit,
    }));
    for (const att of item.attachments.filter((entry) => state.editing.keepAttachments.includes(entry.storedName))) {
      children.push(Box({
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 1,
        children: [
          Text({ children: '📎 ' + att.name }),
          Button({
            key: 'remove-attachment-' + att.storedName,
            label: '×',
            plain: true,
            onPress: () => {
              state.editing.keepAttachments = state.editing.keepAttachments.filter((name) => name !== att.storedName);
              actions.redraw();
            },
          }),
        ],
      }));
    }
  }
  return Box({
    key: 'edit-box',
    flexDirection: 'column',
    borderStyle: 'round',
    borderColor: 'cyan',
    paddingX: 1,
    marginBottom: surface === 'terminal' ? 0 : 1,
    children,
  });
}

function renderStatus(ctx, item) {
  const { ui, state, snapshot, now, surface } = ctx;
  const { Box, Text } = ui;
  if (item.status === 'done') return Text({ dimColor: true, children: '已完成' });
  if (item.status === 'delivered') return Text({ color: 'yellow', children: '◉ 已投递 · 等待回执' });
  if (item.editingHold || state.editing?.id === item.id) return Text({ color: 'cyan', children: '⏸ 编辑暂缓' });
  const remaining = liveRemainingMs(state, item, now);
  if (remaining <= 0 || !snapshot.debounceMs) {
    return Text({ color: 'green', bold: true, children: '● 就绪 · 待下一时机注入' });
  }
  const width = surface === 'terminal' ? 6 : 8;
  const filled = Math.round(Math.max(0, Math.min(1, 1 - remaining / snapshot.debounceMs)) * width);
  return Box({
    flexDirection: 'row',
    children: [
      Text({ color: 'cyan', children: '▓'.repeat(filled) }),
      Text({ dimColor: true, children: '░'.repeat(width - filled) + ' ' + Math.ceil(remaining / 1000) + 's' }),
    ],
  });
}

function renderItemActions(ctx, item) {
  const { ui, state, actions } = ctx;
  const { Text, Button } = ui;
  const pendingKey = 'item-' + item.rowIndex + '-' + item.id;
  if (state.pendingOps.has(pendingKey)) return [Text({ dimColor: true, children: '处理中…' })];
  const result = [];
  if (item.status === 'buffering' && 'Input' in ui) {
    result.push(Button({
      key: 'edit-' + item.rowIndex,
      label: '编辑',
      plain: true,
      onPress: () => actions.startEdit(item),
    }));
  }
  if (item.status !== 'done') {
    result.push(Button({
      key: 'done-' + item.rowIndex,
      label: '完成',
      plain: true,
      onPress: () => actions.runPoolOp({ op: 'complete', data: { token: item.token }, pendingKey }),
    }));
    result.push(Button({
      key: (item.status === 'delivered' ? 'ret-' : 'del-') + item.rowIndex,
      label: item.status === 'delivered' ? '撤回' : '删除',
      plain: true,
      dimColor: true,
      onPress: () => actions.runPoolOp({
        op: 'remove',
        data: { rowIndex: item.rowIndex, expectedRaw: item.raw },
        pendingKey,
      }),
    }));
  } else {
    result.push(Button({
      key: 'reopen-' + item.rowIndex,
      label: '重开',
      plain: true,
      dimColor: true,
      onPress: () => actions.runPoolOp({
        op: 'reopen',
        data: { rowIndex: item.rowIndex, expectedRaw: item.raw },
        pendingKey,
      }),
    }));
  }
  return result;
}

function renderItemRow(ctx, item) {
  const { state, ui, surface } = ctx;
  const { Box, Text } = ui;
  const isEditing = state.editing?.id === item.id && state.editing.rowIndex === item.rowIndex;
  if (isEditing && item.status === 'buffering') return renderEditRow(ctx, item);

  const attachments = item.attachments;
  const glyph = item.status === 'done' ? '✓' : item.status === 'delivered' ? '◉' : '○';
  const color = item.status === 'done' ? 'green' : item.status === 'delivered' ? 'yellow' : 'cyan';
  const children = [Box({
    flexDirection: 'row',
    children: [
      Text({ color, bold: item.status !== 'done', children: glyph + ' ' }),
      Text({
        dimColor: item.status === 'done',
        wrap: 'wrap',
        children: item.note || (attachments.length ? '（仅附件）' : item.text),
      }),
    ],
  })];
  if (attachments.length) {
    const names = attachments.slice(0, 2).map((att) => att.name).join(' · ');
    const remainder = attachments.length > 2 ? ' +' + (attachments.length - 2) : '';
    children.push(Text({ dimColor: true, wrap: 'wrap', children: '  📎 ' + names + remainder }));
  }
  children.push(Box({
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: 1,
    children: [
      renderStatus(ctx, item),
      Box({ flexDirection: 'row', flexWrap: 'wrap', gap: 1, children: renderItemActions(ctx, item) }),
    ],
  }));
  return Box({
    key: 'item-' + item.rowIndex + '-' + item.id,
    flexDirection: 'column',
    marginBottom: surface === 'terminal' ? 0 : 1,
    children,
  });
}

function renderDoneGroup(ctx, done, activeCount) {
  const { state, ui, actions } = ctx;
  const { Box, Text, Button } = ui;
  const collapsed = state.doneCollapsed ?? (activeCount > 0 && done.length >= 3);
  const children = [Box({
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    children: [
      Button({
        key: 'toggle-done',
        label: (collapsed ? '▸' : '▾') + ' 已完成 (' + done.length + ')',
        plain: true,
        onPress: () => {
          state.doneCollapsed = !collapsed;
          actions.redraw();
        },
      }),
      state.pendingOps.has('archive')
        ? Text({ dimColor: true, children: '处理中…' })
        : Button({
          key: 'archive',
          label: '归档',
          plain: true,
          onPress: () => actions.runPoolOp({ op: 'archive', data: {}, pendingKey: 'archive' }),
        }),
    ],
  })];
  if (!collapsed) children.push(...done.map((item) => renderItemRow(ctx, item)));
  return Box({ key: 'done-group', flexDirection: 'column', children });
}

export function renderPaneBody(state, ui, now, surface, actions) {
  const { Box, Text, Button } = ui;
  const snapshot = state.snapshot;
  const ctx = { state, ui, now, surface, actions, snapshot };
  const items = snapshot?.items || [];
  const active = items.filter((item) => item.status !== 'done');
  const done = items.filter((item) => item.status === 'done');
  const canWrite = Boolean(snapshot?.registered && !snapshot?.workspaceDisabled);
  const sections = [renderHeader(ctx, items)];
  if (state.showSettings) sections.push(renderSettingsPanel(ctx));
  if (state.error) {
    sections.push(Box({
      key: 'err',
      flexDirection: 'row',
      gap: 1,
      marginBottom: 1,
      children: [
        Text({ color: 'red', wrap: 'wrap', children: state.error }),
        Button({ key: 'retry', label: '重试', plain: true, onPress: actions.refreshSnapshot }),
      ],
    }));
  }
  const primary = renderComposerOrNotice(ctx);
  if (primary) sections.push(primary);
  if (canWrite && !items.length) {
    sections.push(Text({
      key: 'empty',
      dimColor: true,
      wrap: 'wrap',
      children: '灵感池为空。输入补充灵感后自动计时；截图和附件请使用「网页版」。',
    }));
  }
  if (active.length) {
    sections.push(Box({
      key: 'items',
      flexDirection: 'column',
      children: active.map((item) => renderItemRow(ctx, item)),
    }));
  }
  if (done.length) sections.push(renderDoneGroup(ctx, done, active.length));
  return Box({ flexDirection: 'column', paddingX: 1, children: sections });
}
