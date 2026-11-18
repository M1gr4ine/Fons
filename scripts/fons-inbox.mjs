import crypto from 'node:crypto';

export const COMPLETED_PREFIX = '【√】 ';
const COMPLETED_LINE_RE = /^\s*(?:(?:[-*]\s*)?(?:\[\s*[√✓✔]\s*\]|【\s*[√✓✔]\s*】|[√✓✔])|[-*]\s*\[\s*[xX]\s*\])/;
const RECEIPT_RE = /^【√】 (.*?) <!-- fons-ack:([0-9]+-[a-f0-9]{64}) -->$/;

export function isCompletedLine(line) {
  return COMPLETED_LINE_RE.test(line);
}

export function extractPendingText(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#') || isCompletedLine(trimmed)) return '';
  return trimmed.replace(/^[-*]\s*\[\s*\]\s*/, '').replace(/^\[\s*\]\s*/, '')
    .replace(/^[-*](?:\s+|$)/, '').trim();
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

function completedText(line) {
  if (!isCompletedLine(line) || line.includes('<!-- fons-ack:')) return '';
  return line.replace(COMPLETED_LINE_RE, '').trim();
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

export function parseActiveItems(content, archivedContent = '') {
  const { rows, activeItems } = parseInbox(content);
  if (activeItems.length === 0) return [];

  const completions = countCompletions(rows, archivedContent);
  return activeItems.map(({ text }) => {
    // Keep the delivery ID stable when a completion moves from ideas.md to archive.md.
    const count = completions.get(text);
    const idInput = count ? text + '\0' + count : text;
    return { id: hash('sha1', idInput).slice(0, 12), text };
  });
}
