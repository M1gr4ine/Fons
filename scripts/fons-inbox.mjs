import crypto from 'node:crypto';

export const COMPLETED_PREFIX = '【√】 ';
const COMPLETED_LINE_RE = /^\s*(?:(?:[-*]\s*)?(?:\[\s*[√✓✔]\s*\]|【\s*[√✓✔]\s*】|[√✓✔])|[-*]\s*\[\s*[xX]\s*\])/;
const COMPLETED_PREFIX_RE = new RegExp(COMPLETED_LINE_RE.source + '\\s*');
const RECEIPT_RE = /^【√】 (.*?) <!-- fons-ack:([0-9]+-[a-f0-9]{64}) -->$/;
export const UUID_PART = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const STORED_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}-[a-f0-9]{8}(?:\.[a-z0-9]{1,16})?$/;

function tailAttachmentPattern(prefix = '') {
  return new RegExp(
    `(?:^|\\s+)\\[([^\\[\\]\\r\\n]+)\\]\\(${prefix}(attachments\\/(${UUID_PART})\\/([A-Za-z0-9._-]+))\\)$`,
    'i',
  );
}

const TAIL_ATTACHMENT_RE = tailAttachmentPattern();
const TAIL_ARCHIVED_ATTACHMENT_RE = tailAttachmentPattern('\\.\\.\\/');

export function isValidStoredName(value) {
  return typeof value === 'string' && !value.includes('..') && STORED_NAME_RE.test(value);
}

export function cleanAttachmentLabel(name, fallback = 'attachment') {
  const cleaned = String(name ?? '')
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/\[/g, '(')
    .replace(/\]/g, ')')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}

export function composeIdeaText(note, attachments = [], sessionId) {
  const cleanNote = note.trim();
  const seen = new Set();
  const links = [];
  for (const { name, storedName } of attachments) {
    if (seen.has(storedName)) continue;
    seen.add(storedName);
    links.push(`[${cleanAttachmentLabel(name, storedName)}](attachments/${sessionId}/${storedName})`);
  }
  if (cleanNote && links.length) return `${cleanNote} ${links.join(' ')}`;
  return cleanNote || links.join(' ');
}

export function formatArchivedIdeaText(text, sessionId) {
  const { note, attachments } = splitIdeaText(text, sessionId);
  if (!attachments.length) return text;
  const links = attachments.map((att) => `[${cleanAttachmentLabel(att.name, att.storedName)}](../attachments/${sessionId}/${att.storedName})`);
  return note ? `${note} ${links.join(' ')}` : links.join(' ');
}

export function formatArchivedInlineRow(body, sessionId) {
  const extracted = completedText(body);
  if (!extracted || !splitIdeaText(extracted, sessionId).attachments.length) return body;
  const prefix = COMPLETED_PREFIX_RE.exec(body)?.[0] ?? COMPLETED_PREFIX;
  return `${prefix}${formatArchivedIdeaText(extracted, sessionId)}`;
}

function extractTailAttachments(text, pattern, sessionId) {
  let remaining = text;
  const links = [];
  while (remaining) {
    const match = pattern.exec(remaining);
    if (!match) break;
    const [, rawName, relPath, linkSessionId, storedName] = match;
    if (!isValidStoredName(storedName)) break;
    if (sessionId && linkSessionId.toLowerCase() !== sessionId.toLowerCase()) break;
    links.push({ rawName, relPath, storedName });
    remaining = remaining.slice(0, match.index).trimEnd();
  }
  links.reverse();
  return { remaining, links };
}

function normalizeArchivedLinks(text) {
  const { remaining, links } = extractTailAttachments(text, TAIL_ARCHIVED_ATTACHMENT_RE);
  if (!links.length) return remaining;
  const normalized = links.map(({ rawName, relPath }) => `[${rawName}](${relPath})`).join(' ');
  return remaining ? `${remaining} ${normalized}` : normalized;
}

export function splitIdeaText(text, sessionId) {
  const { remaining, links } = extractTailAttachments(String(text ?? '').trim(), TAIL_ATTACHMENT_RE, sessionId);
  const seen = new Set();
  const attachments = [];
  for (const { rawName, relPath, storedName } of links) {
    if (seen.has(storedName)) continue;
    seen.add(storedName);
    attachments.push({ name: rawName.trim() || storedName, storedName, relPath });
  }
  return { note: remaining, attachments };
}

export function formatRetractedIdea(text, sessionId) {
  const { note, attachments } = splitIdeaText(text, sessionId);
  if (!attachments.length) return text;
  const names = attachments.map((att) => att.name).join(', ');
  return note ? `${note}（附件: ${names}）` : `[附件: ${names}]`;
}

export function isCompletedLine(line) {
  return COMPLETED_LINE_RE.test(line);
}

function extractPendingText(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#') || isCompletedLine(trimmed)) return '';
  return trimmed.replace(/^(?:[-*]\s*\[\s*\]|\[\s*\]|[-*](?=\s|$))\s*/, '').trim();
}

function hash(algorithm, content) {
  return crypto.createHash(algorithm).update(content).digest('hex');
}

function readLines(content) {
  const rows = [];
  const digest = crypto.createHash('sha256');
  let bytes = 0;
  const pattern = /[^\n]*(?:\n|$)/g;
  for (const match of content.matchAll(pattern)) {
    if (!match[0]) continue;
    const body = match[0].replace(/\n$/, '').replace(/\r$/, '');
    digest.update(body);
    bytes += Buffer.byteLength(body);
    const token = `${bytes}-${digest.copy().digest('hex')}`;
    const suffix = match[0].slice(body.length);
    digest.update(suffix);
    bytes += Buffer.byteLength(suffix);
    rows.push({ body, raw: match[0], token });
  }
  return rows;
}

function bindReceipts(rows) {
  const pendingByToken = new Map();
  for (const row of rows) {
    const text = extractPendingText(row.body);
    if (text) {
      row.text = text;
      pendingByToken.set(row.token, row);
      continue;
    }
    const receipt = RECEIPT_RE.exec(row.body);
    if (!receipt) continue;
    const target = pendingByToken.get(receipt[2]);
    if (target && target.text === receipt[1]) {
      target.completed = true;
      row.receipt = target;
    }
  }
}

function collectActiveItems(rows) {
  const seen = new Set();
  const activeItems = [];
  for (const { text, completed, token } of rows) {
    if (!text || completed || seen.has(text)) continue;
    seen.add(text);
    activeItems.push({ text, token });
  }
  return activeItems;
}

export function parseInbox(content) {
  const rows = readLines(content);
  bindReceipts(rows);
  return { rows, activeItems: collectActiveItems(rows) };
}

export function completedText(line) {
  if (!isCompletedLine(line) || line.includes('<!-- fons-ack:')) return '';
  return normalizeArchivedLinks(line.replace(COMPLETED_LINE_RE, '').trim());
}

function countCompletions(rows, archivedContent) {
  const counts = new Map();
  const current = rows.map((row) => row.completed ? row.text : completedText(row.body));
  const archived = archivedContent.split(/\r?\n/).map(completedText);
  for (const text of current.concat(archived)) {
    if (text) counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  return counts;
}

export function deliveryId(text, count) {
  const idInput = count ? text + '\0' + count : text;
  return hash('sha1', idInput).slice(0, 12);
}

export function deliveryIdAfterRemovingCompletion(text, rows, archive) {
  return deliveryId(text, countCompletions(rows, archive).get(text) - 1);
}

export function activeDeliveryIds(rows, activeItems, archivedContent = '') {
  const ids = new Map();
  if (!activeItems.length) return ids;

  const completions = countCompletions(rows, archivedContent);
  for (const { text } of activeItems) {
    // Keep the delivery ID stable when a completion moves from ideas.md to archive.md.
    ids.set(text, deliveryId(text, completions.get(text)));
  }
  return ids;
}
