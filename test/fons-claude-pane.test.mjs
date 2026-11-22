import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { evaluateClaudeHook } from '../adapters/claude.mjs';
import { prepareClaudePlugin } from '../claude/init.mjs';
import { register } from '../claude/pane.mjs';
import { runBridgeAction } from '../claude/pane-bridge.mjs';
import { addIdeas } from '../scripts/fons-store.mjs';

function setupEnv(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fons-claude-pane-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const home = path.join(root, 'home');
  const claudeHome = path.join(home, '.claude');
  const project = path.join(home, 'workspace');
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  const sessionId = '55555555-5555-4555-8555-555555555505';
  const transcriptPath = path.join(claudeHome, 'projects', 'ws', sessionId + '.jsonl');
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.writeFileSync(transcriptPath, '');
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: claudeHome,
    HOME: home,
    USERPROFILE: home,
    FONS_ROOT: undefined,
    FONS_APP_DATA: undefined,
    FONS_DEBOUNCE_SEC: undefined,
    FONS_STOP_WAIT_DEBOUNCE: undefined,
    CLAUDE_PROJECT_DIR: project,
  };
  return { root, home, claudeHome, project, sessionId, transcriptPath, env };
}

function registerSession(ctx, sessionId = ctx.sessionId) {
  const transcriptPath = path.join(ctx.claudeHome, 'projects', 'ws', sessionId + '.jsonl');
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  if (!fs.existsSync(transcriptPath)) fs.writeFileSync(transcriptPath, '');
  const prev = {};
  const envKeys = [
    'CLAUDE_CONFIG_DIR', 'CLAUDE_PROJECT_DIR', 'FONS_ROOT', 'FONS_APP_DATA',
    'FONS_DEBOUNCE_SEC', 'FONS_STOP_WAIT_DEBOUNCE',
  ];
  for (const key of envKeys) {
    prev[key] = process.env[key];
    if (ctx.env[key] === undefined) delete process.env[key];
    else process.env[key] = ctx.env[key];
  }
  try {
    evaluateClaudeHook({
      hook_event_name: 'SessionStart',
      session_id: sessionId,
      cwd: ctx.project,
      transcript_path: transcriptPath,
      source: 'startup',
    }, 'all');
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function collectNodes(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  out.push(node);
  const children = node.props?.children;
  if (Array.isArray(children)) {
    for (const child of children) collectNodes(child, out);
  } else if (children && typeof children === 'object') {
    collectNodes(children, out);
  }
  return out;
}

function renderText(node) {
  return collectNodes(node)
    .filter((n) => n.type === 'Text')
    .map((n) => String(n.props.children || ''))
    .join('\n');
}

function createFakeHost({ env, sessionId, cwd, surfaces = ['desktop'] }) {
  const handlers = [];
  const commands = new Map();
  const openPanes = new Map();
  const toasts = [];
  const timers = [];
  const waiters = [];
  let currentSessionId = sessionId;
  let nowMs = 1_700_000_000_000;
  let invalidations = 0;

  const notifyWaiters = () => {
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].predicate()) {
        const [{ resolve }] = waiters.splice(i, 1);
        resolve();
      }
    }
  };

  const uiFactory = (type) => (props = {}) => ({ type, props });
  const uiTable = {
    Box: uiFactory('Box'),
    Text: uiFactory('Text'),
    Button: uiFactory('Button'),
    Input: uiFactory('Input'),
  };

  const $ = {
    env: { get: async (name) => env[name] },
    fs: {
      exists: async (target) => fs.existsSync(target),
      read: async (target) => fs.readFileSync(target, 'utf8'),
    },
    process: {
      run: async (argv, init = {}) => {
        const proc = spawnSync(argv[0], argv.slice(1), {
          cwd: init.cwd || cwd,
          encoding: 'utf8',
          env: { ...env, ...(init.env || {}) },
          timeout: init.timeoutMs || 8000,
        });
        const result = { exitCode: proc.status ?? 1, stdout: proc.stdout || '', stderr: proc.stderr || '' };
        notifyWaiters();
        return result;
      },
    },
    session: {
      id: async () => currentSessionId,
      cwd: async () => cwd,
      surfaces: async () => surfaces,
    },
    command: {
      register: async (spec) => { commands.set(spec.name, spec); },
    },
    ui: {
      open: async (spec) => {
        if (spec.closeOnEscape !== undefined && spec.closeOnEscape !== true) {
          throw new Error('ui.open: closeOnEscape is true or left out (host check)');
        }
        if (spec.focus !== undefined && spec.focus !== true) {
          throw new Error('ui.open: focus is true or left out (host check)');
        }
        openPanes.set(spec.id, spec);
        notifyWaiters();
        return { isPlaced: true };
      },
      close: async ({ id }) => {
        openPanes.delete(id);
        notifyWaiters();
      },
      panes: async () => [...openPanes.values()],
      invalidate: () => {
        invalidations += 1;
        notifyWaiters();
      },
      toast: (message) => { toasts.push(message); },
      log: () => {},
      resolve: () => uiTable,
    },
    clock: {
      now: async () => nowMs,
      every: (ms, fn) => {
        const entry = { ms, fn, cancelled: false, cancel() { this.cancelled = true; } };
        timers.push(entry);
        return entry;
      },
      after: (ms, fn) => {
        const entry = { ms, fn, once: true, cancelled: false, cancel() { this.cancelled = true; } };
        timers.push(entry);
        return entry;
      },
    },
  };

  const on = (event, filterOrFn, maybeFn) => {
    const filter = typeof filterOrFn === 'function' ? null : filterOrFn;
    const fn = typeof filterOrFn === 'function' ? filterOrFn : maybeFn;
    handlers.push({ event, filter, fn });
  };

  const matches = (filter, payload) => {
    if (!filter) return true;
    return Object.entries(filter).every(([k, v]) => payload?.[k] === v);
  };

  const dispatch = async (event, payload = {}, fallback = () => ({})) => {
    const matching = handlers.filter((h) => h.event === event && matches(h.filter, payload));
    let idx = 0;
    const next = async (e) => {
      if (idx >= matching.length) return fallback(e);
      const handler = matching[idx++];
      return handler.fn($, e, next);
    };
    return next(payload);
  };

  const waitUntil = (predicate, timeoutMs = 4000) => {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const entry = {
        predicate,
        resolve: () => { clearTimeout(timer); resolve(); },
      };
      const timer = setTimeout(() => {
        const idx = waiters.indexOf(entry);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(new Error('waitUntil timed out'));
      }, timeoutMs);
      waiters.push(entry);
    });
  };

  return {
    $, on, dispatch, commands, openPanes, toasts, timers, waitUntil,
    setSessionId(nextId) { currentSessionId = nextId; },
    advanceTime(ms) { nowMs += ms; },
    get invalidations() { return invalidations; },
  };
}

test('pane-bridge handles unregistered snapshot, env isolation, validation, full pool lifecycle, and web panel reuse', async (t) => {
  const ctx = setupEnv(t);

  // Explicit env overrides process.env inside readSnapshot.
  const withEnvDebounce = await runBridgeAction({
    action: 'snapshot',
    payload: { sessionId: ctx.sessionId },
    env: { ...ctx.env, FONS_DEBOUNCE_SEC: '12', FONS_STOP_WAIT_DEBOUNCE: '1' },
    cwd: ctx.project,
  });
  assert.equal(withEnvDebounce.ok, true);
  assert.equal(withEnvDebounce.registered, false);
  assert.equal(withEnvDebounce.debounceMs, 12_000);
  assert.equal(withEnvDebounce.settings.envOverrides.debounceSec, true);
  assert.equal(withEnvDebounce.settings.envOverrides.stopWaitDebounce, true);

  // Malformed workspaceAction fails cleanly even when session is unregistered.
  const badWorkspaceAction = await runBridgeAction({
    action: 'pool',
    payload: {
      sessionId: ctx.sessionId,
      op: 'settings',
      data: { update: { workspaceAction: 'bad' } },
    },
    env: ctx.env,
    cwd: ctx.project,
  });
  assert.equal(badWorkspaceAction.ok, false);

  // Disable and re-enable workspace before session registration.
  const disableRes = await runBridgeAction({
    action: 'pool',
    payload: {
      sessionId: ctx.sessionId,
      op: 'settings',
      data: { update: { workspaceAction: { path: ctx.project, mode: 'disable' } } },
    },
    env: ctx.env,
    cwd: ctx.project,
  });
  assert.equal(disableRes.ok, true);
  assert.equal(disableRes.snapshot.workspaceDisabled, true);

  const enableRes = await runBridgeAction({
    action: 'pool',
    payload: {
      sessionId: ctx.sessionId,
      op: 'settings',
      data: { update: { workspaceAction: { path: ctx.project, mode: 'enable' }, debounceSec: 30 } },
    },
    env: ctx.env,
    cwd: ctx.project,
  });
  assert.equal(enableRes.ok, true);
  assert.equal(enableRes.snapshot.workspaceEnabled, true);
  assert.equal(enableRes.snapshot.debounceMs, 30_000);

  // Register session and run full CRUD via bridge.
  registerSession(ctx);
  addIdeas({
    rootDir: ctx.project,
    sessionId: ctx.sessionId,
    texts: ['带附件的想法'],
    attachments: [{ name: 'spec.txt', buffer: Buffer.from('hello fons') }],
  });

  const added = await runBridgeAction({
    action: 'pool',
    payload: { sessionId: ctx.sessionId, op: 'add', data: { texts: ['补权限单测'] } },
    env: ctx.env,
    cwd: ctx.project,
  });
  assert.equal(added.ok, true);
  assert.equal(added.snapshot.registered, true);
  assert.equal(added.snapshot.items.length, 2);

  // Editing preserves stored attachments when keepAttachments is supplied.
  const attItem = added.snapshot.items[0];
  assert.equal(attItem.attachments.length, 1);
  const held = await runBridgeAction({
    action: 'pool',
    payload: { sessionId: ctx.sessionId, op: 'hold', data: { id: attItem.id } },
    env: ctx.env,
    cwd: ctx.project,
  });
  assert.equal(held.ok, true);
  assert.equal(held.snapshot.items[0].editingHold, true);

  const updated = await runBridgeAction({
    action: 'pool',
    payload: {
      sessionId: ctx.sessionId,
      op: 'update',
      data: {
        rowIndex: attItem.rowIndex,
        expectedRaw: attItem.raw,
        newText: '改写后的想法',
        keepAttachments: [attItem.attachments[0].storedName],
      },
    },
    env: ctx.env,
    cwd: ctx.project,
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.snapshot.items[0].note, '改写后的想法');
  assert.equal(updated.snapshot.items[0].attachments.length, 1);

  // Complete, reopen, complete again, and archive.
  const second = updated.snapshot.items[1];
  const completed = await runBridgeAction({
    action: 'pool',
    payload: { sessionId: ctx.sessionId, op: 'complete', data: { token: second.token } },
    env: ctx.env,
    cwd: ctx.project,
  });
  assert.equal(completed.ok, true);
  assert.equal(completed.snapshot.canArchive, true);

  const doneItem = completed.snapshot.items.find((item) => item.status === 'done');
  const reopened = await runBridgeAction({
    action: 'pool',
    payload: { sessionId: ctx.sessionId, op: 'reopen', data: { rowIndex: doneItem.rowIndex, expectedRaw: doneItem.raw } },
    env: ctx.env,
    cwd: ctx.project,
  });
  assert.equal(reopened.ok, true);
  assert.equal(reopened.snapshot.canArchive, false);

  const completeAgain = await runBridgeAction({
    action: 'pool',
    payload: { sessionId: ctx.sessionId, op: 'complete', data: { token: reopened.snapshot.items[1].token } },
    env: ctx.env,
    cwd: ctx.project,
  });
  assert.equal(completeAgain.ok, true);

  const archived = await runBridgeAction({
    action: 'pool',
    payload: { sessionId: ctx.sessionId, op: 'archive', data: {} },
    env: ctx.env,
    cwd: ctx.project,
  });
  assert.equal(archived.ok, true);
  assert.equal(archived.result.count, 1);
  assert.equal(archived.snapshot.items.length, 1);

  // open-web spawns detached server, opens URL via callback, reuses live server via token probe,
  // and respawns cleanly after the detached server exits.
  const openedUrls = [];
  const launchedPids = [];
  const killAndWait = async (pid) => {
    try { process.kill(pid, 'SIGTERM'); } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
      return;
    }
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error?.code === 'ESRCH') return;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  try {
    const firstOpen = await runBridgeAction({
      action: 'open-web',
      payload: { sessionId: ctx.sessionId },
      env: ctx.env,
      cwd: ctx.project,
      openBrowser: (url) => openedUrls.push(url),
    });
    assert.equal(firstOpen.ok, true);
    assert.equal(firstOpen.reused, false);
    assert.match(firstOpen.url, /^http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]{64}$/);
    assert.equal(openedUrls.length, 1);
    launchedPids.push(firstOpen.pid);

    const reusedOpen = await runBridgeAction({
      action: 'open-web',
      payload: { sessionId: ctx.sessionId, existingPid: firstOpen.pid, existingUrl: firstOpen.url },
      env: ctx.env,
      cwd: ctx.project,
      openBrowser: (url) => openedUrls.push(url),
    });
    assert.equal(reusedOpen.ok, true);
    assert.equal(reusedOpen.reused, true);
    assert.equal(reusedOpen.url, firstOpen.url);
    assert.equal(openedUrls.length, 2);

    // Kill server and verify open-web detects dead server via HTTP probe instead of trusting stale URL.
    await killAndWait(firstOpen.pid);
    const afterExit = await runBridgeAction({
      action: 'open-web',
      payload: { sessionId: ctx.sessionId, existingPid: firstOpen.pid, existingUrl: firstOpen.url },
      env: ctx.env,
      cwd: ctx.project,
      openBrowser: (url) => openedUrls.push(url),
    });
    assert.equal(afterExit.ok, true);
    assert.equal(afterExit.reused, false);
    assert.notEqual(afterExit.url, firstOpen.url);
    launchedPids.push(afterExit.pid);
  } finally {
    for (const pid of launchedPids) await killAndWait(pid);
  }

  const badOp = await runBridgeAction({
    action: 'pool',
    payload: { sessionId: ctx.sessionId, op: 'unknown-op', data: {} },
    env: ctx.env,
    cwd: ctx.project,
  });
  assert.equal(badOp.ok, false);
});

test('Claude Mod pane handles desktop auto-open, quick-add, edit/cancel/empty guard, final countdown tick, AbovePrompt, and session switch', async (t) => {
  const ctx = setupEnv(t);
  prepareClaudePlugin({ env: ctx.env, cwd: ctx.project });
  registerSession(ctx);

  const host = createFakeHost({
    env: { ...ctx.env, FONS_DEBOUNCE_SEC: '2' },
    sessionId: ctx.sessionId,
    cwd: ctx.project,
    surfaces: ['desktop'],
  });
  register(host.on, { openAtStart: 'on' });

  await host.dispatch('session.start', { surface: 'desktop' });
  const startupTimer = host.timers.find((entry) => entry.once && entry.ms === 0);
  assert.ok(startupTimer);
  startupTimer.fn();
  await host.waitUntil(() => host.openPanes.has('fons-pool'));

  assert.equal(host.commands.get('fons')?.immediate, true);
  assert.equal(host.openPanes.get('fons-pool').focus, undefined);

  // Quick-add via /fons <text> works immediately.
  const quickRes = await host.dispatch('command.run', { command: 'fons', args: '导出接口补 created_at' });
  assert.match(quickRes.text, /已加入 Fons 灵感池/);

  const tree = await host.dispatch('ui.render', { component: 'Pane', requestId: 'fons-pool', surface: 'desktop', props: {} });
  const nodes = collectNodes(tree);
  const allText = renderText(tree);
  assert.match(allText, /导出接口补 created_at/);
  assert.match(allText, /蓄水 1/);
  assert.match(allText, /2s/);

  // Countdown ticker invalidates as remaining time reaches 0 (1s -> 就绪 final tick).
  const tickEntry = host.timers.find((entry) => entry.ms === 1000 && !entry.once);
  assert.ok(tickEntry);
  const invBeforeZero = host.invalidations;
  host.advanceTime(2500);
  tickEntry.fn();
  await host.waitUntil(() => host.invalidations > invBeforeZero);
  const readyTree = await host.dispatch('ui.render', { component: 'Pane', requestId: 'fons-pool', surface: 'desktop', props: {} });
  assert.match(renderText(readyTree), /就绪/);

  // Inline Edit: empty submit rejected, cancel releases hold, valid edit updates text.
  const editBtn = collectNodes(readyTree).find((n) => n.type === 'Button' && n.props.label === '编辑');
  assert.ok(editBtn);
  await editBtn.props.onPress();

  const editTree = await host.dispatch('ui.render', { component: 'Pane', requestId: 'fons-pool', surface: 'desktop', props: {} });
  const editNodes = collectNodes(editTree);
  const editInput = editNodes.find((n) => n.type === 'Input' && String(n.props.key).startsWith('edit-input-'));
  assert.ok(editInput);
  await editInput.props.onSubmit('   ');
  assert.ok(host.toasts.some((msg) => msg.includes('不能为空')));

  const cancelBtn = editNodes.find((n) => n.type === 'Button' && n.props.key === 'cancel-edit');
  assert.ok(cancelBtn);
  await cancelBtn.props.onPress();
  const afterCancelTree = await host.dispatch('ui.render', { component: 'Pane', requestId: 'fons-pool', surface: 'desktop', props: {} });
  assert.equal(collectNodes(afterCancelTree).some((n) => n.type === 'Input' && String(n.props.key).startsWith('edit-input-')), false);
  assert.doesNotMatch(renderText(afterCancelTree), /编辑暂缓/);

  // Re-enter edit and submit updated text.
  const editBtn2 = collectNodes(afterCancelTree).find((n) => n.type === 'Button' && n.props.label === '编辑');
  await editBtn2.props.onPress();
  const editTree2 = await host.dispatch('ui.render', { component: 'Pane', requestId: 'fons-pool', surface: 'desktop', props: {} });
  const editInput2 = collectNodes(editTree2).find((n) => n.type === 'Input' && String(n.props.key).startsWith('edit-input-'));
  await editInput2.props.onSubmit('导出接口补 created_at 与 updated_at');

  const afterEditTree = await host.dispatch('ui.render', { component: 'Pane', requestId: 'fons-pool', surface: 'desktop', props: {} });
  assert.match(renderText(afterEditTree), /updated_at/);

  // AbovePrompt stays silent while pane is open, and renders safely without nesting { type: 'engine' } when closed.
  const openBand = await host.dispatch('ui.render', { component: 'AbovePrompt', surface: 'desktop', props: {} }, () => ({ type: 'engine' }));
  assert.equal(openBand.type, 'engine');

  const closeRes = await host.dispatch('command.run', { command: 'fons', args: '' });
  assert.match(closeRes.text, /已关闭/);
  assert.equal(host.openPanes.has('fons-pool'), false);

  const closedBand = await host.dispatch('ui.render', { component: 'AbovePrompt', surface: 'desktop', props: {} }, () => ({ type: 'engine' }));
  const bandNodes = collectNodes(closedBand);
  assert.equal(bandNodes.some((n) => n.type === 'engine'), false);
  const reopenBtn = bandNodes.find((n) => n.type === 'Button' && n.props.key === 'open-fons-pane');
  assert.ok(reopenBtn);
  await reopenBtn.props.onPress();
  assert.equal(host.openPanes.has('fons-pool'), true);
  assert.equal(host.openPanes.get('fons-pool').focus, true);

  // Switching to a new session (/clear) clears stale items on poll refresh and loads the new session.
  const nextSessionId = '66666666-6666-4666-8666-666666666606';
  registerSession(ctx, nextSessionId);
  host.setSessionId(nextSessionId);
  const pollEntry = host.timers.find((entry) => entry.ms === 2500 && !entry.once);
  assert.ok(pollEntry);
  const invBeforeSwitch = host.invalidations;
  pollEntry.fn();
  await host.waitUntil(() => host.invalidations > invBeforeSwitch + 1);
  const switchedTree = await host.dispatch('ui.render', { component: 'Pane', requestId: 'fons-pool', surface: 'desktop', props: {} });
  const switchedText = renderText(switchedTree);
  assert.doesNotMatch(switchedText, /updated_at/);
  assert.match(switchedText, /灵感池为空/);

  // Session switch first observed inside /fons <text> (without prior session.append) keeps the new snapshot.
  const thirdSessionId = '77777777-7777-4777-8777-777777777707';
  registerSession(ctx, thirdSessionId);
  host.setSessionId(thirdSessionId);
  const directAdd = await host.dispatch('command.run', { command: 'fons', args: '第三会话直接速记' });
  assert.match(directAdd.text, /已加入 Fons 灵感池/);
  const thirdTree = await host.dispatch('ui.render', { component: 'Pane', requestId: 'fons-pool', surface: 'desktop', props: {} });
  assert.match(renderText(thirdTree), /第三会话直接速记/);

  // Session switch first observed inside refreshSnapshot (↻ button, without prior session.append) keeps the new snapshot.
  const fourthSessionId = '88888888-8888-4888-8888-888888888808';
  registerSession(ctx, fourthSessionId);
  host.setSessionId(fourthSessionId);
  const refreshBtn = collectNodes(thirdTree).find((n) => n.type === 'Button' && n.props.key === 'refresh');
  assert.ok(refreshBtn);
  await refreshBtn.props.onPress();
  const fourthTree = await host.dispatch('ui.render', { component: 'Pane', requestId: 'fons-pool', surface: 'desktop', props: {} });
  const fourthText = renderText(fourthTree);
  assert.match(fourthText, /灵感池为空/);
  assert.doesNotMatch(fourthText, /第三会话直接速记/);

  for (const timer of host.timers) timer.cancel();
});

test('Claude Mod pane respects openAtStart off, non-desktop surfaces, and inline placement auto-close', async (t) => {
  const ctx = setupEnv(t);
  prepareClaudePlugin({ env: ctx.env, cwd: ctx.project });
  registerSession(ctx);
  const flushAsync = () => new Promise((resolve) => setImmediate(resolve));

  // Desktop with openAtStart: 'off' stays closed after startup completes.
  const desktopOff = createFakeHost({ env: ctx.env, sessionId: ctx.sessionId, cwd: ctx.project, surfaces: ['desktop'] });
  register(desktopOff.on, { openAtStart: 'off' });
  await desktopOff.dispatch('session.start', { surface: 'desktop' });
  desktopOff.timers.find((entry) => entry.once && entry.ms === 0)?.fn();
  await desktopOff.waitUntil(() => desktopOff.invalidations >= 1);
  await flushAsync();
  assert.equal(desktopOff.openPanes.has('fons-pool'), false);
  for (const timer of desktopOff.timers) timer.cancel();

  // Desktop early startup where surfaces() has not attached yet ([]) still auto-opens without passing focus: false.
  const earlyDesktop = createFakeHost({ env: ctx.env, sessionId: ctx.sessionId, cwd: ctx.project, surfaces: [] });
  register(earlyDesktop.on, { openAtStart: 'on' });
  await earlyDesktop.dispatch('session.start', { surface: 'desktop' });
  earlyDesktop.timers.find((entry) => entry.once && entry.ms === 0)?.fn();
  await earlyDesktop.waitUntil(() => earlyDesktop.openPanes.has('fons-pool'));
  assert.equal(earlyDesktop.openPanes.get('fons-pool').focus, undefined);
  for (const timer of earlyDesktop.timers) timer.cancel();

  // Terminal surface does not auto-open on start, and non-manual inline render closes an open pane cleanly.
  const terminalHost = createFakeHost({ env: ctx.env, sessionId: ctx.sessionId, cwd: ctx.project, surfaces: ['terminal'] });
  register(terminalHost.on, { openAtStart: 'on' });
  await terminalHost.dispatch('session.start', { surface: 'terminal' });
  terminalHost.timers.find((entry) => entry.once && entry.ms === 0)?.fn();
  await terminalHost.waitUntil(() => terminalHost.invalidations >= 1);
  await flushAsync();
  assert.equal(terminalHost.openPanes.has('fons-pool'), false);

  terminalHost.openPanes.set('fons-pool', { id: 'fons-pool' });
  const inlineTree = await terminalHost.dispatch('ui.render', {
    component: 'Pane', requestId: 'fons-pool', surface: 'terminal', props: { placement: 'inline' },
  });
  await terminalHost.waitUntil(() => !terminalHost.openPanes.has('fons-pool'));
  assert.equal(terminalHost.openPanes.has('fons-pool'), false);
  assert.equal(renderText(inlineTree), '');
  for (const timer of terminalHost.timers) timer.cancel();
});
