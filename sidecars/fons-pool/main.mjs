import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addIdeas, archiveCompleted, completeIdea, findAppData, getMigrationWarning,
  holdEditing, isValidSessionId, lookupConversation, readPoolSnapshot, releaseEditing,
  removeIdea, reopenIdea, stampPoolTimers, updateIdeaText,
} from '../../scripts/fons-store.mjs';

const page = new URL('./index.html', import.meta.url);
const rowFields = ['rowIndex', 'expectedRaw'];
const operations = {
  add: [addIdeas, ['texts']],
  complete: [completeIdea, ['token']],
  update: [updateIdeaText, [...rowFields, 'newText']],
  remove: [removeIdea, rowFields],
  reopen: [reopenIdea, rowFields],
  archive: [archiveCompleted, []],
  hold: [holdEditing, ['id']],
  release: [releaseEditing, ['id']],
};

function jsonError(status, error) {
  return { status, contentType: 'application/json', body: JSON.stringify({ error }) };
}

const valid = {
  id: (v) => typeof v === 'string' && /^[a-f0-9]{12}$/.test(v),
  rowIndex: (v) => Number.isSafeInteger(v) && v >= 0,
  expectedRaw: (v) => typeof v === 'string',
  newText: (v) => typeof v === 'string' && v.trim().length > 0,
  token: (v) => typeof v === 'string' && /^[0-9]+-[a-f0-9]{64}$/.test(v),
  texts: (v) => Array.isArray(v) && v.every((s) => typeof s === 'string'),
};

function freshTimerTexts(result) {
  if (!result || result.conflict) return [];
  if (Array.isArray(result.texts)) return result.texts;
  const single = result.updatedText || result.reopenedText;
  return single ? [single] : [];
}

function readPool(context, { etag: previous }) {
  stampPoolTimers(context);
  const snapshot = readPoolSnapshot(context);
  const warning = getMigrationWarning(context);
  const etag = warning ? snapshot.etag + '|' + warning.status : snapshot.etag;
  if (previous === etag) return { unchanged: true, etag };
  const migrationWarning = warning ? { status: warning.status, message: warning.message } : null;
  return { ...snapshot, registered: true, scope: context.scope, migrationWarning, etag };
}

function canonicalPath(dir) {
  let resolved = path.resolve(dir);
  try { resolved = fs.realpathSync.native(resolved); }
  catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function uriToWorkspacePath(uri) {
  try { return fileURLToPath(uri); }
  catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

function workspaceMatchesRoot(workspaceUris, rootDir) {
  const target = canonicalPath(rootDir);
  return workspaceUris.some((uri) => {
    const wsPath = uriToWorkspacePath(uri);
    if (!wsPath) return false;
    const base = canonicalPath(wsPath);
    const rel = path.relative(base, target);
    return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
  });
}

function hasWorkspaceMismatch(entry, workspaceUris) {
  if (workspaceUris === undefined) return false;
  if (!workspaceUris.length) return entry.scope !== 'no-workspace';
  return entry.scope !== 'workspace' || !workspaceMatchesRoot(workspaceUris, entry.rootDir);
}

function mutate(operation, fields) {
  return (context, data) => {
    const options = { ...context };
    for (const field of fields) {
      if (!valid[field](data[field])) return jsonError(400, '无效参数：' + field);
      options[field] = data[field];
    }
    try {
      const result = operation(options);
      if (operation !== holdEditing && operation !== releaseEditing) {
        stampPoolTimers({ ...context, freshTexts: freshTimerTexts(result) });
      }
      return result;
    } catch (error) {
      if (error.code === 'FONS_STALE_TOKEN') return { conflict: true };
      throw error;
    }
  };
}

function boundHandler(appData, action) {
  return (data = {}) => {
    const sessionId = data.conversationId;
    if (!isValidSessionId(sessionId)) return jsonError(400, '无效的会话 ID。');
    if (data.workspaceUris !== undefined && (!Array.isArray(data.workspaceUris) || !data.workspaceUris.every((s) => typeof s === 'string'))) {
      return jsonError(400, '无效参数：workspaceUris');
    }
    if (!appData) return jsonError(503, '无法定位宿主数据目录。');
    const entry = lookupConversation({ appData, sessionId });
    if (!entry) return action === readPool ? { registered: false } : jsonError(404, '当前会话尚未由 Fons Hook 登记。');
    if (hasWorkspaceMismatch(entry, data.workspaceUris)) {
      return action === readPool
        ? { registered: true, scopeMismatch: true, scope: entry.scope }
        : jsonError(409, '当前会话与工作区状态不匹配。');
    }
    return action({ scope: entry.scope, rootDir: entry.rootDir, fonsDir: entry.fonsDir, sessionId }, data);
  };
}

export function mountPoolRoutes(app, appData) {
  app.page('/', () => fs.readFileSync(page, 'utf8'));
  app.api('/api/pool', boundHandler(appData, readPool), 'POST');
  for (const [name, [operation, fields]] of Object.entries(operations)) {
    app.api('/api/pool/' + name, boundHandler(appData, mutate(operation, fields)), 'POST');
  }
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
