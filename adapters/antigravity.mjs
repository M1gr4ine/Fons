import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  hasLocalWorkspaceFonsPlugin, isWorkspaceEnabled, resolveStopWaitDebounce,
} from "../scripts/fons-config.mjs";
import { formatRetractedIdea } from "../scripts/fons-inbox.mjs";
import {
  findAppData, isValidSessionId, noWorkspaceFonsDir, readJson, registerConversation, sessionPaths,
} from "../scripts/fons-store.mjs";
import { executePoolEvent, extractAckTokensFromText } from "../scripts/fons-engine.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const HOOK_EVENTS = new Set(["PreInvocation", "SessionStart", "Stop"]);
const UNREADABLE_LOG = new Set(["ENOENT", "ENOTDIR", "EACCES", "EPERM", "EISDIR"]);
const NO_WORKSPACE_PRE_HEADER = "[FONS] 完成后末行附 [FONS_ACK: 编号]";
const STOP_HEADER = "[FONS 收尾核对] 以下补充待处理（完成后在回复末行附 [FONS_ACK: 编号]）：";

function tryParseJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function readJsonLines(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (UNREADABLE_LOG.has(err?.code)) return [];
    throw err;
  }
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map(tryParseJson)
    .filter((entry) => entry !== null);
}

function isCompletedResponse(entry) {
  return entry?.type === "PLANNER_RESPONSE" && entry.source === "MODEL" &&
    entry.status === "DONE" && !entry.tool_calls?.length;
}

function resolveResponseContent(transcriptPath, response) {
  if (!response.truncated_fields?.includes("content")) {
    return typeof response.content === "string" ? response.content : "";
  }
  if (!Number.isInteger(response.step_index)) return "";

  const fullPath = path.join(path.dirname(transcriptPath), "transcript_full.jsonl");
  const fullResponse = readJsonLines(fullPath).findLast((entry) =>
    isCompletedResponse(entry) && entry.step_index === response.step_index &&
    entry.created_at === response.created_at && !entry.truncated_fields?.includes("content")
  );
  const content = fullResponse?.content;
  return typeof content === "string" ? content : "";
}

function readTurnAcknowledgments(transcriptPath, statePath) {
  if (!transcriptPath || !Object.keys(readJson(statePath).delivered ?? {}).length) return new Set();
  const steps = readJsonLines(transcriptPath);
  const userIndex = steps.findLastIndex((step) => step?.type === "USER_INPUT");
  if (userIndex < 0) return new Set();

  const response = steps.slice(userIndex + 1).findLast((step) => step?.type === "PLANNER_RESPONSE");
  if (!isCompletedResponse(response)) return new Set();

  return extractAckTokensFromText(resolveResponseContent(transcriptPath, response));
}

function toSlashPath(filePath) {
  return path.resolve(filePath).replace(/\\/g, "/");
}

function mirrorAttachment(sourcePath, mirrorPath) {
  if (fs.existsSync(mirrorPath)) return;
  fs.mkdirSync(path.dirname(mirrorPath), { recursive: true });
  try {
    fs.linkSync(sourcePath, mirrorPath);
  } catch (err) {
    if (!["EXDEV", "EPERM", "EACCES", "ENOSYS"].includes(err?.code)) throw err;
    fs.copyFileSync(sourcePath, mirrorPath);
  }
}

function prepareAttachmentMirrors(deliveries, { sourceDir, mirrors }, mirrorDir) {
  const storedNames = new Set(deliveries.flatMap(({ attachments }) => attachments.map(({ storedName }) => storedName)));
  for (const storedName of storedNames) {
    const sourcePath = path.join(sourceDir, storedName);
    if (!fs.existsSync(sourcePath)) continue;
    const mirrorPath = path.join(mirrorDir, storedName);
    mirrorAttachment(sourcePath, mirrorPath);
    mirrors.set(storedName, mirrorPath);
  }
}

function formatDeliveredLine(item, { sourceDir, mirrors }) {
  const { text, note, attachments, readded } = item;
  const suffix = readded ? "（重新添加）" : "";
  if (!attachments.length) return text + suffix;
  const paths = attachments.map(({ storedName }) => toSlashPath(mirrors.get(storedName) ?? path.join(sourceDir, storedName)));
  return (note || "请结合附件处理") + suffix + "（附件: " + paths.join(", ") + "）";
}

function formatMessages(result, attachmentPaths, sessionId) {
  const messages = [];
  if (result.retractions.length) {
    const text = result.retractions.map((retracted) => formatRetractedIdea(retracted, sessionId)).join("\n");
    messages.push("[FONS 撤回] 用户已撤回以下补充，若尚未执行请跳过：\n" + text);
  }
  if (result.deliveries.length) {
    const deliveryHeader = result.sendAckHint ? NO_WORKSPACE_PRE_HEADER : "[FONS]";
    const header = result.kind === "continue" ? STOP_HEADER : deliveryHeader;
    const numbered = result.deliveries.map((item, index) =>
      (index + 1) + ". " + formatDeliveredLine(item, attachmentPaths) + " [FONS:" + item.ackToken + "]"
    ).join("\n");
    messages.push(header + "\n" + numbered);
  }
  return messages.join("\n\n");
}

function encodeResult(result, attachmentPaths, sessionId) {
  if (result.kind === "allow") return { decision: "allow" };
  const message = formatMessages(result, attachmentPaths, sessionId);
  if (result.kind === "continue") return { decision: "continue", reason: message };
  if (!message) return {};
  return { injectSteps: [{ systemMessage: { systemMessage: message } }] };
}

function resolveAppData(input) {
  return findAppData(input.transcriptPath, "brain") || findAppData(input.artifactDirectoryPath, "brain");
}

function resolveArtifactDir(input) {
  return typeof input.artifactDirectoryPath === "string" && input.artifactDirectoryPath.trim()
    ? path.resolve(input.artifactDirectoryPath)
    : null;
}

function workspaceHasLocalPlugin(resolvedRoot, workspacePaths) {
  const candidates = [resolvedRoot];
  if (Array.isArray(workspacePaths)) {
    for (const dir of workspacePaths) {
      if (typeof dir === "string" && dir.trim()) candidates.push(path.resolve(dir));
    }
  }
  return candidates.some((dir) => hasLocalWorkspaceFonsPlugin(dir, REPO_ROOT));
}

function resolveHookContext(input, scopeMode) {
  if (!isValidSessionId(input.conversationId)) return null;
  const artifactDir = resolveArtifactDir(input);
  const isNoWorkspace = Array.isArray(input.workspacePaths) ? input.workspacePaths.length === 0 : !input.cwd;
  if (isNoWorkspace) {
    if (scopeMode === "workspace") return null;
    const appData = resolveAppData(input);
    if (!appData) return null;
    return {
      scope: "no-workspace",
      rootDir: null,
      fonsDir: noWorkspaceFonsDir(appData),
      appData,
      artifactDir,
      sessionId: input.conversationId,
      needsAckHint: true,
    };
  }
  if (scopeMode === "no-workspace") return null;
  const rootDir = input.cwd || input.workspacePaths?.[0];
  if (!rootDir) return null;
  const resolvedRoot = path.resolve(rootDir);
  const appData = resolveAppData(input);
  const localPlugin = workspaceHasLocalPlugin(resolvedRoot, input.workspacePaths);
  if (scopeMode === "global" && localPlugin) return null;
  if (appData && !isWorkspaceEnabled({ appData, rootDir: resolvedRoot, localPlugin })) return null;
  return {
    scope: "workspace",
    rootDir: resolvedRoot,
    appData,
    artifactDir,
    sessionId: input.conversationId,
    needsAckHint: scopeMode === "global",
  };
}

function shouldRunPoolEvent(paths, event) {
  const inbox = fs.statSync(paths.ideas, { throwIfNoEntry: false });
  return inbox?.size || (event === "PreInvocation" && fs.existsSync(paths.retractMarker));
}

function preparePoolEvent(input, paths) {
  if (input.hookEventName !== "Stop") return { kind: "delivery" };
  return {
    kind: "stop",
    continuationActive: input.continuationActive,
    ackTokens: readTurnAcknowledgments(input.transcriptPath, paths.state),
  };
}

function handleSessionEvent(input, context, fallback) {
  const paths = sessionPaths(context);
  const event = input.hookEventName;
  if (event !== "Stop" && context.appData) {
    registerConversation({ ...context, title: input.lastUserInput });
  }
  if (event === "SessionStart" || !shouldRunPoolEvent(paths, event)) return fallback;

  const request = preparePoolEvent(input, paths);
  const policy = {
    rotateTokenOnStopRetry: true,
    earlyDeliverBufferingOnStop: !resolveStopWaitDebounce({ appData: context.appData }),
    ackHintPolicy: context.needsAckHint ? "once" : "never",
  };
  const attachmentPaths = { sourceDir: paths.attachmentsDir, mirrors: new Map() };
  const mirrorDir = context.scope === "no-workspace" && context.artifactDir
    ? path.join(context.artifactDir, "fons-attachments")
    : null;
  const prepareDeliveries = mirrorDir
    ? (deliveries) => prepareAttachmentMirrors(deliveries, attachmentPaths, mirrorDir)
    : undefined;
  const result = executePoolEvent(context, request, policy, prepareDeliveries);
  return encodeResult(result, attachmentPaths, context.sessionId);
}

export function evaluateAntigravityHook(input, scopeMode) {
  const event = input.hookEventName;
  const fallback = event === "Stop" ? { decision: "allow" } : {};
  if (!HOOK_EVENTS.has(event)) return fallback;
  if (event === "Stop" && (input.terminationReason !== "NO_TOOL_CALL" || input.fullyIdle === false)) return fallback;
  const context = resolveHookContext(input, scopeMode);
  if (!context) return fallback;
  return handleSessionEvent(input, context, fallback);
}
