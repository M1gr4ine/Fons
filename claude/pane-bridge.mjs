import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeAppData, findClaudeWorkspace } from '../adapters/claude.mjs';
import { effectiveHome } from '../adapters/shared.mjs';
import { isWorkspaceEnabled, readFonsConfig, resolveConfiguredDebounceMs } from '../scripts/fons-config.mjs';
import { isValidPanelUrl, openPanelUrl, startPanelServer } from '../scripts/fons-panel.mjs';
import { isValidSessionId, lookupConversation } from '../scripts/fons-store.mjs';
import {
  applySettingsPatch, buildCurrentWorkspaceInfo, createBoundPoolRoutes, formatSettingsPayload,
  isPlainObject,
} from '../sidecars/fons-pool/main.mjs';

const SELF_PATH = fileURLToPath(import.meta.url);
const ALLOWED_POOL_OPS = new Set([
  'add', 'complete', 'update', 'remove', 'reopen', 'archive', 'hold', 'release', 'settings',
]);
const WEB_PANEL_READY_TIMEOUT_MS = 4000;
const WEB_PANEL_POLL_MS = 40;
const WEB_PANEL_PROBE_TIMEOUT_MS = 600;
const WEB_PANEL_IDLE_MS = 15 * 60 * 1000;

function unwrapRouteResult(result) {
  if (Number.isInteger(result?.status) && typeof result.body === 'string') {
    let parsed = {};
    try {
      parsed = JSON.parse(result.body);
    } catch {
      parsed = {};
    }
    if (result.status >= 400) return { error: parsed.error || 'Fons 操作失败。' };
    return { data: parsed };
  }
  return { data: result ?? {} };
}

function resolveSessionContext({ sessionId, env, cwd }) {
  const homeDir = effectiveHome(env);
  const appData = claudeAppData(env, homeDir, cwd);
  const validId = isValidSessionId(sessionId) ? sessionId : null;
  const entry = validId ? lookupConversation({ appData, sessionId: validId }) : null;
  const matched = entry?.host === 'claude' ? { ...entry, sessionId: validId, appData } : null;
  return { appData, homeDir, entry: matched };
}

function readUnregisteredSnapshot({ appData, homeDir, env, cwd }) {
  const startDir = env.CLAUDE_PROJECT_DIR?.trim() || cwd;
  const rootDir = findClaudeWorkspace(startDir, homeDir);
  const config = readFonsConfig(appData);
  const workspaceEnabled = rootDir ? isWorkspaceEnabled({ appData, rootDir, config }) : true;
  const currentWorkspace = buildCurrentWorkspaceInfo({ appData, config, rootDir, detectLocalPlugin: false });
  const settings = formatSettingsPayload({
    config, currentWorkspace, sessionRegistered: false, canRegisterSession: false, env,
  });
  return {
    ok: true,
    registered: false,
    scope: rootDir ? 'workspace' : 'no-workspace',
    rootDir,
    title: '',
    workspaceEnabled,
    workspaceDisabled: !workspaceEnabled,
    items: [],
    debounceMs: resolveConfiguredDebounceMs({ appData, env }),
    canArchive: false,
    etag: '',
    settings,
  };
}

function readBoundSnapshot(entry, routes, { appData, env }) {
  const poolOutcome = unwrapRouteResult(routes.get('/api/pool')({}));
  if (poolOutcome.error) return { ok: false, error: poolOutcome.error };
  const settingsOutcome = unwrapRouteResult(routes.get('/api/pool/settings')({}));
  const pool = poolOutcome.data;
  const settings = settingsOutcome.error ? null : settingsOutcome.data;
  const workspaceDisabled = Boolean(pool.workspaceDisabled);
  return {
    ok: true,
    registered: true,
    scope: entry.scope,
    rootDir: entry.rootDir,
    title: entry.title || '',
    workspaceEnabled: !workspaceDisabled,
    workspaceDisabled,
    items: pool.items ?? [],
    debounceMs: pool.debounceMs ?? resolveConfiguredDebounceMs({ appData, env }),
    canArchive: Boolean(pool.canArchive),
    etag: pool.etag ?? '',
    settings,
  };
}

function readSnapshot({ sessionId, env, cwd }) {
  const { appData, homeDir, entry } = resolveSessionContext({ sessionId, env, cwd });
  if (!entry) return readUnregisteredSnapshot({ appData, homeDir, env, cwd });
  return readBoundSnapshot(entry, createBoundPoolRoutes(entry, { env }), { appData, env });
}

function runPoolMutation({ sessionId, op, data, env, cwd }) {
  if (!ALLOWED_POOL_OPS.has(op)) {
    return { ok: false, error: '不支持的灵感池操作：' + String(op) };
  }
  const { appData, homeDir, entry } = resolveSessionContext({ sessionId, env, cwd });
  const body = isPlainObject(data) ? data : {};
  if (!entry) {
    if (op === 'settings' && body.update !== undefined) {
      const updated = applySettingsPatch({ appData, update: body.update, detectLocalPlugin: false });
      if (updated.error) {
        return { ok: false, error: unwrapRouteResult(updated.error).error || '无效的设置参数。' };
      }
      return {
        ok: true,
        result: { config: updated.config },
        snapshot: readUnregisteredSnapshot({ appData, homeDir, env, cwd }),
      };
    }
    return { ok: false, error: '当前会话尚未由 Fons Hook 登记，请先新开会话或稍后刷新。' };
  }
  const routes = createBoundPoolRoutes(entry, { env });
  const outcome = unwrapRouteResult(routes.get('/api/pool/' + op)(body));
  const snapshot = readBoundSnapshot(entry, routes, { appData, env });
  if (outcome.error) return { ok: false, error: outcome.error, snapshot };
  return { ok: true, result: outcome.data, snapshot };
}

function writePrivateJsonAtomic(filePath, data) {
  const temp = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.writeFileSync(temp, JSON.stringify(data) + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, filePath);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

function parseLivePanelUrl(panelUrl) {
  if (!isValidPanelUrl(panelUrl)) return null;
  const parsed = new URL(panelUrl);
  const port = parsed.port ? Number(parsed.port) : 80;
  return { parsed, port, token: parsed.hash.slice('#token='.length) };
}

function probeLivePanel(panelUrl) {
  const target = parseLivePanelUrl(panelUrl);
  if (!target) return Promise.resolve(false);
  const { parsed, port, token } = target;
  return new Promise((resolve) => {
    const req = http.request({
      hostname: parsed.hostname,
      port,
      path: '/api/panel/context',
      method: 'POST',
      timeout: WEB_PANEL_PROBE_TIMEOUT_MS,
      headers: {
        Host: parsed.host,
        Origin: parsed.origin,
        'Sec-Fetch-Site': 'same-origin',
        'Content-Type': 'application/json',
        'X-Fons-Token': token,
        'Content-Length': 2,
      },
    }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
    req.end('{}');
  });
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function readJsonReadyFile(readyFile) {
  try {
    return JSON.parse(fs.readFileSync(readyFile, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError || error?.code === 'ENOENT' || error?.code === 'EBUSY') return null;
    throw error;
  }
}

async function waitForReadyFile({ readyFile, timeoutMs, getChildFailure }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const parsed = readJsonReadyFile(readyFile);
    if (parsed !== null) return parsed;
    const failure = getChildFailure();
    if (failure) {
      // Check once more so an error payload written just before exit is never masked.
      return readJsonReadyFile(readyFile) ?? { error: failure };
    }
    await sleep(WEB_PANEL_POLL_MS);
  }
  return readJsonReadyFile(readyFile) ?? { error: '启动本地 Fons 网页版面板超时。' };
}

function terminateChild(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      process.stderr.write(String(error?.message || error) + '\n');
    }
  }
}

async function openWebPanel({ payload, env, cwd, openBrowser = openPanelUrl }) {
  const { existingPid, existingUrl, sessionId, scope } = payload;
  if (await probeLivePanel(existingUrl)) {
    openBrowser(existingUrl);
    return { ok: true, url: existingUrl, pid: existingPid ?? null, reused: true };
  }
  const readyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fons-panel-'));
  if (process.platform !== 'win32') fs.chmodSync(readyDir, 0o700);
  const readyFile = path.join(readyDir, 'ready.json');
  const childPayload = {
    sessionId: isValidSessionId(sessionId) ? sessionId : undefined,
    scope: scope === 'no-workspace' ? 'no-workspace' : undefined,
  };
  let childFailure = '';
  let child;
  try {
    child = spawn(process.execPath, [SELF_PATH, 'serve-panel'], {
      cwd,
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      env: {
        ...env,
        FONS_BRIDGE_INPUT: JSON.stringify(childPayload),
        FONS_PANEL_READY_FILE: readyFile,
      },
    });
    child.on('error', (error) => {
      childFailure ||= error?.message || '启动本地 Fons 网页版面板进程失败。';
    });
    child.on('exit', (code, signal) => {
      childFailure ||= '本地 Fons 网页版面板进程提前退出（' + (signal || ('exit ' + code)) + '）。';
    });
    child.unref();
    const ready = await waitForReadyFile({
      readyFile,
      timeoutMs: WEB_PANEL_READY_TIMEOUT_MS,
      getChildFailure: () => childFailure,
    });
    if (ready?.error || !ready?.url) {
      terminateChild(child.pid);
      return { ok: false, error: ready?.error || '无法启动本地 Fons 网页版面板。' };
    }
    openBrowser(ready.url);
    return { ok: true, url: ready.url, pid: ready.pid, reused: false };
  } finally {
    fs.rmSync(readyDir, { recursive: true, force: true });
  }
}

async function serveDetachedPanel({ payload, env, cwd }) {
  const readyFile = env.FONS_PANEL_READY_FILE?.trim();
  const selector = {
    host: 'claude',
    sessionId: isValidSessionId(payload.sessionId) ? payload.sessionId : undefined,
    scope: payload.scope === 'no-workspace' ? 'no-workspace' : undefined,
  };
  try {
    const panel = await startPanelServer({ port: 0, selector, env, cwd });
    let idleTimer = null;
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      if (idleTimer) clearTimeout(idleTimer);
      void panel.close().finally(() => process.exit(0));
    };
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(shutdown, WEB_PANEL_IDLE_MS);
      idleTimer.unref();
    };
    panel.server.on('request', resetIdle);
    resetIdle();
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    if (readyFile && fs.existsSync(path.dirname(readyFile))) {
      writePrivateJsonAtomic(readyFile, { url: panel.url, pid: process.pid });
    }
  } catch (error) {
    if (readyFile && fs.existsSync(path.dirname(readyFile))) {
      try {
        writePrivateJsonAtomic(readyFile, { error: error?.message || '启动面板失败。' });
      } catch (writeError) {
        process.stderr.write(String(writeError?.message || writeError) + '\n');
      }
    }
    process.exit(1);
  }
}

export async function runBridgeAction({
  action, payload = {}, env = process.env, cwd = process.cwd(), openBrowser = openPanelUrl,
}) {
  const input = isPlainObject(payload) ? payload : {};
  if (action === 'snapshot') return readSnapshot({ sessionId: input.sessionId, env, cwd });
  if (action === 'pool') {
    return runPoolMutation({ sessionId: input.sessionId, op: input.op, data: input.data, env, cwd });
  }
  if (action === 'open-web') return openWebPanel({ payload: input, env, cwd, openBrowser });
  return { ok: false, error: '未知的桥接动作：' + String(action) };
}

function parseEnvPayload(raw) {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isEntryPoint() {
  if (typeof import.meta.main === 'boolean') return import.meta.main;
  return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(SELF_PATH);
}

if (isEntryPoint()) {
  const action = process.argv[2] || '';
  const payload = parseEnvPayload(process.env.FONS_BRIDGE_INPUT);
  if (action === 'serve-panel') {
    await serveDetachedPanel({ payload, env: process.env, cwd: process.cwd() });
  } else {
    try {
      const output = await runBridgeAction({ action, payload, env: process.env, cwd: process.cwd() });
      process.stdout.write(JSON.stringify(output) + '\n');
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, error: error?.message || 'Fons 桥接执行失败。' }) + '\n');
      process.exitCode = 1;
    }
  }
}
