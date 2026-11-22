import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalPath, hasEnvDebounceOverride, hasEnvStopWaitOverride, hasLocalWorkspaceFonsPlugin,
  isSameOrSubpath, isWorkspaceEnabled, readFonsConfig, resolveConfiguredDebounceMs,
  updateFonsConfig, workspaceConfigState,
} from '../../scripts/fons-config.mjs';
import { isValidStoredName } from '../../scripts/fons-inbox.mjs';
import {
  MAX_ATTACHMENT_BYTES, MAX_ITEM_ATTACHMENTS, addIdeas, archiveCompleted, completeIdea,
  findAppData, holdEditing, isValidSessionId, lookupConversation,
  readAttachment, readPoolSnapshot, registerConversation, releaseEditing, removeIdea, reopenIdea,
  stampPoolTimers, updateIdeaText,
} from '../../scripts/fons-store.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const page = new URL('./index.html', import.meta.url);
const SIDECAR_PRELOAD = '<script src="/preload.js"></script>';
export const POOL_BODY_LIMIT = 256 * 1024;
export const POOL_UPLOAD_LIMIT = 112 * 1024 * 1024;
export const POOL_UPLOAD_ROUTES = new Set(['/api/pool/add', '/api/pool/update']);
export const POOL_TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const MAX_UPLOAD_BASE64 = Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 16;
const rowFields = ['rowIndex', 'expectedRaw'];
const operations = {
  add: [addIdeas, ['texts', 'attachments']],
  complete: [completeIdea, ['token']],
  update: [updateIdeaText, [...rowFields, 'newText', 'keepAttachments', 'newAttachments']],
  remove: [removeIdea, rowFields],
  reopen: [reopenIdea, rowFields],
  archive: [archiveCompleted, []],
  hold: [holdEditing, ['id']],
  release: [releaseEditing, ['id']],
};

function jsonError(status, error) {
  return { status, contentType: 'application/json', body: JSON.stringify({ error }) };
}

function isValidUploadEntry(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  if (typeof v.name !== 'string' || !v.name.trim() || v.name.length > 255) return false;
  if (v.mimeType !== undefined && (typeof v.mimeType !== 'string' || v.mimeType.length > 128)) return false;
  return typeof v.dataBase64 === 'string' && v.dataBase64.length > 0 && v.dataBase64.length <= MAX_UPLOAD_BASE64;
}

function isOptionalUploadList(v) {
  return v === undefined || (Array.isArray(v) && v.length <= MAX_ITEM_ATTACHMENTS && v.every(isValidUploadEntry));
}

const valid = {
  id: (v) => typeof v === 'string' && /^[a-f0-9]{12}$/.test(v),
  rowIndex: (v) => Number.isSafeInteger(v) && v >= 0,
  expectedRaw: (v) => typeof v === 'string',
  newText: (v, data) => typeof v === 'string' && (
    v.trim().length > 0 ||
    (Array.isArray(data.keepAttachments) && data.keepAttachments.length > 0) ||
    (Array.isArray(data.newAttachments) && data.newAttachments.length > 0)
  ),
  token: (v) => typeof v === 'string' && /^[0-9]+-[a-f0-9]{64}$/.test(v),
  texts: (v, data) => (
    v === undefined
      ? Array.isArray(data.attachments) && data.attachments.length > 0
      : Array.isArray(v) && v.every((s) => typeof s === 'string')
  ),
  attachments: isOptionalUploadList,
  keepAttachments: (v) => v === undefined || (Array.isArray(v) && v.length <= MAX_ITEM_ATTACHMENTS && v.every(isValidStoredName)),
  newAttachments: isOptionalUploadList,
};

function freshTimerTexts(result) {
  if (!result || result.conflict) return [];
  if (Array.isArray(result.texts)) return result.texts;
  const single = result.updatedText || result.reopenedText;
  return single ? [single] : [];
}

function readPool(context, { etag: previous }) {
  stampPoolTimers(context);
  const debounceMs = resolveConfiguredDebounceMs({ appData: context.appData, env: context.env });
  const snapshot = readPoolSnapshot({ ...context, debounceMs });
  if (previous === snapshot.etag) return { unchanged: true, etag: snapshot.etag };
  return { ...snapshot, registered: true, scope: context.scope };
}

function uriToWorkspacePath(uri) {
  try { return fileURLToPath(uri); }
  catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

function firstWorkspacePath(workspaceUris) {
  if (!Array.isArray(workspaceUris) || !workspaceUris.length) return null;
  const wsPath = uriToWorkspacePath(workspaceUris[0]);
  return wsPath ? canonicalPath(wsPath) : null;
}

function isExistingDirectory(dirPath) {
  return Boolean(dirPath && fs.statSync(dirPath, { throwIfNoEntry: false })?.isDirectory());
}

function workspaceMatchesRoot(workspaceUris, rootDir) {
  return workspaceUris.some((uri) => {
    const wsPath = uriToWorkspacePath(uri);
    return wsPath ? isSameOrSubpath(wsPath, rootDir) : false;
  });
}

function hasWorkspaceMismatch(entry, workspaceUris) {
  if (workspaceUris === undefined) return false;
  if (!workspaceUris.length) return entry.scope !== 'no-workspace';
  return entry.scope !== 'workspace' || !workspaceMatchesRoot(workspaceUris, entry.rootDir);
}

function readAttachmentRoute(context, data) {
  if (!isValidStoredName(data.storedName)) return jsonError(400, '无效参数：storedName');
  const attachment = readAttachment({ ...context, storedName: data.storedName });
  if (!attachment) return jsonError(404, '附件不存在或已被清理。');
  return attachment;
}

function mutate(operation, fields) {
  return (context, data) => {
    const options = { ...context };
    for (const field of fields) {
      if (!valid[field](data[field], data)) return jsonError(400, '无效参数：' + field);
      if (data[field] !== undefined) options[field] = data[field];
    }
    try {
      const result = operation(options);
      if (operation !== holdEditing && operation !== releaseEditing) {
        stampPoolTimers({ ...context, freshTexts: freshTimerTexts(result) });
      }
      return result;
    } catch (error) {
      if (error.code === 'FONS_STALE_TOKEN') return { conflict: true };
      if (error.code === 'FONS_INVALID_ATTACHMENT') return jsonError(400, error.message);
      throw error;
    }
  };
}

function validWorkspaceUris(workspaceUris) {
  return workspaceUris === undefined || (Array.isArray(workspaceUris) && workspaceUris.every((uri) => typeof uri === 'string'));
}

function unregisteredResponse({ appData, action, workspaceUris }) {
  if (action !== readPool) return jsonError(404, '当前会话尚未由 Fons Hook 登记。');
  const wsDir = firstWorkspacePath(workspaceUris);
  if (wsDir) {
    const localPlugin = hasLocalWorkspaceFonsPlugin(wsDir, REPO_ROOT);
    if (!isWorkspaceEnabled({ appData, rootDir: wsDir, localPlugin })) {
      return { registered: false, workspaceDisabled: true };
    }
  }
  return { registered: false };
}

function disabledWorkspaceResponse({ appData, action, rootDir, detectLocalPlugin }) {
  const localPlugin = detectLocalPlugin ? hasLocalWorkspaceFonsPlugin(rootDir, REPO_ROOT) : false;
  if (isWorkspaceEnabled({ appData, rootDir, localPlugin })) return null;
  return action === readPool
    ? { registered: true, workspaceDisabled: true, scope: 'workspace' }
    : jsonError(409, '当前工作区已停用 Fons，可在设置中重新启用。');
}

function sessionContextError({ appData, action, entry, workspaceUris }) {
  if (!entry) return unregisteredResponse({ appData, action, workspaceUris });
  if (hasWorkspaceMismatch(entry, workspaceUris)) {
    return action === readPool
      ? { registered: true, scopeMismatch: true, scope: entry.scope }
      : jsonError(409, '当前会话与工作区状态不匹配。');
  }
  if (entry.scope === 'workspace') {
    return disabledWorkspaceResponse({ appData, action, rootDir: entry.rootDir, detectLocalPlugin: true });
  }
  return null;
}

function sessionHandler(appData, action) {
  return (data = {}) => {
    const sessionId = data.conversationId;
    if (!isValidSessionId(sessionId)) return jsonError(400, '无效的会话 ID。');
    if (!validWorkspaceUris(data.workspaceUris)) return jsonError(400, '无效参数：workspaceUris');
    if (!appData) return jsonError(503, '无法定位宿主数据目录。');
    const entry = lookupConversation({ appData, sessionId });
    const rejected = sessionContextError({ appData, action, entry, workspaceUris: data.workspaceUris });
    if (rejected) return rejected;
    return action({ scope: entry.scope, rootDir: entry.rootDir, fonsDir: entry.fonsDir, sessionId, appData }, data);
  };
}

function bindSession(appData, boundSession, env = process.env) {
  if (!appData || !boundSession || !isValidSessionId(boundSession.sessionId)) {
    throw new Error('缺少已登记的 Fons 会话。');
  }
  const { sessionId, scope, rootDir, host } = boundSession;
  const entry = lookupConversation({ appData, sessionId });
  if (!entry || entry.scope !== scope || (host && entry.host !== host)) {
    throw new Error('Fons 会话与登记不匹配。');
  }
  if (scope === 'workspace' && (typeof rootDir !== 'string' || canonicalPath(rootDir) !== canonicalPath(entry.rootDir))) {
    throw new Error('Fons 会话的工作区与登记不匹配。');
  }
  return { sessionId, scope: entry.scope, rootDir: entry.rootDir, fonsDir: entry.fonsDir, appData, env };
}

function boundHandler(context, action) {
  return (data = {}) => {
    if (data.conversationId !== undefined && data.conversationId !== context.sessionId) {
      return jsonError(403, '当前面板未绑定此会话。');
    }
    if (!validWorkspaceUris(data.workspaceUris)) return jsonError(400, '无效参数：workspaceUris');
    if (hasWorkspaceMismatch(context, data.workspaceUris)) return jsonError(409, '当前会话与工作区状态不匹配。');
    if (context.scope === 'workspace') {
      const disabled = disabledWorkspaceResponse({
        appData: context.appData, action, rootDir: context.rootDir, detectLocalPlugin: false,
      });
      if (disabled) return disabled;
    }
    return action(context, data);
  };
}

export function buildCurrentWorkspaceInfo({ appData, config, rootDir, detectLocalPlugin }) {
  if (!rootDir) return null;
  const normalized = canonicalPath(rootDir);
  const localPlugin = detectLocalPlugin ? hasLocalWorkspaceFonsPlugin(normalized, REPO_ROOT) : false;
  const { enabled, explicitState } = workspaceConfigState({ appData, rootDir: normalized, config, localPlugin });
  return { path: normalized, name: path.basename(normalized) || normalized, enabled, localPlugin, explicitState };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeWorkspaceActionPatch({ action, detectLocalPlugin }) {
  if (!isPlainObject(action)) return action;
  const actionPath = typeof action.path === 'string' ? action.path.trim() : '';
  const validPath = Boolean(actionPath) && !actionPath.includes('\0') && path.isAbsolute(actionPath);
  const localPlugin = detectLocalPlugin && validPath ? hasLocalWorkspaceFonsPlugin(actionPath, REPO_ROOT) : false;
  return { path: action.path, mode: action.mode, localPlugin };
}

export function applySettingsPatch({ appData, update, detectLocalPlugin }) {
  if (!isPlainObject(update)) return { error: jsonError(400, '无效的设置参数。') };
  const patch = {};
  if (update.debounceSec !== undefined) patch.debounceSec = update.debounceSec;
  if (update.stopWaitDebounce !== undefined) patch.stopWaitDebounce = update.stopWaitDebounce;
  if (update.autoAttachWorkspaces !== undefined) patch.autoAttachWorkspaces = update.autoAttachWorkspaces;
  if (update.workspaceAction !== undefined) {
    patch.workspaceAction = normalizeWorkspaceActionPatch({ action: update.workspaceAction, detectLocalPlugin });
  }
  if (!Object.keys(patch).length) return { config: readFonsConfig(appData) };
  try {
    return { config: updateFonsConfig(appData, patch) };
  } catch (error) {
    if (error.code === 'FONS_INVALID_CONFIG') return { error: jsonError(400, error.message) };
    throw error;
  }
}

function validateRegisterPreconditions({ appData, sessionId, workspaceUris }) {
  if (!isValidSessionId(sessionId)) return { error: jsonError(400, '无效的会话 ID。') };
  if (workspaceUris === undefined) return { error: jsonError(400, '缺少工作区信息，无法登记会话。') };
  const existing = lookupConversation({ appData, sessionId });
  if (existing) {
    if (hasWorkspaceMismatch(existing, workspaceUris)) {
      return { error: jsonError(409, '当前会话与工作区状态不匹配。') };
    }
    return { alreadyRegistered: true, rootDir: null };
  }
  if (!workspaceUris.length) return { alreadyRegistered: false, rootDir: null };
  const rootDir = firstWorkspacePath(workspaceUris);
  if (!isExistingDirectory(rootDir)) return { error: jsonError(400, '工作区目录不存在。') };
  return { alreadyRegistered: false, rootDir };
}

function registerSessionFromSettings({ appData, sessionId, rootDir, config }) {
  if (!rootDir) {
    registerConversation({ appData, sessionId, scope: 'no-workspace', rootDir: null });
    return null;
  }
  const localPlugin = hasLocalWorkspaceFonsPlugin(rootDir, REPO_ROOT);
  if (!isWorkspaceEnabled({ appData, rootDir, config, localPlugin })) {
    return jsonError(409, '当前工作区未启用 Fons。');
  }
  registerConversation({ appData, sessionId, scope: 'workspace', rootDir });
  return null;
}

function validateSettingsRequest(appData, data) {
  if (!appData) return jsonError(503, '无法定位宿主数据目录。');
  if (data.conversationId !== undefined && data.conversationId !== '' && !isValidSessionId(data.conversationId)) {
    return jsonError(400, '无效的会话 ID。');
  }
  if (!validWorkspaceUris(data.workspaceUris)) return jsonError(400, '无效参数：workspaceUris');
  return null;
}

function resolveSettingsRootDir(entry, workspaceUris) {
  if (workspaceUris !== undefined) return firstWorkspacePath(workspaceUris);
  if (entry?.scope === 'workspace') return entry.rootDir;
  return null;
}

function canRegisterCurrentSession({ sessionId, entry, workspaceUris, currentWorkspace }) {
  if (!sessionId || entry || workspaceUris === undefined) return false;
  if (!workspaceUris.length) return true;
  return Boolean(currentWorkspace?.enabled && isExistingDirectory(currentWorkspace.path));
}

function applySettingsMutation({ appData, sessionId, workspaceUris, update }) {
  if (!isPlainObject(update)) return { error: jsonError(400, '无效的设置参数。') };
  const wantsRegister = update.registerCurrentSession === true;
  const regPlan = wantsRegister ? validateRegisterPreconditions({ appData, sessionId, workspaceUris }) : null;
  if (regPlan?.error) return { error: regPlan.error };
  const updated = applySettingsPatch({ appData, update, detectLocalPlugin: true });
  if (updated.error) return updated;
  if (wantsRegister && !regPlan.alreadyRegistered) {
    const regError = registerSessionFromSettings({
      appData, sessionId, rootDir: regPlan.rootDir, config: updated.config,
    });
    if (regError) return { error: regError };
  }
  return { config: updated.config };
}

export function formatSettingsPayload({ config, currentWorkspace, sessionRegistered, canRegisterSession, env = process.env }) {
  return {
    config,
    envOverrides: {
      debounceSec: hasEnvDebounceOverride(env),
      stopWaitDebounce: hasEnvStopWaitOverride(env),
    },
    currentWorkspace,
    sessionRegistered,
    canRegisterSession,
  };
}

function settingsHandler(appData) {
  return (data = {}) => {
    const invalid = validateSettingsRequest(appData, data);
    if (invalid) return invalid;
    const sessionId = isValidSessionId(data.conversationId) ? data.conversationId : null;
    let config = readFonsConfig(appData);
    if (data.update !== undefined) {
      const mutated = applySettingsMutation({ appData, sessionId, workspaceUris: data.workspaceUris, update: data.update });
      if (mutated.error) return mutated.error;
      config = mutated.config;
    }
    const entry = sessionId ? lookupConversation({ appData, sessionId }) : null;
    const rootDir = resolveSettingsRootDir(entry, data.workspaceUris);
    const currentWorkspace = buildCurrentWorkspaceInfo({ appData, config, rootDir, detectLocalPlugin: true });
    const canRegisterSession = canRegisterCurrentSession({
      sessionId, entry, workspaceUris: data.workspaceUris, currentWorkspace,
    });
    return formatSettingsPayload({
      config, currentWorkspace, sessionRegistered: Boolean(entry), canRegisterSession,
    });
  };
}

function boundSettingsHandler(context) {
  return (data = {}) => {
    if (data.conversationId !== undefined && data.conversationId !== context.sessionId) {
      return jsonError(403, '当前面板未绑定此会话。');
    }
    if (!validWorkspaceUris(data.workspaceUris)) return jsonError(400, '无效参数：workspaceUris');
    if (hasWorkspaceMismatch(context, data.workspaceUris)) return jsonError(409, '当前会话与工作区状态不匹配。');
    let config = readFonsConfig(context.appData);
    if (data.update !== undefined) {
      const updated = applySettingsPatch({ appData: context.appData, update: data.update, detectLocalPlugin: false });
      if (updated.error) return updated.error;
      config = updated.config;
    }
    const currentWorkspace = buildCurrentWorkspaceInfo({
      appData: context.appData, config, rootDir: context.rootDir, detectLocalPlugin: false,
    });
    return formatSettingsPayload({
      config, currentWorkspace, sessionRegistered: true, canRegisterSession: false, env: context.env,
    });
  };
}

export function mountPoolRoutes(app, appData, options) {
  const bound = options === undefined ? null : bindSession(appData, options.boundSession, options.env);
  const handlerFor = bound
    ? (action) => boundHandler(bound, action)
    : (action) => sessionHandler(appData, action);
  app.page('/', () => fs.readFileSync(page, 'utf8'));
  app.api('/api/pool', handlerFor(readPool), 'POST');
  app.api('/api/pool/settings', bound ? boundSettingsHandler(bound) : settingsHandler(appData), 'POST');
  app.api('/api/pool/attachment', handlerFor(readAttachmentRoute), 'POST');
  for (const [name, [operation, fields]] of Object.entries(operations)) {
    app.api('/api/pool/' + name, handlerFor(mutate(operation, fields)), 'POST');
  }
}

export function createBoundPoolRoutes(boundSession, { env } = {}) {
  const routes = new Map();
  mountPoolRoutes({
    page() {},
    api(routePath, handle, method) {
      if (method !== 'POST') throw new Error('Fons 面板只支持 POST 操作。');
      routes.set(routePath, handle);
    },
  }, boundSession.appData, { boundSession, env });
  return routes;
}

export function renderPoolBridgeHtml(helpers, entrypointCall) {
  const view = fs.readFileSync(page, 'utf8');
  if (!view.includes(SIDECAR_PRELOAD)) throw new Error('Fons pool preload script is missing.');
  const bridge = helpers.map((helper) => helper.toString()).join('\n');
  return view.replace(SIDECAR_PRELOAD, () => '<script>(() => {\n' + bridge
    + '\n' + entrypointCall + '\n})();</script>');
}

function isEntryPoint() {
  if (typeof import.meta.main === 'boolean') return import.meta.main;
  return process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
}

export async function startSidecar() {
  if (!process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN) {
    throw new Error('缺少 ANTIGRAVITY_SIDECAR_UI_TOKEN，拒绝启动。');
  }
  const { SidecarApp } = await import('sidecar_sdk');
  const app = new SidecarApp();
  mountPoolRoutes(app, findAppData(process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR, 'sidecar_data'));
  return app.run();
}

if (isEntryPoint()) {
  await startSidecar();
}
