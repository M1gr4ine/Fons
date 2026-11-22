import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalPath, resolveStopWaitDebounce } from "../scripts/fons-config.mjs";

export function absolutePath(value) {
  if (typeof value !== "string" || value.includes("\0") || !path.isAbsolute(value)) return null;
  return canonicalPath(value);
}

export function pathKey(value) {
  if (process.platform === "win32") return value?.toLowerCase() ?? null;
  return value;
}

export function findMarkedWorkspace(cwd, markers, homeDir = os.homedir()) {
  const home = pathKey(absolutePath(homeDir));
  let directory = absolutePath(cwd);
  while (directory) {
    const parent = path.dirname(directory);
    if (directory === parent || pathKey(directory) === home) break;
    if (markers.some((marker) => fs.existsSync(path.join(directory, marker)))) return directory;
    directory = parent;
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
  const backticks = String.fromCharCode(96);
  const runs = filename.match(/\x60+/g) ?? [];
  const delimiter = backticks.repeat(1 + Math.max(0, ...runs.map((run) => run.length)));
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

export function standardPoolPolicy({ appData = null, env = process.env } = {}) {
  return {
    rotateTokenOnStopRetry: false,
    earlyDeliverBufferingOnStop: !resolveStopWaitDebounce({ appData, env }),
    ackHintPolicy: "never",
    editingHoldPolicy: "always",
  };
}

export function withLockFallback(run) {
  try {
    return run();
  } catch (error) {
    if (error.code !== "FONS_POOL_LOCK") throw error;
    process.stderr.write("[FONS] 无法取得会话收件箱写入锁，已保留待办。\n");
    return {};
  }
}
