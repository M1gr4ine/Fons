import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_DEBOUNCE_SEC = 15;
const MIN_DEBOUNCE_SEC = 0;
const MAX_DEBOUNCE_SEC = 3600;

const UNRESOLVABLE_PATH = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP', 'EIO', 'UNKNOWN']);

function withoutDevicePrefix(value) {
  if (process.platform !== 'win32') return value;
  if (value.toUpperCase().startsWith('\\\\?\\UNC\\')) return '\\\\' + value.slice(8);
  if (/^\\\\\?\\[a-z]:\\/i.test(value)) return value.slice(4);
  return value;
}

export function canonicalPath(dir) {
  const resolved = path.resolve(withoutDevicePrefix(dir));
  try {
    return withoutDevicePrefix(fs.realpathSync.native(resolved));
  } catch (error) {
    if (UNRESOLVABLE_PATH.has(error.code)) return resolved;
    throw error;
  }
}

function toPathKey(normalized) {
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function workspacePathKey(dir) {
  return toPathKey(canonicalPath(dir));
}

function isSameOrSubpathKey(parentKey, childKey) {
  const rel = path.relative(parentKey, childKey);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

export function isSameOrSubpath(parentDir, childDir) {
  return isSameOrSubpathKey(workspacePathKey(parentDir), workspacePathKey(childDir));
}

function configPath(appData) {
  return path.join(path.resolve(appData), 'fons', 'config.json');
}

function defaultConfig() {
  return {
    debounceSec: DEFAULT_DEBOUNCE_SEC,
    stopWaitDebounce: false,
    autoAttachWorkspaces: true,
    enabledWorkspaces: [],
    disabledWorkspaces: [],
  };
}

function isValidAbsolutePath(value) {
  return typeof value === 'string' && !value.includes('\0') && path.isAbsolute(value.trim());
}

function normalizeWorkspaceList(raw, blockedKeys = new Set()) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set(blockedKeys);
  const result = [];
  for (const item of raw) {
    if (!isValidAbsolutePath(item)) continue;
    const normalized = canonicalPath(item.trim());
    const key = toPathKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function normalizeDebounceSec(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_DEBOUNCE_SEC;
  if (value < MIN_DEBOUNCE_SEC || value > MAX_DEBOUNCE_SEC) return DEFAULT_DEBOUNCE_SEC;
  return Math.round(value);
}

function normalizeConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaultConfig();
  const disabledWorkspaces = normalizeWorkspaceList(raw.disabledWorkspaces);
  const disabledKeys = new Set(disabledWorkspaces.map(toPathKey));
  return {
    debounceSec: normalizeDebounceSec(raw.debounceSec),
    stopWaitDebounce: raw.stopWaitDebounce === true,
    autoAttachWorkspaces: raw.autoAttachWorkspaces !== false,
    enabledWorkspaces: normalizeWorkspaceList(raw.enabledWorkspaces, disabledKeys),
    disabledWorkspaces,
  };
}

function readRawJson(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!content.trim()) return null;
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function writeConfigAtomic(filePath, config) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.writeFileSync(temp, JSON.stringify(config, null, 2) + '\n', 'utf8');
    fs.renameSync(temp, filePath);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

export function readFonsConfig(appData) {
  if (!appData) return defaultConfig();
  return normalizeConfig(readRawJson(configPath(appData)));
}

function removeWorkspaceKey(list, key) {
  return list.filter((entry) => toPathKey(entry) !== key);
}

function applyWorkspaceAction(config, action) {
  const normalized = canonicalPath(action.path.trim());
  const key = toPathKey(normalized);
  let enabled = removeWorkspaceKey(config.enabledWorkspaces, key);
  let disabled = removeWorkspaceKey(config.disabledWorkspaces, key);
  if (action.mode === 'enable' && (!config.autoAttachWorkspaces || longestMatchingPrefix(disabled, key) >= 0)) {
    enabled = [...enabled, normalized];
  } else if (action.mode === 'disable' && (config.autoAttachWorkspaces || action.localPlugin || longestMatchingPrefix(enabled, key) >= 0)) {
    disabled = [...disabled, normalized];
  }
  return { ...config, enabledWorkspaces: enabled, disabledWorkspaces: disabled };
}

function invalidConfig(message) {
  return Object.assign(new Error(message), { code: 'FONS_INVALID_CONFIG' });
}

function validatePatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw invalidConfig('无效的设置参数。');
  }
  if (patch.debounceSec !== undefined) {
    const value = patch.debounceSec;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < MIN_DEBOUNCE_SEC || value > MAX_DEBOUNCE_SEC) {
      throw invalidConfig(`蓄水时长必须为 ${MIN_DEBOUNCE_SEC} 到 ${MAX_DEBOUNCE_SEC} 之间的整数秒。`);
    }
  }
  if (patch.stopWaitDebounce !== undefined && typeof patch.stopWaitDebounce !== 'boolean') {
    throw invalidConfig('无效参数：stopWaitDebounce');
  }
  if (patch.autoAttachWorkspaces !== undefined && typeof patch.autoAttachWorkspaces !== 'boolean') {
    throw invalidConfig('无效参数：autoAttachWorkspaces');
  }
  if (patch.workspaceAction !== undefined) {
    const action = patch.workspaceAction;
    if (!action || typeof action !== 'object' || !isValidAbsolutePath(action.path) || !['enable', 'disable', 'reset'].includes(action.mode)) {
      throw invalidConfig('无效的工作区挂载操作。');
    }
  }
}

export function updateFonsConfig(appData, patch) {
  if (!appData) throw new Error('无法定位宿主数据目录。');
  validatePatch(patch);
  let next = readFonsConfig(appData);
  if (patch.debounceSec !== undefined) next = { ...next, debounceSec: patch.debounceSec };
  if (patch.stopWaitDebounce !== undefined) next = { ...next, stopWaitDebounce: patch.stopWaitDebounce };
  if (patch.autoAttachWorkspaces !== undefined) next = { ...next, autoAttachWorkspaces: patch.autoAttachWorkspaces };
  if (patch.workspaceAction !== undefined) next = applyWorkspaceAction(next, patch.workspaceAction);
  writeConfigAtomic(configPath(appData), next);
  return next;
}

function parseEnvDebounceSec(env) {
  const raw = env?.FONS_DEBOUNCE_SEC;
  if (raw === undefined || String(raw).trim() === '') return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

function parseEnvStopWait(env) {
  if (env?.FONS_STOP_WAIT_DEBOUNCE === '1') return true;
  if (env?.FONS_STOP_WAIT_DEBOUNCE === '0') return false;
  return null;
}

export function hasEnvDebounceOverride(env = process.env) {
  return parseEnvDebounceSec(env) !== null;
}

export function hasEnvStopWaitOverride(env = process.env) {
  return parseEnvStopWait(env) !== null;
}

export function resolveConfiguredDebounceMs({ appData = null, env = process.env } = {}) {
  return (parseEnvDebounceSec(env) ?? readFonsConfig(appData).debounceSec) * 1000;
}

export function resolveStopWaitDebounce({ appData = null, env = process.env } = {}) {
  return parseEnvStopWait(env) ?? readFonsConfig(appData).stopWaitDebounce;
}

function longestMatchingPrefix(workspaces, rootKey) {
  let best = -1;
  for (const entry of workspaces) {
    const entryKey = workspacePathKey(entry);
    if (isSameOrSubpathKey(entryKey, rootKey)) {
      best = Math.max(best, entryKey.length);
    }
  }
  return best;
}

export function workspaceConfigState({ appData, rootDir, config, localPlugin = false }) {
  if (!rootDir) return { enabled: true, explicitState: 'default' };
  const resolvedConfig = config ?? readFonsConfig(appData);
  const rootKey = workspacePathKey(rootDir);
  const disabledLen = longestMatchingPrefix(resolvedConfig.disabledWorkspaces, rootKey);
  const enabledLen = longestMatchingPrefix(resolvedConfig.enabledWorkspaces, rootKey);
  if (disabledLen >= 0 && disabledLen >= enabledLen) {
    return { enabled: false, explicitState: 'disabled' };
  }
  if (enabledLen >= 0) {
    return { enabled: true, explicitState: 'enabled' };
  }
  return { enabled: resolvedConfig.autoAttachWorkspaces || Boolean(localPlugin), explicitState: 'default' };
}

export function isWorkspaceEnabled(options) {
  return workspaceConfigState(options).enabled;
}

function isExcludedName(exclude, names) {
  if (!Array.isArray(exclude)) return false;
  const blocked = new Set(exclude.filter((item) => typeof item === 'string').map((item) => item.trim().toLowerCase()));
  return names.some((name) => blocked.has(name.toLowerCase()));
}

function entryMountsRepo(rootDir, entry, repoRoot, repoKey) {
  if (!entry || entry.enabled === false || typeof entry.path !== 'string' || !entry.path.trim()) return false;
  const base = path.resolve(rootDir, entry.path);
  const baseKey = workspacePathKey(base);
  if (baseKey === repoKey) return true;
  const repoName = path.basename(repoRoot);
  if (isExcludedName(entry.exclude, [repoName, 'fons'])) return false;
  if (Array.isArray(entry.include_only)) {
    return entry.include_only.some((name) =>
      typeof name === 'string' && name.trim() && workspacePathKey(path.join(base, name)) === repoKey
    );
  }
  if (workspacePathKey(path.dirname(repoRoot)) === baseKey) return true;
  return fs.existsSync(path.join(base, 'fons', 'hooks.json'));
}

export function hasLocalWorkspaceFonsPlugin(rootDir, repoRoot) {
  if (!rootDir) return false;
  const resolvedRoot = canonicalPath(rootDir);
  if (fs.existsSync(path.join(resolvedRoot, '.agents', 'plugins', 'fons', 'hooks.json'))) return true;
  const manifest = readRawJson(path.join(resolvedRoot, '.agents', 'plugins.json'));
  if (!repoRoot || !Array.isArray(manifest?.entries)) return false;
  const resolvedRepo = canonicalPath(repoRoot);
  const repoKey = toPathKey(resolvedRepo);
  return manifest.entries.some((entry) => entryMountsRepo(resolvedRoot, entry, resolvedRepo, repoKey));
}
