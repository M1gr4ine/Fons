import fs from "node:fs";
import path from "node:path";
import { parseActiveItems } from "./fons-hook.mjs";

const USAGE = `用法:
  fons "<灵感内容>"   向 .agents/fons/ideas.md 追加待办条目
  fons list           查看当前未处理条目
  fons archive        将已标 - [x] 的条目归档至 archive.md
  fons help           显示帮助`;

function findWorkspaceRoot(startDir) {
  let dir = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(dir, ".agents")) || fs.existsSync(path.join(dir, ".git"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(startDir);
    dir = parent;
  }
}

function resolvePaths() {
  const root = process.env.FONS_ROOT?.trim()
    ? path.resolve(process.env.FONS_ROOT.trim())
    : findWorkspaceRoot(process.cwd());
  const fonsDir = path.join(root, ".agents", "fons");
  return {
    fonsDir,
    ideasPath: path.join(fonsDir, "ideas.md"),
    archivePath: path.join(fonsDir, "archive.md"),
  };
}

function appendLinesWithNewline(filePath, linesText) {
  let prefix = "";
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, "utf8");
    if (existing.length > 0 && !existing.endsWith("\n")) {
      prefix = "\n";
    }
  }
  fs.appendFileSync(filePath, prefix + linesText, "utf8");
}

function cmdList(ideasPath) {
  if (!fs.existsSync(ideasPath)) {
    process.stdout.write("当前无待处理灵感。\n");
    return;
  }
  const items = parseActiveItems(fs.readFileSync(ideasPath, "utf8"));
  if (items.length === 0) {
    process.stdout.write("当前无待处理灵感。\n");
    return;
  }
  const output = items.map((item, i) => `${i + 1}. ${item.text}`).join("\n");
  process.stdout.write(output + "\n");
}

function cmdArchive(fonsDir, ideasPath, archivePath) {
  if (!fs.existsSync(ideasPath)) {
    process.stdout.write("当前无可归档条目。\n");
    return;
  }

  const content = fs.readFileSync(ideasPath, "utf8");
  if (content.length === 0) {
    process.stdout.write("当前无可归档条目。\n");
    return;
  }

  const lines = content.replace(/\r?\n$/, "").split(/\r?\n/);
  const doneLines = [];
  const keptLines = [];

  for (const line of lines) {
    if (/^\s*[-*]\s*\[[xX]\]/.test(line)) {
      doneLines.push(line);
    } else {
      keptLines.push(line);
    }
  }

  if (doneLines.length === 0) {
    process.stdout.write("当前无可归档条目。\n");
    return;
  }

  fs.mkdirSync(fonsDir, { recursive: true });
  appendLinesWithNewline(archivePath, doneLines.join("\n") + "\n");

  // 仅剩空白行时写为空文件（0 字节），恢复 run-hook.cmd 的零字节快路径
  const hasContent = keptLines.some((line) => line.trim() !== "");
  fs.writeFileSync(ideasPath, hasContent ? keptLines.join("\n") + "\n" : "", "utf8");

  process.stdout.write(`已归档 ${doneLines.length} 条已完成灵感。\n`);
}

function cmdAdd(fonsDir, ideasPath, rawArgs) {
  const text = rawArgs
    .join(" ")
    .trim()
    .replace(/^[-*]\s*\[\s*\]\s*/, "")
    .trim();

  if (!text) {
    process.stderr.write("错误：灵感内容不能为空。\n");
    process.exit(1);
  }

  fs.mkdirSync(fonsDir, { recursive: true });
  appendLinesWithNewline(ideasPath, `- [ ] ${text}\n`);
  process.stdout.write(`已记录灵感：${text}\n`);
}

const args = process.argv.slice(2);

if (args.length === 0) {
  process.stderr.write(USAGE + "\n");
  process.exit(1);
}

if (args.length === 1 && (args[0] === "help" || args[0] === "--help" || args[0] === "-h")) {
  process.stdout.write(USAGE + "\n");
  process.exit(0);
}

const { fonsDir, ideasPath, archivePath } = resolvePaths();

if (args.length === 1 && args[0] === "list") {
  cmdList(ideasPath);
} else if (args.length === 1 && args[0] === "archive") {
  cmdArchive(fonsDir, ideasPath, archivePath);
} else {
  cmdAdd(fonsDir, ideasPath, args);
}
