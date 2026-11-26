import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hasLocalWorkspaceFonsPlugin, isWorkspaceEnabled } from "../scripts/fons-config.mjs";
import { formatRetractedIdea } from "../scripts/fons-inbox.mjs";
import {
  findAppData, isValidSessionId, noWorkspaceFonsDir, readJson, registerConversation, sessionPaths,
} from "../scripts/fons-store.mjs";
import { executePoolEvent, extractAckTokensFromText } from "../scripts/fons-engine.mjs";
import {
  UNREADABLE_LOG, asIdentifier, matchesScope, standardPoolPolicy, withLockFallback,
} from "./shared.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const HOOK_EVENTS = new Set(["PreInvocation", "SessionStart", "Stop"]);
const NO_WORKSPACE_PRE_HEADER = "[FONS] 完成后末行附 [FONS_ACK: 编号]";
const STOP_HEADER = "[FONS 收尾核对] 以下补充待处理（完成后在回复末行附 [FONS_ACK: 编号]）：";
const RETRACTION_HEADER = "[FONS 撤回] 用户已撤回以下补充，若尚未执行请跳过：";
const PRE_INJECTION_MARKER = /^The following system message was injected by a PreInvocation hook:\r?\n/;
const STOP_INJECTION_MARKER = "Stop hook blocked termination: ";
const DELIVERY_ITEM_TOKEN = /^\d+\. .+ \[FONS:([a-f0-9]{8})\]$/s;
const SYSTEM_TAG_OPEN = /^(?:The following is a <SYSTEM_MESSAGE>[^\r\n]*\r?\n\r?\n)?<SYSTEM_MESSAGE>\r?\n/;
const SYSTEM_TAG_CLOSE = /\r?\n<\/SYSTEM_MESSAGE>\s*$/;

function tryParseJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function readJsonLines(filePath) {
  if (!filePath) return [];
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (UNREADABLE_LOG.has(err.code)) return [];
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

function isDeliverySystemStep(entry) {
  return entry?.type === "SYSTEM_MESSAGE" && entry.status === "DONE" &&
    (entry.source === "SYSTEM_SDK" || entry.source === "SYSTEM");
}

function indexFullSteps(transcriptPath) {
  const byIndex = new Map();
  for (const step of readJsonLines(path.join(path.dirname(transcriptPath), "transcript_full.jsonl"))) {
    if (!isDeliverySystemStep(step) && !isCompletedResponse(step)) continue;
    if (step.truncated_fields?.includes("content")) continue;
    const entries = byIndex.get(step.step_index) ?? [];
    entries.push(step);
    byIndex.set(step.step_index, entries);
  }
  return byIndex;
}

function createStepContentReader(transcriptPath) {
  let byIndex;
  return (step) => {
    let content = step.content;
    if (step.truncated_fields?.includes("content")) {
      if (!Number.isInteger(step.step_index)) return "";
      byIndex ??= indexFullSteps(transcriptPath);
      const entry = byIndex.get(step.step_index)?.findLast((candidate) =>
        candidate.source === step.source && candidate.type === step.type && candidate.created_at === step.created_at
      );
      content = entry?.content;
    }
    return typeof content === "string" ? content : "";
  };
}

function unwrapSystemPayload(content, source) {
  const open = SYSTEM_TAG_OPEN.exec(content);
  let body = content;
  if (open) {
    const afterOpen = content.slice(open[0].length);
    const close = SYSTEM_TAG_CLOSE.exec(afterOpen);
    if (!close) return null;
    body = afterOpen.slice(0, close.index);
  }
  if (source === "SYSTEM_SDK") {
    const match = PRE_INJECTION_MARKER.exec(body);
    return match ? body.slice(match[0].length) : null;
  }
  return body.startsWith(STOP_INJECTION_MARKER) ? body.slice(STOP_INJECTION_MARKER.length) : null;
}

function isDeliveryHeader(line, source) {
  if (source === "SYSTEM_SDK") return line === "[FONS]" || line === NO_WORKSPACE_PRE_HEADER;
  return line === STOP_HEADER;
}

function extractDeliveryTokens(content, source) {
  const payload = unwrapSystemPayload(content, source);
  if (!payload) return [];
  const [first, second = ""] = payload.split(/\r?\n\r?\n/, 2);
  const delivery = first.startsWith(RETRACTION_HEADER) ? second : first;
  const [header, ...rows] = delivery.split(/\r?\n/);
  if (!isDeliveryHeader(header, source)) return [];
  return rows.map((line) => DELIVERY_ITEM_TOKEN.exec(line)?.[1]).filter(Boolean);
}

function deliveredAckTokens(statePath) {
  const delivered = readJson(statePath).delivered ?? {};
  return new Set(Object.values(delivered).map((entry) => entry?.ackToken).filter(Boolean));
}

function indexDeliveryAnchors(steps, pendingTokens, readContent) {
  const anchors = new Map();
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!isDeliverySystemStep(step)) continue;
    for (const token of extractDeliveryTokens(readContent(step), step.source)) {
      if (pendingTokens.has(token)) anchors.set(token, i);
    }
  }
  return anchors;
}

function readUnanchoredTurnTokens(steps, readContent) {
  const userIndex = steps.findLastIndex((step) => step?.type === "USER_INPUT");
  if (userIndex < 0) return new Set();
  const response = steps.slice(userIndex + 1).findLast((step) => step?.type === "PLANNER_RESPONSE");
  if (!isCompletedResponse(response)) return new Set();
  return extractAckTokensFromText(readContent(response));
}

function readAnchoredTokens(steps, anchors, readContent) {
  const found = new Set();
  const earliest = Math.min(...anchors.values());
  for (let i = earliest + 1; i < steps.length && found.size < anchors.size; i++) {
    const step = steps[i];
    if (!isCompletedResponse(step)) continue;
    for (const token of extractAckTokensFromText(readContent(step))) {
      if (anchors.has(token) && i > anchors.get(token)) found.add(token);
    }
  }
  return found;
}

function readAcknowledgments(transcriptPath, statePath) {
  if (!transcriptPath) return new Set();
  const pendingTokens = deliveredAckTokens(statePath);
  if (!pendingTokens.size) return new Set();

  const steps = readJsonLines(transcriptPath);
  const readContent = createStepContentReader(transcriptPath);
  const anchors = indexDeliveryAnchors(steps, pendingTokens, readContent);
  const found = readAnchoredTokens(steps, anchors, readContent);
  if (anchors.size === pendingTokens.size) return found;
  for (const token of readUnanchoredTurnTokens(steps, readContent)) {
    if (pendingTokens.has(token) && !anchors.has(token)) found.add(token);
  }
  return found;
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
    messages.push(RETRACTION_HEADER + "\n" + text);
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
  const dir = asIdentifier(input.artifactDirectoryPath);
  return dir ? path.resolve(dir) : null;
}

function workspaceHasLocalPlugin(resolvedRoot, workspacePaths) {
  const candidates = [resolvedRoot];
  if (Array.isArray(workspacePaths)) {
    for (const dir of workspacePaths) {
      if (asIdentifier(dir)) candidates.push(path.resolve(dir));
    }
  }
  return candidates.some((dir) => hasLocalWorkspaceFonsPlugin(dir, REPO_ROOT));
}

function resolveHookContext(input, scopeMode) {
  if (!isValidSessionId(input.conversationId)) return null;
  const artifactDir = resolveArtifactDir(input);
  const isNoWorkspace = Array.isArray(input.workspacePaths) ? input.workspacePaths.length === 0 : !asIdentifier(input.cwd);
  if (isNoWorkspace) {
    if (!matchesScope(scopeMode, "no-workspace")) return null;
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
  if (!matchesScope(scopeMode, "workspace")) return null;
  const rootDir = asIdentifier(input.cwd) || asIdentifier(input.workspacePaths?.[0]);
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
  const ackTokens = readAcknowledgments(input.transcriptPath, paths.state);
  if (input.hookEventName !== "Stop") return { kind: "delivery", ackTokens };
  return {
    kind: "stop",
    settleOnly: input.fullyIdle === false,
    continuationActive: input.continuationActive,
    ackTokens,
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
  if (request.settleOnly && !request.ackTokens.size) return fallback;
  const policy = {
    ...standardPoolPolicy({ appData: context.appData }),
    rotateTokenOnStopRetry: true,
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
  if (event === "Stop" && input.terminationReason !== "NO_TOOL_CALL") return fallback;
  const context = resolveHookContext(input, scopeMode);
  if (!context) return fallback;
  return withLockFallback(() => handleSessionEvent(input, context, fallback), fallback);
}
