import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  COMPLETED_PREFIX, isCompletedLine, parseInbox, parseActiveItems, completedText,
  deliveryId, deliveryIdAfterRemovingCompletion,
} from './fons-inbox.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const lockWait = new Int32Array(new SharedArrayBuffer(4));

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

export function withPoolWrite(context, write) {
  const { fonsDir } = sessionPaths(context);
  const lock = path.join(fonsDir, `.inbox-${context.sessionId}.lock`);
  fs.mkdirSync(fonsDir, { recursive: true });
  const staged = fs.mkdtempSync(lock + '-');
  const owner = `${process.pid}-${staged.slice(lock.length + 1)}`;
  let held = staged;
  let ownerCreated = false;
  try {
    // Publish the owner together with the directory so readers never see a half-acquired lock.
    fs.mkdirSync(path.join(staged, owner));
    ownerCreated = true;
    claimInboxLock(staged, lock);
    held = lock;
    return write();
  } finally {
    releaseInboxLock(held, ownerCreated ? owner : undefined);
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

export function readContent(filePath) {
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
  const scope = entry.scope ?? (typeof entry.rootDir === 'string' && entry.rootDir ? 'workspace' : null);
  if (scope === 'no-workspace') {
    return {
      scope: 'no-workspace',
      rootDir: null,
      fonsDir: noWorkspaceFonsDir(appData),
      title: entry.title ?? '',
      registeredAt: entry.registeredAt,
    };
  }
  if (scope === 'workspace' && typeof entry.rootDir === 'string' && entry.rootDir) {
    return {
      scope: 'workspace',
      rootDir: entry.rootDir,
      fonsDir: path.join(entry.rootDir, '.agents', 'fons'),
      title: entry.title ?? '',
      registeredAt: entry.registeredAt,
    };
  }
  return null;
}

export function registerConversation({ appData, sessionId, rootDir = null, scope = rootDir ? 'workspace' : 'no-workspace', title }) {
  if (scope !== 'workspace' && scope !== 'no-workspace') throw new Error('无效的会话作用域。');
  if (scope === 'workspace' && (typeof rootDir !== 'string' || !rootDir)) throw new Error('缺少有效的工作区目录。');
  const filePath = indexPath(appData, sessionId);
  if (fs.existsSync(filePath)) return readJson(filePath);
  const cleanTitle = Array.from(String(title ?? '').replace(/[\r\n\u2028\u2029]/g, '')).slice(0, 20).join('');
  const entry = { scope, rootDir: scope === 'workspace' ? rootDir : null, title: cleanTitle, registeredAt: Date.now() };
  return publishConversation(filePath, entry);
}

export function lookupConversation({ appData, sessionId }) {
  const filePath = indexPath(appData, sessionId);
  if (!fs.existsSync(filePath)) return null;
  return normalizeConversation(appData, readJson(filePath));
}

function workspaceKey(rootDir) {
  const resolved = path.resolve(rootDir);
  if (process.platform === 'win32') return resolved.toLowerCase();
  return resolved;
}

export function listConversations({ appData, rootDir, scope = 'workspace' }) {
  const directory = path.join(appData, 'fons', 'conversations');
  if (!fs.existsSync(directory)) return [];
  const workspace = scope === 'workspace' ? workspaceKey(rootDir) : null;
  return fs.readdirSync(directory).filter((name) => name.endsWith('.json'))
    .map((name) => ({ name, sessionId: name.slice(0, -5) }))
    .filter(({ sessionId }) => isValidSessionId(sessionId))
    .map(({ name, sessionId }) => {
      const entry = normalizeConversation(appData, readJson(path.join(directory, name)));
      return entry ? { sessionId, ...entry } : null;
    })
    .filter((entry) => {
      if (!entry || entry.scope !== scope) return false;
      return scope === 'no-workspace' || workspaceKey(entry.rootDir) === workspace;
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

function makeItems(content, archive, state, ui) {
  const rows = parseInbox(content).rows;
  const active = new Map(parseActiveItems(content, archive).map((item) => [item.text, item.id]));
  const items = [];
  for (const [rowIndex, row] of rows.entries()) {
    if (row.receipt || !row.body.trim() || row.body.trimStart().startsWith('#')) continue;
    const text = row.text || (isCompletedLine(row.body) ? completedText(row.body) : '');
    if (!text) continue;
    const id = active.get(text) ?? deliveryId(text, 0);
    items.push({ id, token: row.token, rowIndex, raw: row.raw, text, ...itemStatus(row, id, state, ui) });
  }
  return { rows, items };
}

function fileEtag(filePath) {
  try { const stat = fs.statSync(filePath); return `${stat.mtimeMs}:${stat.size}`; }
  catch (error) { if (error.code === 'ENOENT') return '-'; throw error; }
}

export function readPoolData({ rootDir, fonsDir, sessionId }) {
  const paths = sessionPaths({ rootDir, fonsDir, sessionId });
  const etag = [paths.ideas, paths.state, paths.ui, paths.archive].map(fileEtag).join('|');
  // Withdrawal metadata is published after deletion. Read it first so it can't revive a stale row.
  const ui = readJson(paths.ui);
  const content = readContent(paths.ideas);
  const archive = readContent(paths.archive);
  const state = readJson(paths.state);
  const { rows, items } = makeItems(content, archive, state, ui);
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(paths.ideas).mtimeMs; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { paths, content, archive, state, ui, rows, items, etag, mtimeMs };
}

export const DEFAULT_DEBOUNCE_SEC = 45;
const HOLD_LEASE_MS = 15000;

export function resolveDebounceMs() {
  const raw = process.env.FONS_DEBOUNCE_SEC;
  if (raw === undefined || raw.trim() === '') return DEFAULT_DEBOUNCE_SEC * 1000;
  const seconds = Number(raw);
  return (Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_DEBOUNCE_SEC) * 1000;
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

function evaluatePendingItem(item, { state, ui, mtimeMs, debounceMs, now }) {
  const since = resolveItemSince(item.id, state, ui, mtimeMs);
  const timer = ui.timers?.[item.id];
  const hold = debounceMs > 0 ? itemHoldStatus(timer, since, now) : { editingHold: false, pausedMs: 0 };
  const elapsedMs = Math.max(0, now - since - hold.pausedMs);
  const remainingMs = debounceMs > 0 ? Math.max(0, debounceMs - elapsedMs) : 0;
  return { since, remainingMs, editingHold: hold.editingHold, pausedMs: hold.pausedMs };
}

export function computeDebounce({ items, state, ui, mtimeMs, debounceMs = resolveDebounceMs(), now = Date.now() }) {
  const uniqueItems = new Map();
  for (const item of items) {
    if (item.status === 'buffering' && !uniqueItems.has(item.text)) uniqueItems.set(item.text, item);
  }
  const byId = new Map();
  const ready = [];
  const pendingAt = {};
  for (const item of uniqueItems.values()) {
    const info = evaluatePendingItem(item, { state, ui, mtimeMs, debounceMs, now });
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

export function readPoolSnapshot({ rootDir, fonsDir, sessionId, debounceMs = resolveDebounceMs(), now = Date.now() }) {
  const data = readPoolData({ rootDir, fonsDir, sessionId });
  const timing = computeDebounce({ ...data, debounceMs, now });
  const items = data.items.map((item) => {
    const info = item.status === 'buffering' ? timing.byId.get(item.id) : null;
    return { ...item, remainingMs: info ? info.remainingMs : 0, editingHold: Boolean(info?.editingHold) };
  });
  const heldIds = [...timing.byId.entries()].filter(([, info]) => info.editingHold).map(([id]) => id).sort().join(',');
  const etag = heldIds ? `${data.etag}|hold:${heldIds}` : data.etag;
  return {
    items, debounceMs: timing.debounceMs,
    canArchive: items.some((item) => item.status === 'done'), etag,
  };
}

export const addIdeas = poolWriter(({ rootDir, fonsDir, sessionId, texts }) => {
  const paths = sessionPaths({ rootDir, fonsDir, sessionId });
  const clean = texts.map((text) => String(text).replace(/[\r\n]+/g, ' ').trim().replace(/^[-*]\s*\[\s*\]\s*/, '').trim()).filter(Boolean);
  if (!clean.length) return { count: 0, texts: [] };
  appendLinesWithNewline(paths.ideas, clean.map((text) => `- [ ] ${text}`));
  return { count: clean.length, texts: clean };
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

export const updateIdeaText = poolWriter(({ rootDir, fonsDir, sessionId, rowIndex, expectedRaw, newText }) => {
  const data = readPoolData({ rootDir, fonsDir, sessionId });
  const item = checkItem(data, rowIndex, expectedRaw);
  if (!item) return { conflict: true };
  if (item.status !== 'buffering') return { conflict: true, locked: true };
  const text = String(newText).replace(/[\r\n]+/g, ' ').trim();
  if (!text) throw new Error('灵感内容不能为空。');
  const eol = data.rows[rowIndex].raw.slice(data.rows[rowIndex].body.length);
  const next = foldedRows(data, new Map([[rowIndex, `- [ ] ${text}${eol}`]]));
  const result = replaceIdea(data, item, next);
  if (!result.conflict) return { conflict: false, updatedText: text };
  return result;
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
  if (result.conflict || item.status !== 'delivered') return result;
  publishRetraction(data, item, nextContent);
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

function archiveRows(rows, doneByIndex = new Map()) {
  const done = [];
  const kept = [];
  for (const [index, row] of rows.entries()) {
    if (row.completed) done.push(`${COMPLETED_PREFIX}${row.text}`);
    else if (row.receipt) continue;
    else if (isCompletedLine(row.body) && !row.body.includes('<!-- fons-ack:')) done.push(row.body);
    else if (doneByIndex.has(index)) done.push(`${COMPLETED_PREFIX}${doneByIndex.get(index)}`);
    else kept.push(row.raw);
  }
  while (kept.length && !kept.at(-1).trim()) kept.pop();
  return { done, kept: kept.join('') };
}

export const archiveCompleted = poolWriter((context) => {
  const { content, rows, items, paths } = readPoolData(context);
  const acknowledged = new Map(items.filter((row) => row.doneSource === 'readonly_ack').map((row) => [row.rowIndex, row.text]));
  const { done, kept } = archiveRows(rows, acknowledged);
  if (!done.length) return { count: 0 };
  if (readContent(paths.ideas) !== content) throw new Error('收件箱已变化，请停止编辑后重试归档。');
  fs.mkdirSync(path.dirname(paths.archive), { recursive: true });
  appendLinesWithNewline(paths.archive, done);
  if (readContent(paths.ideas) !== content) throw new Error('归档已写入，但收件箱已变化。请先核对归档，再重试。');
  if (kept.trim()) fs.writeFileSync(paths.ideas, kept, 'utf8');
  else fs.unlinkSync(paths.ideas);
  return { count: done.length };
});

function migrationOwners(state, id, fallback) {
  const owners = Object.entries(state).filter(([, bucket]) => bucket?.delivered?.[id]).map(([id]) => id);
  return owners.length ? owners : [fallback];
}

function nextCompletionCount(counts, text) {
  const count = counts.get(text) ?? 0;
  counts.set(text, count + 1);
  return count;
}

function archiveCompletionCounts(archive) {
  const counts = new Map();
  for (const line of archive.split(/\r?\n/)) {
    const text = completedText(line);
    if (text) nextCompletionCount(counts, text);
  }
  return counts;
}

function completedMigrationEntry(row, text, counts) {
  const id = deliveryId(text, nextCompletionCount(counts, text));
  let raw = row.raw;
  if (row.completed) raw = COMPLETED_PREFIX + text + row.raw.slice(row.body.length);
  return { raw, text, id, completed: true };
}

function migrationEntry(row, counts, active) {
  if (row.receipt) return null;
  const text = row.completed ? row.text : completedText(row.body);
  if (text) return completedMigrationEntry(row, text, counts);
  if (row.text) return { raw: row.raw, text: row.text, id: active.get(row.text) };
  return { raw: row.raw };
}

function migrationRows(content, archive, state, sessionId) {
  const counts = archiveCompletionCounts(archive);
  const active = new Map(parseActiveItems(content, archive).map(({ text, id }) => [text, id]));
  const targets = new Map();
  for (const row of parseInbox(content).rows) {
    const entry = migrationEntry(row, counts, active);
    if (!entry) continue;
    const owners = entry.id ? migrationOwners(state, entry.id, sessionId) : [sessionId];
    for (const owner of owners) {
      if (!targets.has(owner)) targets.set(owner, []);
      targets.get(owner).push(entry);
    }
  }
  return targets;
}

function migrationContent(entries) {
  let content = '';
  for (const entry of entries) {
    if (content && !content.endsWith('\n')) content += '\n';
    content += entry.raw;
  }
  return content;
}

function migrationIdMapping(entries) {
  const counts = new Map();
  const mapping = new Map();
  for (const entry of entries) {
    if (entry.completed) mapping.set(entry.id, deliveryId(entry.text, nextCompletionCount(counts, entry.text)));
  }
  for (const entry of entries) {
    if (entry.text && !entry.completed) mapping.set(entry.id, deliveryId(entry.text, counts.get(entry.text) ?? 0));
  }
  return mapping;
}

function migrationLedger(bucket, mapping, field) {
  const result = {};
  for (const [oldId, newId] of mapping) {
    if (bucket?.[field]?.[oldId]) result[newId] = bucket[field][oldId];
  }
  return result;
}

function migrationOutput(entries, bucket) {
  const mapping = migrationIdMapping(entries);
  const rest = { ...bucket };
  delete rest.pendingSig;
  delete rest.pendingSigAt;
  return {
    content: migrationContent(entries),
    state: {
      ...rest,
      delivered: migrationLedger(bucket, mapping, 'delivered'),
      acknowledged: migrationLedger(bucket, mapping, 'acknowledged'),
      lastStopSig: '',
      stopCount: 0,
    },
  };
}
function migrationLegacyPaths(fonsDir) {
  return {
    ideas: path.join(fonsDir, 'ideas.md'),
    claimed: path.join(fonsDir, 'ideas.migrating-' + process.pid + '.md'),
    state: path.join(fonsDir, '.state.json'),
    stateBackup: path.join(fonsDir, '.state.legacy.json'),
    archive: path.join(fonsDir, 'archive.md'),
    archiveBackup: path.join(fonsDir, 'archive', 'legacy.md'),
  };
}

function migrationCheckState(state) {
  for (const [id, bucket] of Object.entries(state)) {
    if (!isValidSessionId(id) && Object.keys(bucket?.delivered ?? {}).length) {
      throw new Error('旧账本含无效会话 ID，无法安全迁移，请保留旧文件并检查账本。');
    }
  }
}

function migrationWrite(file, content, created) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'wx');
  created.push({ file, content });
  try { fs.writeFileSync(fd, content, 'utf8'); } finally { fs.closeSync(fd); }
}

function migrationWriteJson(file, value, created) {
  const content = JSON.stringify(value, null, 2);
  const staging = path.join(path.dirname(file), '.migration.lock', 'state-staging.json');
  try {
    writeJsonAtomic(staging, value);
    fs.linkSync(staging, file);
    created.push({ file, content });
  } finally {
    if (fs.existsSync(staging)) fs.unlinkSync(staging);
  }
}

function migrationMove(source, target, moved) {
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.linkSync(source, target);
  moved.push({ source, target });
  fs.unlinkSync(source);
}


function migrationRollback({ legacy, moved, created }) {
  for (const { source, target } of moved.reverse()) {
    if (fs.existsSync(source)) {
      if (readContent(source) !== readContent(target)) throw new Error('旧文件已变化，保留迁移现场以便恢复。');
    } else fs.linkSync(target, source);
    fs.unlinkSync(target);
  }
  for (const { file, content } of created.reverse()) {
    if (readContent(file) !== content) throw new Error('迁移目标已被修改，保留迁移现场以便恢复。');
    fs.unlinkSync(file);
  }
  if (fs.existsSync(legacy.ideas)) throw new Error('旧收件箱已重新创建，保留迁移现场以便恢复。');
  fs.linkSync(legacy.claimed, legacy.ideas);
  fs.unlinkSync(legacy.claimed);
}

function relativeLegacyPaths(legacy, fonsDir) {
  return Object.fromEntries(Object.entries(legacy).map(([key, file]) => [key, path.relative(fonsDir, file)]));
}

function migrationHash(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function migrationPlan({ rootDir, targets, state, fonsDir }) {
  return [...targets].map(([sessionId, entries]) => {
    const paths = sessionPaths({ rootDir, sessionId });
    if ([paths.ideas, paths.state, paths.ui, paths.archive].some((file) => fs.existsSync(file))) {
      throw new Error('目标会话已有数据，旧收件箱未迁移，请先处理冲突。');
    }
    const output = migrationOutput(entries, state[sessionId]);
    const record = {
      ideas: path.relative(fonsDir, paths.ideas), state: path.relative(fonsDir, paths.state),
      ideasHash: migrationHash(output.content), stateHash: migrationHash(JSON.stringify(output.state, null, 2)),
    };
    return { paths, output, record };
  });
}

function migrationStep(context, step) {
  context.owner.step = step;
  writeJsonAtomic(context.ownerFile, context.owner);
}

function publishMigration(plan, created) {
  for (const { paths, output } of plan) {
    migrationWriteJson(paths.state, output.state, created);
    migrationWrite(paths.ideas, output.content, created);
  }
}

function processStatus(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'unknown';
  try { process.kill(pid, 0); return 'active'; }
  catch (error) { return error.code === 'ESRCH' ? 'interrupted' : 'unknown'; }
}

export function getMigrationWarning({ rootDir, scope }) {
  if (scope === 'no-workspace' || !rootDir) return null;
  const lock = path.join(rootDir, '.agents', 'fons', '.migration.lock');
  if (!fs.existsSync(lock)) return null;
  let owner;
  try { owner = readJson(path.join(lock, 'owner.json')); }
  catch { return { status: 'unknown', message: '旧数据迁移状态无法确认，请按 README 核对现场。' }; }
  const status = owner.step === 'rollback-failed' ? 'interrupted' : processStatus(owner.pid);
  const message = status === 'interrupted' ? '旧数据迁移中断，请按 README 手动恢复。'
    : status === 'active' ? '旧数据正在迁移，请稍候。'
      : '旧数据迁移状态无法确认，请按 README 核对现场。';
  return { status, message, pid: owner.pid, startedAt: owner.startedAt, step: owner.step };
}

function releaseMigrationLock(context) {
  if (fs.existsSync(context.ownerFile)) fs.unlinkSync(context.ownerFile);
  fs.rmdirSync(context.lock);
}

export function migrateLegacyInbox({ rootDir, scope, sessionId }) {
  if (scope === 'no-workspace' || !rootDir) return { migrated: false };
  const fonsDir = sessionPaths({ rootDir, sessionId }).fonsDir;
  const legacy = migrationLegacyPaths(fonsDir);
  const lock = path.join(fonsDir, '.migration.lock');
  try { fs.mkdirSync(lock); }
  catch (error) { if (error.code === 'EEXIST' || error.code === 'ENOENT') return { migrated: false }; throw error; }
  const context = {
    fonsDir, lock, ownerFile: path.join(lock, 'owner.json'),
    owner: { pid: process.pid, startedAt: Date.now(), step: 'claiming', source: relativeLegacyPaths(legacy, fonsDir), targets: [] },
  };
  let release = true;
  try {
    migrationStep(context, 'claiming');
    return migrateClaimedLegacy({ rootDir, sessionId, legacy, context });
  } catch (error) {
    if (error.recoveryRequired) release = false;
    throw error;
  } finally {
    if (release) releaseMigrationLock(context);
  }
}

function migrateClaimedLegacy({ rootDir, sessionId, legacy, context }) {
  if (fs.existsSync(legacy.claimed)) throw new Error('发现未完成的旧收件箱迁移，请先恢复。');
  try { fs.renameSync(legacy.ideas, legacy.claimed); }
  catch (error) { if (error.code === 'ENOENT') return { migrated: false }; throw error; }
  const created = [];
  const moved = [];
  try {
    migrationStep(context, 'planning');
    const content = fs.readFileSync(legacy.claimed, 'utf8');
    const archive = readContent(legacy.archive);
    const state = readJson(legacy.state);
    migrationCheckState(state);
    const targets = migrationRows(content, archive, state, sessionId);
    const plan = migrationPlan({ rootDir, targets, state, fonsDir: context.fonsDir });
    context.owner.targets = plan.map(({ record }) => record);
    migrationStep(context, 'publishing');
    publishMigration(plan, created);
    if (readContent(legacy.claimed) !== content) throw new Error('迁移期间旧收件箱发生变化，请重试。');
    migrationStep(context, 'moving-archive');
    migrationMove(legacy.archive, legacy.archiveBackup, moved);
    migrationStep(context, 'moving-state');
    migrationMove(legacy.state, legacy.stateBackup, moved);
    migrationStep(context, 'finalizing');
    fs.unlinkSync(legacy.claimed);
    return { migrated: true };
  } catch (error) {
    try { migrationRollback({ legacy, moved, created }); }
    catch (rollbackError) {
      try { migrationStep(context, 'rollback-failed'); }
      catch (recordError) { rollbackError.message += '；无法更新恢复记录：' + recordError.message; }
      const failure = new Error(error.message + '；' + rollbackError.message);
      failure.recoveryRequired = true;
      throw failure;
    }
    throw error;
  }
}
