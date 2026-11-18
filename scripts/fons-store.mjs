import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { COMPLETED_PREFIX, isCompletedLine, parseInbox, parseActiveItems, completedText, deliveryId } from './fons-inbox.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidSessionId(sessionId) {
  return typeof sessionId === 'string' && UUID.test(sessionId);
}

export function sessionPaths({ rootDir, sessionId }) {
  if (!isValidSessionId(sessionId)) throw new Error('无效的会话 ID。');
  const fonsDir = path.join(rootDir, '.agents', 'fons');
  return {
    fonsDir,
    ideas: path.join(fonsDir, `ideas-${sessionId}.md`),
    state: path.join(fonsDir, `.state-${sessionId}.json`),
    ui: path.join(fonsDir, `.ui-${sessionId}.json`),
    archive: path.join(fonsDir, 'archive', `${sessionId}.md`),
    retractMarker: path.join(fonsDir, `.retract-${sessionId}.pending`),
  };
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
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
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

export function registerConversation({ appData, sessionId, rootDir, title }) {
  const filePath = indexPath(appData, sessionId);
  if (fs.existsSync(filePath)) return readJson(filePath);
  const cleanTitle = Array.from(String(title ?? '').replace(/[\r\n\u2028\u2029]/g, '')).slice(0, 20).join('');
  const entry = { rootDir, title: cleanTitle, registeredAt: Date.now() };
  return publishConversation(filePath, entry);
}

export function lookupConversation({ appData, sessionId }) {
  const filePath = indexPath(appData, sessionId);
  if (!fs.existsSync(filePath)) return null;
  const entry = readJson(filePath);
  if (typeof entry.rootDir !== 'string' || !entry.rootDir) return null;
  return { rootDir: entry.rootDir, title: entry.title ?? '' };
}

function workspaceKey(rootDir) {
  const resolved = path.resolve(rootDir);
  if (process.platform === 'win32') return resolved.toLowerCase();
  return resolved;
}

export function listConversations({ appData, rootDir }) {
  const directory = path.join(appData, 'fons', 'conversations');
  if (!fs.existsSync(directory)) return [];
  const workspace = workspaceKey(rootDir);
  return fs.readdirSync(directory).filter((name) => name.endsWith('.json'))
    .map((name) => ({ name, sessionId: name.slice(0, -5) }))
    .filter(({ sessionId }) => isValidSessionId(sessionId))
    .map(({ name, sessionId }) => ({ sessionId, ...readJson(path.join(directory, name)) }))
    .filter((entry) => typeof entry.rootDir === 'string' && workspaceKey(entry.rootDir) === workspace);
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
  if (delivery && (delivery.deliveredAt ?? 0) > withdrawnAt) return { status: 'delivered', doneSource: null };
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

export function readPoolData({ rootDir, sessionId }) {
  const paths = sessionPaths({ rootDir, sessionId });
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

export function resolveDebounceMs() {
  const raw = process.env.FONS_DEBOUNCE_SEC;
  if (raw === undefined || raw.trim() === '') return 60000;
  const seconds = Number(raw);
  return (Number.isFinite(seconds) && seconds >= 0 ? seconds : 60) * 1000;
}

export function computeDebounce({ items, state, ui, mtimeMs, debounceMs = resolveDebounceMs(), now = Date.now() }) {
  const uniqueItems = new Map();
  for (const item of items) {
    if (item.status === 'buffering') uniqueItems.set(item.text, item);
  }
  const pending = [...uniqueItems.values()];
  const unique = [...uniqueItems.keys()].sort();
  const sig = crypto.createHash('sha1').update(unique.join('\0')).digest('hex');
  const pendingSigAt = state.pendingSig === sig && typeof state.pendingSigAt === 'number' ? state.pendingSigAt : mtimeMs;
  const flushPending = pending.length > 0 && typeof ui.flushRequestedAt === 'number' && ui.flushRequestedAt >= pendingSigAt;
  const debounceRemainingMs = unique.length && debounceMs > 0 && !flushPending ? Math.max(0, debounceMs - (now - pendingSigAt)) : 0;
  return { pending, sig, pendingSigAt, flushPending, debounceRemainingMs };
}

export function readPoolSnapshot({ rootDir, sessionId, debounceMs = resolveDebounceMs(), now = Date.now() }) {
  const data = readPoolData({ rootDir, sessionId });
  const timing = computeDebounce({ ...data, debounceMs, now });
  return { items: data.items, debounceRemainingMs: timing.debounceRemainingMs, flushPending: timing.flushPending,
    canArchive: data.items.some((item) => item.status === 'done'), etag: data.etag };
}

export function addIdeas({ rootDir, sessionId, texts }) {
  const paths = sessionPaths({ rootDir, sessionId });
  const clean = texts.map((text) => String(text).replace(/[\r\n]+/g, ' ').trim().replace(/^[-*]\s*\[\s*\]\s*/, '').trim()).filter(Boolean);
  if (!clean.length) return { count: 0, texts: [] };
  fs.mkdirSync(paths.fonsDir, { recursive: true });
  appendLinesWithNewline(paths.ideas, clean.map((text) => `- [ ] ${text}`));
  return { count: clean.length, texts: clean };
}

export function completeIdea({ rootDir, sessionId, token, tokens = [token] }) {
  if (!tokens.length) throw new Error('请先运行 fons list，再指定已处理条目的令牌。');
  if (new Set(tokens).size !== tokens.length) throw new Error('确认令牌重复。');
  const data = readPoolData({ rootDir, sessionId });
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
}

function checkItem(data, rowIndex, expectedRaw) {
  if (data.rows[rowIndex]?.raw !== expectedRaw) return null;
  return data.items.find((item) => item.rowIndex === rowIndex) ?? null;
}

function foldedRows(data, targetIndex, replacement) {
  return data.rows.map((row, index) => {
    if (index === targetIndex) return replacement;
    if (row.receipt) return '';
    if (row.completed) return `${COMPLETED_PREFIX}${row.text}${row.raw.slice(row.body.length)}`;
    return row.raw;
  }).join('');
}

function replaceRow(data, rowIndex, replacement) {
  const next = foldedRows(data, rowIndex, replacement);
  if (readContent(data.paths.ideas) !== data.content) return { conflict: true };
  fs.writeFileSync(data.paths.ideas, next, 'utf8');
  return { conflict: false };
}

export function updateIdeaText({ rootDir, sessionId, rowIndex, expectedRaw, newText }) {
  const data = readPoolData({ rootDir, sessionId });
  const item = checkItem(data, rowIndex, expectedRaw);
  if (!item) return { conflict: true };
  const text = String(newText).replace(/[\r\n]+/g, ' ').trim();
  if (!text) throw new Error('灵感内容不能为空。');
  const eol = data.rows[rowIndex].raw.slice(data.rows[rowIndex].body.length);
  const prefix = item.status === 'done' && item.doneSource !== 'readonly_ack' ? COMPLETED_PREFIX : '- [ ] ';
  return replaceRow(data, rowIndex, `${prefix}${text}${eol}`);
}

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

export function removeIdea({ rootDir, sessionId, rowIndex, expectedRaw }) {
  const data = readPoolData({ rootDir, sessionId });
  const item = checkItem(data, rowIndex, expectedRaw);
  if (!item) return { conflict: true };
  const nextContent = foldedRows(data, rowIndex, '');
  const result = replaceRow(data, rowIndex, '');
  if (result.conflict || item.status !== 'delivered') return result;
  publishRetraction(data, item, nextContent);
  return result;
}

export function reopenIdea({ rootDir, sessionId, rowIndex, expectedRaw }) {
  const data = readPoolData({ rootDir, sessionId });
  const item = checkItem(data, rowIndex, expectedRaw);
  if (!item) return { conflict: true };
  if (item.status !== 'done') return { conflict: false };
  if (item.doneSource === 'readonly_ack') {
    if (readContent(data.paths.ideas) !== data.content) return { conflict: true };
    data.ui.reopened ??= {};
    data.ui.reopened[item.id] = Date.now();
    writeJsonAtomic(data.paths.ui, data.ui);
    return { conflict: false };
  }
  const row = data.rows[rowIndex];
  return replaceRow(data, rowIndex, `- [ ] ${item.text}${row.raw.slice(row.body.length)}`);
}

export function requestFlush({ rootDir, sessionId }) {
  const paths = sessionPaths({ rootDir, sessionId });
  const ui = readJson(paths.ui);
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(paths.ideas).mtimeMs; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  ui.flushRequestedAt = Math.max(Date.now(), mtimeMs);
  writeJsonAtomic(paths.ui, ui);
  return { flushRequestedAt: ui.flushRequestedAt };
}

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

export function archiveCompleted(context) {
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
}

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
  return {
    content: migrationContent(entries),
    state: { ...bucket, delivered: migrationLedger(bucket, mapping, 'delivered'),
      acknowledged: migrationLedger(bucket, mapping, 'acknowledged'),
      lastStopSig: '', stopCount: 0, pendingSig: '', pendingSigAt: 0 },
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

function migrationProcessStatus(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'unknown';
  try { process.kill(pid, 0); return 'active'; }
  catch (error) { return error.code === 'ESRCH' ? 'interrupted' : 'unknown'; }
}

export function getMigrationWarning({ rootDir }) {
  const lock = path.join(rootDir, '.agents', 'fons', '.migration.lock');
  if (!fs.existsSync(lock)) return null;
  let owner;
  try { owner = readJson(path.join(lock, 'owner.json')); }
  catch { return { status: 'unknown', message: '旧数据迁移状态无法确认，请按 README 核对现场。' }; }
  const status = owner.step === 'rollback-failed' ? 'interrupted' : migrationProcessStatus(owner.pid);
  const message = status === 'interrupted' ? '旧数据迁移中断，请按 README 手动恢复。'
    : status === 'active' ? '旧数据正在迁移，请稍候。'
      : '旧数据迁移状态无法确认，请按 README 核对现场。';
  return { status, message, pid: owner.pid, startedAt: owner.startedAt, step: owner.step };
}

function releaseMigrationLock(context) {
  if (fs.existsSync(context.ownerFile)) fs.unlinkSync(context.ownerFile);
  fs.rmdirSync(context.lock);
}

export function migrateLegacyInbox({ rootDir, sessionId }) {
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
