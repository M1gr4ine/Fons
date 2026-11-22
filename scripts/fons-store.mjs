import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveConfiguredDebounceMs, workspacePathKey } from './fons-config.mjs';
import {
  COMPLETED_PREFIX, isCompletedLine, parseInbox, parseActiveItems, completedText,
  deliveryId, deliveryIdAfterRemovingCompletion,
  cleanAttachmentLabel, composeIdeaText, formatArchivedIdeaText, isValidStoredName, splitIdeaText,
} from './fons-inbox.mjs';

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ITEM_ATTACHMENTS = 8;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BASE64_CHARS = Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 16;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const WIN_RESERVED_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const IMAGE_MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};
const MIME_BY_EXT = {
  ...IMAGE_MIME_BY_EXT,
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
};
const EXT_BY_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
  'application/pdf': '.pdf',
  'application/json': '.json',
  'text/markdown': '.md',
  'text/plain': '.txt',
  'text/csv': '.csv',
};
const lockWait = new Int32Array(new SharedArrayBuffer(4));

function invalidAttachment(message) {
  return Object.assign(new Error(message), { code: 'FONS_INVALID_ATTACHMENT' });
}

function isImageStoredName(storedName) {
  return Boolean(IMAGE_MIME_BY_EXT[path.extname(String(storedName ?? '')).toLowerCase()]);
}

function mimeTypeForAttachment(storedName) {
  return MIME_BY_EXT[path.extname(storedName).toLowerCase()] || 'application/octet-stream';
}

export function isValidSessionId(sessionId) {
  return typeof sessionId === 'string' && UUID.test(sessionId);
}

export function noWorkspaceFonsDir(appData) {
  return path.join(path.resolve(appData), 'fons', 'no-workspace');
}

function resolveFonsDir({ fonsDir, rootDir }) {
  if (typeof fonsDir === 'string' && fonsDir) return fonsDir;
  if (typeof rootDir === 'string' && rootDir) return path.join(rootDir, '.agents', 'fons');
  throw new Error('缺少有效的存储目录。');
}

export function sessionPaths({ fonsDir, rootDir, sessionId }) {
  if (!isValidSessionId(sessionId)) throw new Error('无效的会话 ID。');
  const dir = resolveFonsDir({ fonsDir, rootDir });
  return {
    fonsDir: dir,
    ideas: path.join(dir, `ideas-${sessionId}.md`),
    state: path.join(dir, `.state-${sessionId}.json`),
    ui: path.join(dir, `.ui-${sessionId}.json`),
    archive: path.join(dir, 'archive', `${sessionId}.md`),
    attachmentsDir: path.join(dir, 'attachments', sessionId),
    retractMarker: path.join(dir, `.retract-${sessionId}.pending`),
  };
}

function releaseInboxLock(lock, owner) {
  try {
    if (owner) fs.rmdirSync(path.join(lock, owner));
    fs.rmdirSync(lock);
  } catch (error) {
    // A competing process can publish a new, nonempty lock before the final rmdir.
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
  }
}

function processStatus(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'unknown';
  try { process.kill(pid, 0); return 'active'; }
  catch (error) { return error.code === 'ESRCH' ? 'interrupted' : 'unknown'; }
}

function reclaimInboxLock(lock) {
  let entries;
  try { entries = fs.readdirSync(lock); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!entries.length) return releaseInboxLock(lock);
  const [owner] = entries;
  const pid = Number(/^([0-9]+)-[A-Za-z0-9]+$/.exec(owner)?.[1]);
  if (entries.length === 1 && processStatus(pid) === 'interrupted') releaseInboxLock(lock, owner);
}

function claimInboxLock(staged, lock) {
  const deadline = Date.now() + 1000;
  while (true) {
    try { fs.renameSync(staged, lock); return; }
    catch (error) {
      // Windows reports EPERM when the destination directory already exists.
      if (!['ENOTEMPTY', 'EEXIST', 'EPERM'].includes(error.code)) throw error;
      if (Date.now() >= deadline) {
        throw new Error('无法取得会话收件箱写入锁：' + lock, { cause: error });
      }
    }
    reclaimInboxLock(lock);
    Atomics.wait(lockWait, 0, 0, 10);
  }
}

function acquirePoolLock({ fonsDir, lock }) {
  let staged;
  let owner;
  try {
    fs.mkdirSync(fonsDir, { recursive: true });
    staged = fs.mkdtempSync(lock + '-');
    const ownerName = `${process.pid}-${staged.slice(lock.length + 1)}`;
    // Publish the owner together with the directory so readers never see a half-acquired lock.
    fs.mkdirSync(path.join(staged, ownerName));
    owner = ownerName;
    claimInboxLock(staged, lock);
    return owner;
  } catch (error) {
    if (staged) releaseInboxLock(staged, owner);
    throw Object.assign(new Error(error.message, { cause: error }), { code: 'FONS_POOL_LOCK' });
  }
}

export function withPoolWrite(context, write) {
  const { fonsDir } = sessionPaths(context);
  const lock = path.join(fonsDir, `.inbox-${context.sessionId}.lock`);
  const owner = acquirePoolLock({ fonsDir, lock });
  try {
    return write();
  } finally {
    releaseInboxLock(lock, owner);
  }
}

function poolWriter(write) {
  return (context) => withPoolWrite(context, () => write(context));
}

export function findAppData(startPath, ancestorName) {
  if (!startPath) return null;
  let dir = path.resolve(startPath);
  while (true) {
    if (path.basename(dir).toLowerCase() === ancestorName.toLowerCase()) return path.dirname(dir);
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readContent(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

export function readJson(filePath) {
  const content = readContent(filePath);
  if (!content) return {};
  const value = JSON.parse(content);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`无效的 JSON 对象：${filePath}`);
  return value;
}

export function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeContentsAtomic(filePath, JSON.stringify(value, null, 2));
}

function writeContentsAtomic(filePath, content, { mode, expected } = {}) {
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.writeFileSync(temporary, content, 'utf8');
    if (mode !== undefined) fs.chmodSync(temporary, mode);
    if (expected !== undefined && readContent(filePath) !== expected) {
      throw new Error('收件箱已变化，未确认本轮灵感：' + filePath);
    }
    fs.renameSync(temporary, filePath);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function writeBufferAtomic(filePath, buffer) {
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.writeFileSync(temporary, buffer);
    fs.renameSync(temporary, filePath);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function buildStoredAttachmentName(rawName, mimeType, buffer) {
  const base = path.basename(String(rawName ?? '').replace(/\\/g, '/')).trim();
  const rawExt = path.extname(base).toLowerCase();
  const validRawExt = /^\.[a-z0-9]{1,16}$/.test(rawExt);
  const ext = validRawExt ? rawExt : (EXT_BY_MIME[String(mimeType ?? '').toLowerCase()] || '');
  const stemSource = validRawExt ? base.slice(0, -rawExt.length) : base;
  let asciiStem = stemSource
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .replace(/\.{2,}/g, '.')
    .slice(0, 40);
  if (!asciiStem || WIN_RESERVED_RE.test(asciiStem)) {
    asciiStem = ext && IMAGE_MIME_BY_EXT[ext] ? 'image' : 'att';
  }
  const hash8 = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 8);
  const storedName = `${asciiStem}-${hash8}${ext}`;
  const rawDisplay = base ? (validRawExt ? base : `${base}${ext}`) : `paste${ext}`;
  return { name: cleanAttachmentLabel(rawDisplay, storedName), storedName };
}

function decodeAttachmentBuffer(entry) {
  if (!entry || typeof entry !== 'object') throw invalidAttachment('无效的附件数据。');
  if (Buffer.isBuffer(entry.buffer)) {
    if (!entry.buffer.byteLength) throw invalidAttachment('附件内容不能为空。');
    if (entry.buffer.byteLength > MAX_ATTACHMENT_BYTES) throw invalidAttachment('单个附件不能超过 10 MB。');
    return entry.buffer;
  }
  const raw = typeof entry.dataBase64 === 'string' ? entry.dataBase64.trim() : '';
  if (!raw) throw invalidAttachment('附件内容不能为空。');
  if (raw.length > MAX_BASE64_CHARS || raw.length % 4 !== 0 || !BASE64_RE.test(raw)) {
    throw invalidAttachment(raw.length > MAX_BASE64_CHARS ? '单个附件不能超过 10 MB。' : '无效的附件编码。');
  }
  const buffer = Buffer.from(raw, 'base64');
  if (!buffer.byteLength) throw invalidAttachment('附件内容不能为空。');
  if (buffer.byteLength > MAX_ATTACHMENT_BYTES) throw invalidAttachment('单个附件不能超过 10 MB。');
  return buffer;
}

function persistIncomingAttachments(attachmentsDir, incoming = []) {
  if (!incoming.length) return { saved: [], newlyCreated: [] };
  if (!Array.isArray(incoming) || incoming.length > MAX_ITEM_ATTACHMENTS) {
    throw invalidAttachment(`单条灵感最多添加 ${MAX_ITEM_ATTACHMENTS} 个附件。`);
  }
  const prepared = incoming.map((entry) => {
    const buffer = decodeAttachmentBuffer(entry);
    const { name, storedName } = buildStoredAttachmentName(entry.name, entry.mimeType, buffer);
    return { name, storedName, buffer };
  });
  fs.mkdirSync(attachmentsDir, { recursive: true });
  const newlyCreated = [];
  const saved = [];
  try {
    for (const { name, storedName, buffer } of prepared) {
      const target = path.join(attachmentsDir, storedName);
      if (!fs.existsSync(target)) {
        writeBufferAtomic(target, buffer);
        newlyCreated.push(target);
      }
      saved.push({ name, storedName });
    }
    return { saved, newlyCreated };
  } catch (error) {
    for (const created of newlyCreated) fs.rmSync(created, { force: true });
    throw error;
  }
}

function collectReferencedAttachments(content, sessionId, target = new Set()) {
  if (!content) return target;
  const pattern = /attachments\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([A-Za-z0-9._-]+)/gi;
  for (const match of content.matchAll(pattern)) {
    if (match[1].toLowerCase() === sessionId.toLowerCase() && isValidStoredName(match[2])) {
      target.add(match[2]);
    }
  }
  return target;
}

function removeEmptyDirectory(dir) {
  try { fs.rmdirSync(dir); }
  catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
}

function pruneUnreferencedAttachments(paths, sessionId, { content, archive, state }) {
  if (!fs.existsSync(paths.attachmentsDir)) return;
  const referenced = collectReferencedAttachments(content, sessionId);
  collectReferencedAttachments(archive, sessionId, referenced);
  for (const entry of Object.values(state.delivered ?? {})) {
    collectReferencedAttachments(entry?.text, sessionId, referenced);
  }
  const files = fs.readdirSync(paths.attachmentsDir);
  let remaining = 0;
  for (const name of files) {
    if (name.includes('.tmp-')) { remaining += 1; continue; }
    if (isValidStoredName(name) && !referenced.has(name)) {
      fs.rmSync(path.join(paths.attachmentsDir, name), { force: true });
    } else {
      remaining += 1;
    }
  }
  if (remaining === 0) {
    removeEmptyDirectory(paths.attachmentsDir);
    removeEmptyDirectory(path.dirname(paths.attachmentsDir));
  }
}

export function readAttachment({ rootDir, fonsDir, sessionId, storedName }) {
  const paths = sessionPaths({ rootDir, fonsDir, sessionId });
  if (!isValidStoredName(storedName)) throw invalidAttachment('无效的附件名称。');
  const target = path.join(paths.attachmentsDir, storedName);
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) return null;
  const buffer = fs.readFileSync(target);
  return {
    storedName,
    mimeType: mimeTypeForAttachment(storedName),
    size: buffer.byteLength,
    dataBase64: buffer.toString('base64'),
  };
}

function indexPath(appData, sessionId) {
  if (!isValidSessionId(sessionId)) throw new Error('无效的会话 ID。');
  return path.join(appData, 'fons', 'conversations', `${sessionId}.json`);
}

function publishConversation(filePath, entry) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(entry, null, 2), { encoding: 'utf8', flag: 'wx' });
    try { fs.linkSync(temporary, filePath); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return readJson(filePath);
}

function normalizeConversation(appData, entry) {
  const hasRoot = typeof entry.rootDir === 'string' && entry.rootDir;
  let scope = entry.scope;
  if (scope == null && hasRoot) scope = 'workspace';
  if (scope !== 'no-workspace' && !(scope === 'workspace' && hasRoot)) return null;
  const rootDir = scope === 'workspace' ? entry.rootDir : null;
  return {
    scope,
    rootDir,
    fonsDir: rootDir ? path.join(rootDir, '.agents', 'fons') : noWorkspaceFonsDir(appData),
    title: entry.title ?? '',
    registeredAt: entry.registeredAt,
    host: entry.host ?? 'antigravity',
    transcriptPath: entry.transcriptPath ?? null,
    endedAt: typeof entry.endedAt === 'number' ? entry.endedAt : null,
  };
}

function normalizeTitle(title) {
  return Array.from(String(title ?? '').replace(/[\r\n\u2028\u2029]/g, '')).slice(0, 20).join('');
}

export function registerConversation({
  appData, sessionId, rootDir = null, scope = rootDir ? 'workspace' : 'no-workspace', title, host, transcriptPath,
}) {
  if (scope !== 'workspace' && scope !== 'no-workspace') throw new Error('无效的会话作用域。');
  if (scope === 'workspace' && (typeof rootDir !== 'string' || !rootDir)) throw new Error('缺少有效的工作区目录。');
  const filePath = indexPath(appData, sessionId);
  if (fs.existsSync(filePath)) return readJson(filePath);
  const entry = { scope, rootDir: scope === 'workspace' ? rootDir : null, title: normalizeTitle(title), registeredAt: Date.now() };
  if (host !== undefined) entry.host = host;
  if (transcriptPath !== undefined) entry.transcriptPath = transcriptPath;
  return publishConversation(filePath, entry);
}

function mergeConversation(entry, changed) {
  const next = { ...entry };
  for (const [key, value] of Object.entries(changed)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next;
}

function updateConversation({ appData, sessionId }, change) {
  const filePath = indexPath(appData, sessionId);
  if (!fs.existsSync(filePath) || !change(readJson(filePath))) return;
  withPoolWrite({ fonsDir: path.dirname(filePath), sessionId }, () => {
    const entry = readJson(filePath);
    const changed = change(entry);
    if (!changed) return;
    writeJsonAtomic(filePath, mergeConversation(entry, changed));
  });
}

export function backfillConversationTitle({ appData, sessionId, title, transcriptPath }) {
  const cleanTitle = normalizeTitle(title);
  if (!cleanTitle.trim()) return;
  updateConversation({ appData, sessionId }, (entry) => {
    if (!entry.scope || (typeof entry.title === 'string' && entry.title.trim())) return null;
    if (transcriptPath !== undefined && entry.transcriptPath !== transcriptPath) return null;
    return { title: cleanTitle };
  });
}

export function bindConversationTranscript({
  appData, sessionId, transcriptPath, expectedTranscriptPath = null, host = 'codex',
}) {
  updateConversation({ appData, sessionId }, (entry) => {
    if (entry.host !== host || (entry.transcriptPath ?? null) !== expectedTranscriptPath) return null;
    return { transcriptPath };
  });
}

export function markConversationLifecycle({ appData, sessionId, host, endedAt }) {
  const nextEndedAt = typeof endedAt === 'number' ? endedAt : null;
  updateConversation({ appData, sessionId }, (entry) => {
    if (host && entry.host !== host) return null;
    const currentEndedAt = typeof entry.endedAt === 'number' ? entry.endedAt : null;
    if (currentEndedAt === nextEndedAt) return null;
    return { endedAt: nextEndedAt ?? undefined };
  });
}

export function lookupConversation({ appData, sessionId }) {
  const filePath = indexPath(appData, sessionId);
  if (!fs.existsSync(filePath)) return null;
  return normalizeConversation(appData, readJson(filePath));
}

export function listConversations({ appData, rootDir, scope = 'workspace' }) {
  const directory = path.join(appData, 'fons', 'conversations');
  if (!fs.existsSync(directory)) return [];
  const workspace = scope === 'workspace' ? workspacePathKey(rootDir) : null;
  return fs.readdirSync(directory).filter((name) => name.endsWith('.json'))
    .map((name) => ({ name, sessionId: name.slice(0, -5) }))
    .filter(({ sessionId }) => isValidSessionId(sessionId))
    .map(({ name, sessionId }) => {
      const entry = normalizeConversation(appData, readJson(path.join(directory, name)));
      return entry ? { sessionId, ...entry } : null;
    })
    .filter((entry) => {
      if (!entry || entry.scope !== scope) return false;
      return scope === 'no-workspace' || workspacePathKey(entry.rootDir) === workspace;
    });
}

function detectEol(content) { return content.includes('\r\n') ? '\r\n' : '\n'; }

function appendLinesWithNewline(filePath, lines) {
  const existing = readContent(filePath);
  const eol = detectEol(existing);
  const prefix = existing && !existing.endsWith('\n') ? eol : '';
  fs.appendFileSync(filePath, prefix + lines.join(eol) + eol, 'utf8');
}

function acknowledgmentTime(ack) {
  if (ack === true) return 0;
  return ack?.at;
}

function itemStatus(row, id, state, ui) {
  if (row.completed) return { status: 'done', doneSource: 'receipt' };
  if (isCompletedLine(row.body)) return { status: 'done', doneSource: 'inline' };
  const at = acknowledgmentTime(state.acknowledged?.[id]);
  const withdrawnAt = ui.retracted?.[id]?.ts ?? -1;
  const reopenedAt = Math.max(ui.reopened?.[id] ?? -1, withdrawnAt);
  if (typeof at === 'number' && at > reopenedAt) return { status: 'done', doneSource: 'readonly_ack' };
  const delivery = state.delivered?.[id];
  if (delivery && (delivery.deliveredAt ?? 0) > reopenedAt) return { status: 'delivered', doneSource: null };
  return { status: 'buffering', doneSource: null };
}

function enrichAttachments(parsed, attachmentsDir) {
  if (!parsed.length) return [];
  return parsed.map((att) => {
    const stat = fs.statSync(path.join(attachmentsDir, att.storedName), { throwIfNoEntry: false });
    const exists = Boolean(stat?.isFile());
    return {
      ...att,
      size: exists ? stat.size : 0,
      isImage: isImageStoredName(att.storedName),
      missing: !exists,
    };
  });
}

function makeItems(content, archive, state, ui, sessionId, attachmentsDir) {
  const rows = parseInbox(content).rows;
  const active = new Map(parseActiveItems(content, archive).map((item) => [item.text, item.id]));
  const items = [];
  for (const [rowIndex, row] of rows.entries()) {
    if (row.receipt || !row.body.trim() || row.body.trimStart().startsWith('#')) continue;
    const text = row.text || (isCompletedLine(row.body) ? completedText(row.body) : '');
    if (!text) continue;
    const id = active.get(text) ?? deliveryId(text, 0);
    const { note, attachments: parsed } = splitIdeaText(text, sessionId);
    const attachments = enrichAttachments(parsed, attachmentsDir);
    items.push({ id, token: row.token, rowIndex, raw: row.raw, text, note, attachments, ...itemStatus(row, id, state, ui) });
  }
  return { rows, items };
}

function fileEtag(filePath) {
  try { const stat = fs.statSync(filePath); return `${stat.mtimeMs}:${stat.size}`; }
  catch (error) { if (error.code === 'ENOENT') return '-'; throw error; }
}

export function readPoolData({ rootDir, fonsDir, sessionId }) {
  const paths = sessionPaths({ rootDir, fonsDir, sessionId });
  const baseEtag = [paths.ideas, paths.state, paths.ui, paths.archive].map(fileEtag).join('|');
  // Withdrawal metadata is published after deletion. Read it first so it can't revive a stale row.
  const ui = readJson(paths.ui);
  const content = readContent(paths.ideas);
  const archive = readContent(paths.archive);
  const state = readJson(paths.state);
  const { rows, items } = makeItems(content, archive, state, ui, sessionId, paths.attachmentsDir);
  const attTag = items.flatMap((item) => item.attachments.map((att) => `${att.storedName}:${att.missing ? 'x' : att.size}`)).join(',');
  const etag = attTag ? `${baseEtag}|att:${attTag}` : baseEtag;
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(paths.ideas).mtimeMs; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { paths, content, archive, state, ui, rows, items, etag, mtimeMs };
}

const HOLD_LEASE_MS = 15000;

export function resolveDebounceMs(appData = null) {
  return resolveConfiguredDebounceMs({ appData });
}

function resolveItemSince(id, state, ui, mtimeMs) {
  const limit = mtimeMs + 1000;
  const uiAt = ui.timers?.[id]?.since;
  if (typeof uiAt === 'number' && uiAt <= limit) return uiAt;
  const stateAt = state.pendingAt?.[id];
  if (typeof stateAt === 'number' && stateAt <= limit) return stateAt;
  return mtimeMs;
}

function itemHoldStatus(timer, since, now) {
  if (!timer) return { editingHold: false, pausedMs: 0 };
  let pausedMs = Math.max(0, timer.pausedMs || 0);
  const active = typeof timer.holdSince === 'number' && typeof timer.holdUntil === 'number' && timer.holdUntil > timer.holdSince;
  if (active) {
    pausedMs += Math.max(0, Math.min(now, timer.holdUntil) - Math.max(timer.holdSince, since));
  }
  return { editingHold: active && now < timer.holdUntil, pausedMs };
}

function evaluatePendingItem(item, { state, ui, mtimeMs, debounceMs, now, editingHoldPolicy }) {
  const since = resolveItemSince(item.id, state, ui, mtimeMs);
  const timer = ui.timers?.[item.id];
  const respectsHold = debounceMs > 0 || editingHoldPolicy === 'always';
  const hold = respectsHold ? itemHoldStatus(timer, since, now) : { editingHold: false, pausedMs: 0 };
  const elapsedMs = Math.max(0, now - since - hold.pausedMs);
  const remainingMs = debounceMs > 0 ? Math.max(0, debounceMs - elapsedMs) : 0;
  return { since, remainingMs, editingHold: hold.editingHold, pausedMs: hold.pausedMs };
}

export function computeDebounce({
  items, state, ui, mtimeMs, appData = null, debounceMs = resolveDebounceMs(appData), now = Date.now(), editingHoldPolicy,
}) {
  const uniqueItems = new Map();
  for (const item of items) {
    if (item.status === 'buffering' && !uniqueItems.has(item.text)) uniqueItems.set(item.text, item);
  }
  const byId = new Map();
  const ready = [];
  const pendingAt = {};
  for (const item of uniqueItems.values()) {
    const info = evaluatePendingItem(item, { state, ui, mtimeMs, debounceMs, now, editingHoldPolicy });
    pendingAt[item.id] = info.since;
    byId.set(item.id, info);
    if (info.remainingMs <= 0 && !info.editingHold) ready.push(item);
  }
  return { pending: [...uniqueItems.values()], ready, byId, pendingAt, debounceMs };
}

function nextItemTimer(item, freshSet, data, now) {
  if (freshSet.has(item.text)) return { since: now, pausedMs: 0, holdSince: null, holdUntil: 0 };
  const current = data.ui.timers?.[item.id];
  if (current && typeof current.since === 'number') return current;
  const since = resolveItemSince(item.id, data.state, data.ui, data.mtimeMs || now);
  return { since, pausedMs: 0, holdSince: null, holdUntil: 0 };
}

export function stampPoolTimers(context) {
  const { ideas, ui } = sessionPaths(context);
  if (!fs.existsSync(ideas) && !fs.existsSync(ui)) return;
  stampExistingPoolTimers(context);
}

const stampExistingPoolTimers = poolWriter(({ rootDir, fonsDir, sessionId, freshTexts = [], now = Date.now() }) => {
  const data = readPoolData({ rootDir, fonsDir, sessionId });
  const buffering = data.items.filter((item) => item.status === 'buffering');
  const previous = JSON.stringify(data.ui.timers ?? null);
  if (!buffering.length && !data.ui.timers) return;
  const freshSet = new Set(freshTexts);
  const nextTimers = {};
  for (const item of buffering) {
    nextTimers[item.id] = nextItemTimer(item, freshSet, data, now);
  }
  if (Object.keys(nextTimers).length) data.ui.timers = nextTimers;
  else delete data.ui.timers;
  if (JSON.stringify(data.ui.timers ?? null) !== previous) {
    writeJsonAtomic(data.paths.ui, data.ui);
  }
});

export function readPoolSnapshot({
  rootDir, fonsDir, sessionId, appData = null, debounceMs = resolveDebounceMs(appData), now = Date.now(),
}) {
  const data = readPoolData({ rootDir, fonsDir, sessionId });
  const timing = computeDebounce({ ...data, debounceMs, now });
  const items = data.items.map((item) => {
    const info = item.status === 'buffering' ? timing.byId.get(item.id) : null;
    return { ...item, remainingMs: info ? info.remainingMs : 0, editingHold: Boolean(info?.editingHold) };
  });
  const heldIds = [...timing.byId.entries()].filter(([, info]) => info.editingHold).map(([id]) => id).sort().join(',');
  const baseTag = `${data.etag}|db:${timing.debounceMs}`;
  const etag = heldIds ? `${baseTag}|hold:${heldIds}` : baseTag;
  return {
    items, debounceMs: timing.debounceMs,
    canArchive: items.some((item) => item.status === 'done'), etag,
  };
}

export const addIdeas = poolWriter(({ rootDir, fonsDir, sessionId, texts = [], attachments = [] }) => {
  const paths = sessionPaths({ rootDir, fonsDir, sessionId });
  const clean = texts
    .map((text) => String(text).replace(/[\r\n]+/g, ' ').trim().replace(/^[-*]\s*\[\s*\]\s*/, '').trim())
    .filter(Boolean);
  if (!attachments?.length) {
    if (!clean.length) return { count: 0, texts: [] };
    appendLinesWithNewline(paths.ideas, clean.map((text) => `- [ ] ${text}`));
    return { count: clean.length, texts: clean };
  }
  const { saved, newlyCreated } = persistIncomingAttachments(paths.attachmentsDir, attachments);
  const composed = clean.length
    ? [composeIdeaText(clean[0], saved, sessionId), ...clean.slice(1)]
    : [composeIdeaText('', saved, sessionId)];
  try {
    appendLinesWithNewline(paths.ideas, composed.map((text) => `- [ ] ${text}`));
  } catch (error) {
    for (const created of newlyCreated) fs.rmSync(created, { force: true });
    throw error;
  }
  return { count: composed.length, texts: composed };
});

export const completeIdea = poolWriter(({ rootDir, fonsDir, sessionId, token, tokens = [token] }) => {
  if (!tokens.length) throw new Error('请先运行 fons list，再指定已处理条目的令牌。');
  if (new Set(tokens).size !== tokens.length) throw new Error('确认令牌重复。');
  const data = readPoolData({ rootDir, fonsDir, sessionId });
  const available = new Map(data.items.filter((row) => row.status !== 'done').map((row) => [row.token, row]));
  const selected = tokens.map((value) => available.get(value));
  if (selected.some((row) => !row)) {
    throw Object.assign(new Error('确认令牌无效或条目已变化，请重新运行 fons list。'), { code: 'FONS_STALE_TOKEN' });
  }
  const eol = detectEol(data.content);
  const receipts = selected.map((row) => `${COMPLETED_PREFIX}${row.text} <!-- fons-ack:${row.token} -->`);
  // A concurrent editor can append an unterminated line after the snapshot.
  fs.appendFileSync(data.paths.ideas, eol + receipts.join(eol) + eol, 'utf8');
  return { count: selected.length };
});

// The caller holds the inbox lock from reading the delivery ledger through publishing it.
export function completeAcknowledgedIdeas(data, ids) {
  const file = data.paths.ideas;
  const replacements = new Map();
  for (const { id, status, rowIndex, text } of data.items) {
    if (status !== 'delivered' || !ids.has(id)) continue;
    const row = data.rows[rowIndex];
    replacements.set(rowIndex, COMPLETED_PREFIX + text + row.raw.slice(row.body.length));
  }
  try {
    writeContentsAtomic(file, foldedRows(data, replacements), {
      mode: writableFileMode(file), expected: data.content,
    });
  } catch (error) {
    if (['EACCES', 'EPERM', 'EROFS'].includes(error.code)) return false;
    throw error;
  }
  return true;
}

function writableFileMode(filePath) {
  // Replacing a file atomically can succeed on POSIX even when the original is read-only.
  const fd = fs.openSync(filePath, 'r+');
  try { return fs.fstatSync(fd).mode & 0o777; }
  finally { fs.closeSync(fd); }
}

function checkItem(data, rowIndex, expectedRaw) {
  if (data.rows[rowIndex]?.raw !== expectedRaw) return null;
  return data.items.find((item) => item.rowIndex === rowIndex) ?? null;
}

function foldedRows(data, replacements) {
  return data.rows.map((row, index) => {
    if (replacements.has(index)) return replacements.get(index);
    if (row.receipt) return '';
    if (row.completed) return `${COMPLETED_PREFIX}${row.text}${row.raw.slice(row.body.length)}`;
    return row.raw;
  }).join('');
}

function replaceIdea(data, item, next) {
  if (readContent(data.paths.ideas) !== data.content) return { conflict: true };
  if (item.status === 'done') {
    if (item.doneSource === 'readonly_ack') writableFileMode(data.paths.ideas);
    invalidateCompletion(data, item);
  }
  fs.writeFileSync(data.paths.ideas, next, 'utf8');
  return { conflict: false };
}

function resolveKeptAttachments(item, keepAttachments) {
  const existing = new Map(item.attachments.map((att) => [att.storedName, { name: att.name, storedName: att.storedName }]));
  if (keepAttachments === undefined) return [...existing.values()];
  if (!Array.isArray(keepAttachments)) throw invalidAttachment('无效的保留附件列表。');
  const seen = new Set();
  const kept = [];
  for (const storedName of keepAttachments) {
    if (!existing.has(storedName)) throw invalidAttachment('包含不属于当前灵感的附件引用。');
    if (seen.has(storedName)) continue;
    seen.add(storedName);
    kept.push(existing.get(storedName));
  }
  return kept;
}

export const updateIdeaText = poolWriter(({
  rootDir, fonsDir, sessionId, rowIndex, expectedRaw, newText, keepAttachments, newAttachments = [],
}) => {
  const data = readPoolData({ rootDir, fonsDir, sessionId });
  const item = checkItem(data, rowIndex, expectedRaw);
  if (!item) return { conflict: true };
  if (item.status !== 'buffering') return { conflict: true, locked: true };
  const kept = resolveKeptAttachments(item, keepAttachments);
  const incomingCount = Array.isArray(newAttachments) ? newAttachments.length : 0;
  if (kept.length + incomingCount > MAX_ITEM_ATTACHMENTS) {
    throw invalidAttachment(`单条灵感最多添加 ${MAX_ITEM_ATTACHMENTS} 个附件。`);
  }
  const cleanNote = String(newText ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (!cleanNote && !kept.length && !incomingCount) throw new Error('灵感内容不能为空。');
  const { saved } = persistIncomingAttachments(data.paths.attachmentsDir, newAttachments);
  const composed = composeIdeaText(cleanNote, [...kept, ...saved], sessionId);
  const eol = data.rows[rowIndex].raw.slice(data.rows[rowIndex].body.length);
  const next = foldedRows(data, new Map([[rowIndex, `- [ ] ${composed}${eol}`]]));
  const result = replaceIdea(data, item, next);
  if (result.conflict) {
    pruneUnreferencedAttachments(data.paths, sessionId, {
      content: readContent(data.paths.ideas), archive: data.archive, state: data.state,
    });
    return result;
  }
  pruneUnreferencedAttachments(data.paths, sessionId, { content: next, archive: data.archive, state: data.state });
  return { conflict: false, updatedText: composed };
});

function restoreRetraction(data, item, published, previous) {
  const current = readJson(data.paths.ui);
  const entry = current.retracted?.[item.id];
  if (entry?.ts !== published.ts || entry?.text !== published.text) return;
  if (previous === undefined) delete current.retracted[item.id];
  else current.retracted[item.id] = previous;
  writeJsonAtomic(data.paths.ui, current);
}

function nextWithdrawalTime({ state, ui }, id) {
  const lastDelivery = state.delivered[id].deliveredAt ?? 0;
  const lastWithdrawal = ui.retracted?.[id]?.ts ?? 0;
  const lastNotice = state.retractNotified?.[id] ?? 0;
  return Math.max(Date.now(), lastDelivery, Math.max(lastWithdrawal, lastNotice) + 1);
}

function publishRetraction(data, item, nextContent) {
  const previous = data.ui.retracted?.[item.id];
  const published = { text: item.text, ts: nextWithdrawalTime(data, item.id) };
  data.ui.retracted ??= {};
  data.ui.retracted[item.id] = published;
  let uiPublished = false;
  try {
    writeJsonAtomic(data.paths.ui, data.ui);
    uiPublished = true;
    fs.writeFileSync(data.paths.retractMarker, '', 'utf8');
  } catch (error) {
    try {
      if (readContent(data.paths.ideas) === nextContent) {
        fs.writeFileSync(data.paths.ideas, data.content, 'utf8');
        if (uiPublished) restoreRetraction(data, item, published, previous);
      }
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], '撤回发布及回滚均失败。');
    }
    throw error;
  }
}

export const removeIdea = poolWriter(({ rootDir, fonsDir, sessionId, rowIndex, expectedRaw }) => {
  const data = readPoolData({ rootDir, fonsDir, sessionId });
  const item = checkItem(data, rowIndex, expectedRaw);
  if (!item) return { conflict: true };
  const nextContent = foldedRows(data, new Map([[rowIndex, '']]));
  const result = replaceIdea(data, item, nextContent);
  if (result.conflict) return result;
  if (item.status === 'delivered') {
    publishRetraction(data, item, nextContent);
    return result;
  }
  pruneUnreferencedAttachments(data.paths, sessionId, { content: nextContent, archive: data.archive, state: data.state });
  return result;
});

function invalidateCompletion({ paths, state, ui, rows, archive }, item) {
  // Inline completion can outlive the ledger write, leaving its old delivery behind.
  const id = item.doneSource === 'readonly_ack' ? item.id : deliveryIdAfterRemovingCompletion(item.text, rows, archive);
  const delivery = state.delivered?.[id];
  const at = acknowledgmentTime(state.acknowledged?.[id]);
  if (!delivery && at === undefined) return;
  ui.reopened ??= {};
  ui.reopened[id] = Math.max(Date.now(), ui.reopened[id] ?? 0, delivery?.deliveredAt ?? 0, at ?? 0);
  writeJsonAtomic(paths.ui, ui);
}

export const reopenIdea = poolWriter(({ rootDir, fonsDir, sessionId, rowIndex, expectedRaw }) => {
  const data = readPoolData({ rootDir, fonsDir, sessionId });
  const item = checkItem(data, rowIndex, expectedRaw);
  if (!item) return { conflict: true };
  if (item.status !== 'done') return { conflict: false };
  if (item.doneSource === 'readonly_ack') {
    if (readContent(data.paths.ideas) !== data.content) return { conflict: true };
    invalidateCompletion(data, item);
    return { conflict: false };
  }
  const row = data.rows[rowIndex];
  const pending = `- [ ] ${item.text}${row.raw.slice(row.body.length)}`;
  const next = foldedRows(data, new Map([[rowIndex, pending]]));
  const result = replaceIdea(data, item, next);
  if (!result.conflict) return { conflict: false, reopenedText: item.text };
  return result;
});

export const holdEditing = poolWriter(({ rootDir, fonsDir, sessionId, id, now = Date.now() }) => {
  const data = readPoolData({ rootDir, fonsDir, sessionId });
  const target = data.items.find((item) => item.id === id && item.status === 'buffering');
  if (!target) {
    if (data.ui.timers?.[id]) {
      delete data.ui.timers[id];
      if (!Object.keys(data.ui.timers).length) delete data.ui.timers;
      writeJsonAtomic(data.paths.ui, data.ui);
    }
    return { editingHold: false };
  }
  const since = resolveItemSince(id, data.state, data.ui, data.mtimeMs || now);
  const status = itemHoldStatus(data.ui.timers?.[id], since, now);
  const holdSince = status.editingHold ? data.ui.timers[id].holdSince : now;
  const pausedMs = status.editingHold ? Math.max(0, data.ui.timers[id].pausedMs || 0) : status.pausedMs;
  data.ui.timers ??= {};
  data.ui.timers[id] = { since, pausedMs, holdSince, holdUntil: now + HOLD_LEASE_MS };
  writeJsonAtomic(data.paths.ui, data.ui);
  return { editingHold: true, id, until: data.ui.timers[id].holdUntil };
});

export const releaseEditing = poolWriter(({ rootDir, fonsDir, sessionId, id, now = Date.now() }) => {
  const data = readPoolData({ rootDir, fonsDir, sessionId });
  const current = data.ui.timers?.[id];
  if (!current) return { editingHold: false };
  const target = data.items.find((item) => item.id === id && item.status === 'buffering');
  if (!target) {
    delete data.ui.timers[id];
    if (!Object.keys(data.ui.timers).length) delete data.ui.timers;
    writeJsonAtomic(data.paths.ui, data.ui);
    return { editingHold: false };
  }
  const since = resolveItemSince(id, data.state, data.ui, data.mtimeMs || now);
  const status = itemHoldStatus(current, since, now);
  data.ui.timers[id] = { since, pausedMs: status.pausedMs, holdSince: null, holdUntil: 0 };
  writeJsonAtomic(data.paths.ui, data.ui);
  return { editingHold: false, id };
});

function formatArchivedInlineRow(body, sessionId) {
  const extracted = completedText(body);
  if (!extracted || !splitIdeaText(extracted, sessionId).attachments.length) return body;
  const prefixMatch = /^\s*(?:(?:[-*]\s*)?(?:\[\s*[√✓✔]\s*\]|【\s*[√✓✔]\s*】|[√✓✔])|[-*]\s*\[\s*[xX]\s*\])\s*/.exec(body);
  const prefix = prefixMatch ? prefixMatch[0] : COMPLETED_PREFIX;
  return `${prefix}${formatArchivedIdeaText(extracted, sessionId)}`;
}

function archiveRows(rows, doneByIndex = new Map(), sessionId) {
  const done = [];
  const kept = [];
  for (const [index, row] of rows.entries()) {
    if (row.completed) done.push(`${COMPLETED_PREFIX}${formatArchivedIdeaText(row.text, sessionId)}`);
    else if (row.receipt) continue;
    else if (isCompletedLine(row.body) && !row.body.includes('<!-- fons-ack:')) done.push(formatArchivedInlineRow(row.body, sessionId));
    else if (doneByIndex.has(index)) done.push(`${COMPLETED_PREFIX}${formatArchivedIdeaText(doneByIndex.get(index), sessionId)}`);
    else kept.push(row.raw);
  }
  while (kept.length && !kept.at(-1).trim()) kept.pop();
  return { done, kept: kept.join('') };
}

export const archiveCompleted = poolWriter((context) => {
  const { content, rows, items, paths } = readPoolData(context);
  const acknowledged = new Map(items.filter((row) => row.doneSource === 'readonly_ack').map((row) => [row.rowIndex, row.text]));
  const { done, kept } = archiveRows(rows, acknowledged, context.sessionId);
  if (!done.length) return { count: 0 };
  if (readContent(paths.ideas) !== content) throw new Error('收件箱已变化，请停止编辑后重试归档。');
  fs.mkdirSync(path.dirname(paths.archive), { recursive: true });
  appendLinesWithNewline(paths.archive, done);
  if (readContent(paths.ideas) !== content) throw new Error('归档已写入，但收件箱已变化。请先核对归档，再重试。');
  if (kept.trim()) fs.writeFileSync(paths.ideas, kept, 'utf8');
  else fs.unlinkSync(paths.ideas);
  return { count: done.length };
});
