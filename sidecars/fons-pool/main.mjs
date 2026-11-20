import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidStoredName } from '../../scripts/fons-inbox.mjs';
import {
  MAX_ATTACHMENT_BYTES, MAX_ITEM_ATTACHMENTS, addIdeas, archiveCompleted, completeIdea,
  findAppData, getMigrationWarning, holdEditing, isValidSessionId, lookupConversation,
  readAttachment, readPoolSnapshot, releaseEditing, removeIdea, reopenIdea, stampPoolTimers,
  updateIdeaText,
} from '../../scripts/fons-store.mjs';

const page = new URL('./index.html', import.meta.url);
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
  app.api('/api/pool/attachment', boundHandler(appData, readAttachmentRoute), 'POST');
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
