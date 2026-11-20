import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addIdeas, archiveCompleted, completeIdea, getMigrationWarning,
  listConversations, lookupConversation, readPoolSnapshot,
} from './fons-store.mjs';

const USAGE = `用法:
  fons [-s <会话ID> | -n | --no-workspace] "<灵感内容>"  向本会话收件箱追加待办条目
  fons [-s <会话ID> | -n | --no-workspace] list          查看待处理条目及其确认令牌
  fons [-s <会话ID> | -n | --no-workspace] done <令牌...> 仅确认指定条目（【√】）
  fons [-s <会话ID> | -n | --no-workspace] archive       归档已完成条目
  fons help                                              显示帮助`;

function findWorkspaceRoot(startDir) {
  let dir = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(dir, '.agents')) || fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(startDir);
    dir = parent;
  }
}

function parseOptions(args) {
  const positional = [];
  let sessionId;
  let noWorkspace = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '-n' || arg === '--no-workspace') {
      noWorkspace = true;
      continue;
    }
    if (arg !== '-s' && arg !== '--session') { positional.push(arg); continue; }
    if (sessionId !== undefined || !args[index + 1] || args[index + 1].startsWith('-')) {
      throw new Error('请为 -s 或 --session 指定一个会话 ID。');
    }
    sessionId = args[++index];
  }
  if (noWorkspace && sessionId !== undefined) {
    throw new Error('不能同时指定 -s/--session 和 -n/--no-workspace。');
  }
  return { args: positional, sessionId: noWorkspace ? undefined : (sessionId ?? process.env.FONS_SESSION?.trim()), noWorkspace };
}

function formatRegisteredAt(value) {
  if (value === undefined || value === null) return '未知时间';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function candidateError(candidates, heading = '当前工作区有多个会话，请用 -s 指定：\n') {
  const details = candidates.map(({ sessionId, title, registeredAt }) =>
    '  ' + sessionId + '  ' + (title || '无标题') + '  ' + formatRegisteredAt(registeredAt)).join('\n');
  const error = new Error(heading + details);
  error.exitCode = 2;
  return error;
}

function resolveSession({ sessionId, noWorkspace }) {
  const appData = process.env.FONS_APP_DATA?.trim() || path.join(os.homedir(), '.gemini', 'antigravity');
  if (sessionId) {
    const entry = lookupConversation({ appData, sessionId });
    if (!entry) throw new Error('找不到指定会话，请先在 Antigravity 中开启会话。');
    return { scope: entry.scope, rootDir: entry.rootDir, fonsDir: entry.fonsDir, sessionId };
  }
  if (noWorkspace) {
    const candidates = listConversations({ appData, scope: 'no-workspace' });
    if (!candidates.length) {
      throw new Error('未找到已登记的无工作区会话，请先在 Antigravity 中开启会话并确认全局 Fons 插件已启用。');
    }
    if (candidates.length > 1) throw candidateError(candidates, '存在多个无工作区会话，请用 -s 指定：\n');
    return { scope: candidates[0].scope, rootDir: null, fonsDir: candidates[0].fonsDir, sessionId: candidates[0].sessionId };
  }
  const workspace = process.env.FONS_ROOT?.trim() || findWorkspaceRoot(process.cwd());
  const candidates = listConversations({ appData, rootDir: workspace });
  if (!candidates.length) {
    checkMigration({ scope: 'workspace', rootDir: workspace });
    throw new Error('请先在 Antigravity 中开启会话。');
  }
  if (candidates.length > 1) throw candidateError(candidates);
  return { scope: candidates[0].scope, rootDir: candidates[0].rootDir, fonsDir: candidates[0].fonsDir, sessionId: candidates[0].sessionId };
}

function checkMigration(context) {
  if (context.scope === 'no-workspace') return;
  const fonsDir = path.join(context.rootDir, '.agents', 'fons');
  const warning = getMigrationWarning(context);
  if (warning) process.stderr.write('提示：' + warning.message + '\n');
  if (!fs.existsSync(path.join(fonsDir, 'ideas.md'))) return;
  const message = '检测到旧收件箱，请先在 Antigravity 中触发 Hook 完成迁移。';
  if (!warning) throw new Error(message);
  process.stderr.write('提示：' + message + '\n');
}

function cmdList(context) {
  const seen = new Set();
  const active = readPoolSnapshot(context).items.filter((item) => {
    if (item.status === 'done' || seen.has(item.text)) return false;
    seen.add(item.text);
    return true;
  });
  if (!active.length) {
    process.stdout.write('当前无待处理灵感。\n');
    return;
  }
  process.stdout.write(active.map((item, i) => (i + 1) + '. ' + item.text + ' [' + item.token + ']').join('\n') + '\n');
}

function cmdDone(context, tokens) {
  const { count } = completeIdea({ ...context, tokens });
  process.stdout.write('已确认 ' + count + ' 条灵感（【√】）。\n');
}

function cmdArchive(context) {
  const { count } = archiveCompleted(context);
  if (!count) {
    process.stdout.write('当前无可归档条目。\n');
    return;
  }
  process.stdout.write('已归档 ' + count + ' 条已完成灵感。\n');
}

function cmdAdd(context, rawArgs) {
  const result = addIdeas({ ...context, texts: [rawArgs.join(' ')] });
  if (!result.count) throw new Error('灵感内容不能为空。');
  process.stdout.write('已记录灵感：' + result.texts[0] + '\n');
}

function run(context, args) {
  if (args[0] === 'list' && args.length === 1) return cmdList(context);
  if (args[0] === 'done') return cmdDone(context, args.slice(1));
  if (args[0] === 'archive') {
    if (args.length !== 1) throw new Error('不支持的参数 "' + args.slice(1).join(' ') + '"。');
    return cmdArchive(context);
  }
  return cmdAdd(context, args);
}

try {
  const options = parseOptions(process.argv.slice(2));
  if (!options.args.length) throw new Error(USAGE);
  if (options.args.length === 1 && ['help', '--help', '-h'].includes(options.args[0])) {
    process.stdout.write(USAGE + '\n');
  } else {
    const context = resolveSession(options);
    checkMigration(context);
    run(context, options.args);
  }
} catch (error) {
  process.stderr.write('错误：' + error.message + '\n');
  process.exitCode = error.exitCode ?? 1;
}
