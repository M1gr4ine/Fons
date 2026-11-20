import fs from 'node:fs';
import path from 'node:path';
import { splitIdeaText } from './fons-inbox.mjs';
import {
  MAX_ATTACHMENT_BYTES, MAX_ITEM_ATTACHMENTS, addIdeas, archiveCompleted, completeIdea, readPoolSnapshot,
} from './fons-store.mjs';
import { formatSessions, listSessions, resolveSession } from './fons-sessions.mjs';
import { prepareCodexPlugin } from '../codex/init.mjs';

const USAGE = `用法:
  fons [-s <会话ID> | -n | --no-workspace] [-a <文件路径>...] ["<灵感内容>"]  向本会话收件箱追加待办条目
  fons [-s <会话ID> | -n | --no-workspace] list                             查看待处理条目及其确认令牌
  fons [-s <会话ID> | -n | --no-workspace] done <令牌...>                   仅确认指定条目（【√】）
  fons [-s <会话ID> | -n | --no-workspace] archive                          归档已完成条目
  fons [-s <会话ID> | -n | --no-workspace] sessions                        列出已登记会话
  fons codex init                                                           准备 Codex 插件安装
  fons help                                                                 显示帮助

宿主选择：--host codex|antigravity（或 FONS_HOST）`;

const OPTION_KEYS = {
  '-s': 'sessionId',
  '--session': 'sessionId',
  '--host': 'host',
  '-a': 'attachPaths',
  '--attach': 'attachPaths',
};

function optionValue(args, index, flag, inlineValue) {
  if (inlineValue !== undefined && inlineValue.trim()) return inlineValue.trim();
  const value = args[index + 1];
  if (inlineValue !== undefined || !value || value.startsWith('-')) {
    throw new Error('请为 ' + flag + ' 指定一个值。');
  }
  return value;
}

function parseOptions(args) {
  const options = { args: [], attachPaths: [] };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '-n' || arg === '--no-workspace') {
      options.scope = 'no-workspace';
      continue;
    }
    const separator = arg.indexOf('=');
    const flag = separator < 0 ? arg : arg.slice(0, separator);
    const inlineValue = separator < 0 ? undefined : arg.slice(separator + 1);
    const key = Object.hasOwn(OPTION_KEYS, flag) ? OPTION_KEYS[flag] : null;
    if (!key) {
      options.args.push(arg);
      continue;
    }
    const value = optionValue(args, index, flag, inlineValue);
    if (inlineValue === undefined) index++;
    applyOption(options, key, value, flag);
  }
  validateOptions(options);
  return options;
}

function applyOption(options, key, value, flag) {
  if (key === 'attachPaths') {
    options.attachPaths.push(value);
    return;
  }
  if (options[key] !== undefined) throw new Error('不能重复指定 ' + flag + '。');
  options[key] = value;
}

function validateOptions(options) {
  if (options.scope && options.sessionId !== undefined) {
    throw new Error('不能同时指定 -s/--session 和 -n/--no-workspace。');
  }
  if (options.attachPaths.length > MAX_ITEM_ATTACHMENTS) {
    throw new Error('单条灵感最多添加 ' + MAX_ITEM_ATTACHMENTS + ' 个附件。');
  }
}

function formatDisplayText(text, sessionId) {
  const { note, attachments } = splitIdeaText(text, sessionId);
  if (!attachments.length) return text;
  const names = attachments.map((att) => att.name).join(', ');
  return note ? `${note} [附件: ${names}]` : `[附件: ${names}]`;
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
  process.stdout.write(active.map((item, i) => (
    `${i + 1}. ${formatDisplayText(item.text, context.sessionId)} [${item.token}]`
  )).join('\n') + '\n');
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

function loadCliAttachments(attachPaths) {
  return attachPaths.map((filePath) => {
    const resolved = path.resolve(filePath);
    const stat = fs.statSync(resolved, { throwIfNoEntry: false });
    if (!stat || !stat.isFile()) throw new Error(`找不到附件文件：${filePath}`);
    if (!stat.size) throw new Error(`附件内容不能为空：${filePath}`);
    if (stat.size > MAX_ATTACHMENT_BYTES) throw new Error(`单个附件不能超过 10 MB：${filePath}`);
    return { name: path.basename(resolved), buffer: fs.readFileSync(resolved) };
  });
}

function cmdAdd(context, rawArgs, attachPaths = []) {
  const attachments = loadCliAttachments(attachPaths);
  const texts = rawArgs.length ? [rawArgs.join(' ')] : [];
  const result = addIdeas({ ...context, texts, attachments });
  if (!result.count) throw new Error('灵感内容不能为空。');
  process.stdout.write('已记录灵感：' + formatDisplayText(result.texts[0], context.sessionId) + '\n');
}

function run(context, args, attachPaths) {
  const isBuiltinSubcmd = (args[0] === 'list' && args.length === 1) || args[0] === 'done' || args[0] === 'archive';
  if (attachPaths.length && isBuiltinSubcmd) {
    throw new Error(`"${args[0]}" 子命令不支持 -a/--attach 参数。`);
  }
  if (args[0] === 'list' && args.length === 1) return cmdList(context);
  if (args[0] === 'done') return cmdDone(context, args.slice(1));
  if (args[0] === 'archive') {
    if (args.length !== 1) throw new Error('不支持的参数 "' + args.slice(1).join(' ') + '"。');
    return cmdArchive(context);
  }
  return cmdAdd(context, args, attachPaths);
}

function cmdCodexInit(options) {
  if (options.attachPaths.length || options.scope || options.sessionId || options.host) {
    throw new Error('codex init 不接受会话或附件参数。');
  }
  const { marketplaceRoot, pluginId } = prepareCodexPlugin();
  process.stdout.write('已准备 Codex 插件。请使用 Codex CLI 注册并安装，再审阅 Fons Hook 的信任请求。\n'
    + '插件市场目录：' + marketplaceRoot + '\n'
    + 'codex plugin marketplace add "<上面的插件市场目录>"\n'
    + 'codex plugin add ' + pluginId + '\n');
}

function cmdSessions(options) {
  if (options.attachPaths.length) throw new Error('sessions 不支持 -a/--attach 参数。');
  process.stdout.write(formatSessions(listSessions(options)) + '\n');
}

function reportError(error) {
  process.stderr.write('错误：' + error.message + '\n');
  process.exitCode = error.exitCode ?? 1;
}

function runCli(options) {
  const { args, attachPaths } = options;
  if (!args.length && !attachPaths.length) throw new Error(USAGE);
  if (!attachPaths.length && args.length === 1 && ['help', '--help', '-h'].includes(args[0])) {
    process.stdout.write(USAGE + '\n');
    return;
  }
  if (args.length === 2 && args[0] === 'codex' && args[1] === 'init') return cmdCodexInit(options);
  if (args.length === 1 && args[0] === 'sessions') return cmdSessions(options);
  run(resolveSession(options), args, attachPaths);
}

try {
  runCli(parseOptions(process.argv.slice(2)));
} catch (error) {
  reportError(error);
}
