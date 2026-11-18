import fs from 'node:fs';
import path from 'node:path';
import { COMPLETED_PREFIX, isCompletedLine, parseInbox } from './fons-inbox.mjs';

const USAGE = `用法:
  fons "<灵感内容>"     向 .agents/fons/ideas.md 追加待办条目
  fons list             查看待处理条目及其确认令牌
  fons done <令牌...>   仅确认指定条目（【√】）
  fons archive          归档已完成条目（归档期间请勿编辑 ideas.md）
  fons help             显示帮助`;

function findWorkspaceRoot(startDir) {
  let dir = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(dir, '.agents')) || fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(startDir);
    dir = parent;
  }
}

function resolvePaths() {
  const explicitRoot = process.env.FONS_ROOT?.trim();
  const root = explicitRoot ? path.resolve(explicitRoot) : findWorkspaceRoot(process.cwd());
  const fonsDir = path.join(root, '.agents', 'fons');
  return { fonsDir, ideasPath: path.join(fonsDir, 'ideas.md'), archivePath: path.join(fonsDir, 'archive.md') };
}

function detectEol(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function readContent(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}

function appendLinesWithNewline(filePath, lines) {
  const existing = readContent(filePath);
  const eol = detectEol(existing);
  const prefix = existing && !existing.endsWith('\n') ? eol : '';
  fs.appendFileSync(filePath, prefix + lines.join(eol) + eol, 'utf8');
}

function cmdList(ideasPath) {
  const { activeItems } = parseInbox(readContent(ideasPath));
  if (!activeItems.length) {
    process.stdout.write('当前无待处理灵感。\n');
    return;
  }
  process.stdout.write(activeItems.map((item, i) => `${i + 1}. ${item.text} [${item.token}]`).join('\n') + '\n');
}

function cmdDone(ideasPath, tokens) {
  if (!tokens.length) throw new Error('请先运行 fons list，再指定已处理条目的令牌。');
  if (new Set(tokens).size !== tokens.length) throw new Error('确认令牌重复。');
  const content = readContent(ideasPath);
  const { activeItems } = parseInbox(content);
  const byToken = new Map(activeItems.map((item) => [item.token, item]));
  const selected = tokens.map((token) => byToken.get(token));
  if (selected.some((item) => !item)) throw new Error('确认令牌无效或条目已变化，请重新运行 fons list。');
  const eol = detectEol(content);
  const receipts = selected.map((item) => `${COMPLETED_PREFIX}${item.text} <!-- fons-ack:${item.token} -->`);
  // Always start a new line: another writer may have appended after our read.
  fs.appendFileSync(ideasPath, eol + receipts.join(eol) + eol, 'utf8');
  process.stdout.write(`已确认 ${selected.length} 条灵感（【√】）。\n`);
}

function archiveRows(rows) {
  const done = [];
  const kept = [];
  for (const row of rows) {
    if (row.completed) done.push(`${COMPLETED_PREFIX}${row.text}`);
    else if (row.receipt) continue;
    else if (isCompletedLine(row.body) && !row.body.includes('<!-- fons-ack:')) done.push(row.body);
    else kept.push(row.raw);
  }
  while (kept.length && !kept.at(-1).trim()) kept.pop();
  return { done, kept: kept.join('') };
}

function cmdArchive(paths) {
  const content = readContent(paths.ideasPath);
  const { done, kept } = archiveRows(parseInbox(content).rows);
  if (!done.length) {
    process.stdout.write('当前无可归档条目。\n');
    return;
  }
  if (readContent(paths.ideasPath) !== content) throw new Error('ideas.md 已变化，请停止编辑后重试归档。');
  fs.mkdirSync(paths.fonsDir, { recursive: true });
  appendLinesWithNewline(paths.archivePath, done);
  if (readContent(paths.ideasPath) !== content) {
    throw new Error('已写入 archive.md，但 ideas.md 已变化，未清理收件箱；重试可能重复归档。');
  }
  fs.writeFileSync(paths.ideasPath, kept.trim() ? kept : '', 'utf8');
  process.stdout.write(`已归档 ${done.length} 条已完成灵感。\n`);
}

function cmdAdd(paths, rawArgs) {
  const text = rawArgs.join(' ').trim().replace(/^[-*]\s*\[\s*\]\s*/, '').trim();
  if (!text) throw new Error('灵感内容不能为空。');
  fs.mkdirSync(paths.fonsDir, { recursive: true });
  appendLinesWithNewline(paths.ideasPath, [`- [ ] ${text}`]);
  process.stdout.write(`已记录灵感：${text}\n`);
}

const args = process.argv.slice(2);
try {
  if (!args.length) throw new Error(USAGE);
  if (args.length === 1 && ['help', '--help', '-h'].includes(args[0])) process.stdout.write(USAGE + '\n');
  else {
    const paths = resolvePaths();
    if (args[0] === 'list' && args.length === 1) cmdList(paths.ideasPath);
    else if (args[0] === 'done') cmdDone(paths.ideasPath, args.slice(1));
    else if (args[0] === 'archive') {
      if (args.length !== 1) throw new Error(`不支持的参数 "${args.slice(1).join(' ')}"。`);
      cmdArchive(paths);
    } else cmdAdd(paths, args);
  }
} catch (err) {
  process.stderr.write(`错误：${err.message}\n`);
  process.exitCode = 1;
}
