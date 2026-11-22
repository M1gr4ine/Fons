import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeAppData, findClaudeWorkspace } from '../adapters/claude.mjs';
import { codexAppData, findCodexWorkspace } from '../adapters/codex.mjs';
import { isValidSessionId, listConversations, lookupConversation } from './fons-store.mjs';

const HOST_NAMES = { antigravity: 'Antigravity', codex: 'Codex', claude: 'Claude Code' };

function selectedHost(host, env) {
  const value = host ?? env.FONS_HOST?.trim();
  if (value && !Object.hasOwn(HOST_NAMES, value)) throw new Error('宿主只能为 claude、codex 或 antigravity。');
  return value || null;
}

function findAntigravityWorkspace(startDir) {
  let dir = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(dir, '.agents')) || fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(startDir);
    dir = parent;
  }
}

function effectiveHome(env) {
  return env.USERPROFILE || env.HOME || os.homedir();
}

function workspaceRootFor(host, { env = process.env, cwd = process.cwd() } = {}) {
  const override = env.FONS_ROOT?.trim();
  if (override) return path.resolve(cwd, override);
  const homeDir = effectiveHome(env);
  if (host === 'codex') return findCodexWorkspace(cwd, homeDir);
  if (host === 'claude') return findClaudeWorkspace(env.CLAUDE_PROJECT_DIR?.trim() || cwd, homeDir);
  return findAntigravityWorkspace(cwd);
}

function appDataFor(host, { env, cwd }) {
  const override = env.FONS_APP_DATA?.trim();
  if (override) return path.resolve(cwd, override);
  const homeDir = effectiveHome(env);
  if (host === 'codex') return codexAppData(env, homeDir, cwd);
  if (host === 'claude') return claudeAppData(env, homeDir, cwd);
  return path.join(homeDir, '.gemini', 'antigravity');
}

export function sessionSelector({ sessionId, host, scope } = {}, env = process.env) {
  const defaultSessionId = scope === 'no-workspace' ? null : env.FONS_SESSION?.trim();
  const id = sessionId ?? defaultSessionId;
  if (id && !isValidSessionId(id)) throw new Error('无效的会话 ID。');
  return { sessionId: id || null, host: selectedHost(host, env), scope };
}

function sessionsForHost(host, selector, options) {
  const appData = appDataFor(host, options);
  let entries;
  if (selector.sessionId) {
    const entry = lookupConversation({ appData, sessionId: selector.sessionId });
    entries = entry ? [{ ...entry, sessionId: selector.sessionId }] : [];
  } else {
    const scope = selector.scope ?? 'workspace';
    const rootDir = scope === 'workspace' ? workspaceRootFor(host, options) : null;
    entries = scope === 'workspace' && !rootDir ? [] : listConversations({ appData, rootDir, scope });
  }
  return entries.filter((entry) => entry.host === host).map((entry) => ({ ...entry, appData }));
}

function discover(selector, options) {
  const hosts = selector.host ? [selector.host] : Object.keys(HOST_NAMES);
  return hosts.flatMap((host) => sessionsForHost(host, selector, options));
}

function formatRegisteredAt(value) {
  if (value === undefined || value === null) return '未知时间';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

export function formatSessions(entries) {
  return entries.map(({ host, sessionId, title, registeredAt, endedAt }) => {
    const columns = ['  [' + host + ']', sessionId, title || '无标题', formatRegisteredAt(registeredAt)];
    if (endedAt) columns.push('[已结束]');
    return columns.join('  ');
  }).join('\n');
}

function selectionError(message) {
  return Object.assign(new Error(message), { exitCode: 2 });
}

function noSessions(selector) {
  const host = selector.host ? HOST_NAMES[selector.host] : 'Antigravity、Codex 或 Claude Code';
  const scope = selector.scope === 'no-workspace' ? '无工作区' : '当前工作区';
  const missing = selector.sessionId ? '找不到指定会话' : '未找到已登记的' + scope + '会话';
  const error = selectionError(missing + '。请先在 ' + host + ' 中开启会话并确认 Fons Hook 已启用。');
  error.code = 'FONS_SESSION_NOT_FOUND';
  return error;
}

function discoverSessions(options = {}, { env = process.env, cwd = process.cwd() } = {}) {
  const selector = sessionSelector(options, env);
  const entries = discover(selector, { env, cwd });
  if (!entries.length) throw noSessions(selector);
  return { selector, entries };
}

export function listSessions(options = {}, environment = {}) {
  return discoverSessions(options, environment).entries;
}

export function resolveSession(options = {}, environment = {}) {
  const { selector, entries } = discoverSessions(options, environment);
  if (entries.length === 1) return entries[0];
  if (!selector.sessionId) {
    const active = entries.filter((entry) => !entry.endedAt);
    if (active.length === 1) return active[0];
  }
  throw selectionError('存在多个已登记会话，请用 -s 指定会话 ID 或用 --host 指定宿主。\n' + formatSessions(entries));
}

