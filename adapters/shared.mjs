import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalPath, resolveStopWaitDebounce } from "../scripts/fons-config.mjs";

export const START_SOURCES = new Set(["startup", "resume", "clear", "compact", "fork"]);
export const UNREADABLE_LOG = new Set(["ENOENT", "ENOTDIR", "EACCES", "EPERM", "EISDIR"]);

export function effectiveHome(env = process.env) {
  return env.USERPROFILE || env.HOME || os.homedir();
}

export function hostAppData(envKey, defaultDir, env = process.env, homeDir = effectiveHome(env), cwd = process.cwd()) {
  const configured = env[envKey]?.trim();
  return configured ? path.resolve(cwd, configured) : path.resolve(homeDir, defaultDir);
}

export function absolutePath(value) {
  if (typeof value !== "string" || value.includes("\0") || !path.isAbsolute(value)) return null;
  return canonicalPath(value);
}

export function pathKey(value) {
  if (value == null) return null;
  return process.platform === "win32" ? value.toLowerCase() : value;
}

export function* ancestorDirs(startDir, homeDir = effectiveHome()) {
  const home = pathKey(absolutePath(homeDir));
  let directory = startDir;
  while (directory) {
    const parent = path.dirname(directory);
    if (directory === parent || pathKey(directory) === home) break;
    yield directory;
    directory = parent;
  }
}

export function findMarkedWorkspace(cwd, markers, homeDir = effectiveHome()) {
  for (const directory of ancestorDirs(absolutePath(cwd), homeDir)) {
    if (markers.some((marker) => fs.existsSync(path.join(directory, marker)))) return directory;
  }
  return null;
}

export function matchesScope(scopeMode, scope) {
  return scopeMode === "all" || scopeMode === "global" || scopeMode === scope;
}

export function matchesTranscriptAnchor({ entry, context, scopeMode, host }) {
  return entry?.host === host && matchesScope(scopeMode, entry.scope) &&
    Boolean(entry.transcriptPath) && pathKey(entry.transcriptPath) === pathKey(context.transcriptPath);
}

export function asIdentifier(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

function quotePath(filename) {
  const runs = filename.match(/`+/g) ?? [];
  const delimiter = "`".repeat(1 + Math.max(0, ...runs.map((run) => run.length)));
  return delimiter + filename + delimiter;
}

export function formatDeliveredLine(
  { text, note, attachments, readded },
  paths,
  { scope, emptyNote = "请结合附件处理", noWorkspaceHint = "；无项目附件位于沙箱外，可能受读取限制" } = {},
) {
  const suffix = readded ? "（重新添加）" : "";
  if (!attachments.length) return text + suffix;
  const names = attachments.map(({ storedName }) => quotePath(path.resolve(paths.attachmentsDir, storedName)));
  const sandbox = scope === "no-workspace" ? noWorkspaceHint : "";
  return (note || emptyNote) + suffix + "（附件: " + names.join(", ") + sandbox + "）";
}

export function standardPoolPolicy({ appData = null } = {}) {
  return {
    rotateTokenOnStopRetry: false,
    earlyDeliverBufferingOnStop: !resolveStopWaitDebounce({ appData }),
    ackHintPolicy: "never",
  };
}

export function withLockFallback(run, fallback = {}) {
  try {
    return run();
  } catch (error) {
    if (error.code !== "FONS_POOL_LOCK") throw error;
    process.stderr.write("[FONS] 无法取得会话收件箱写入锁，已保留待办。\n");
    return fallback;
  }
}
