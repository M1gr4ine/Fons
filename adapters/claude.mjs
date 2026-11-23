import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isWorkspaceEnabled } from "../scripts/fons-config.mjs";
import { formatRetractedIdea } from "../scripts/fons-inbox.mjs";
import { executePoolEvent, extractAckTokensFromText } from "../scripts/fons-engine.mjs";
import {
  backfillConversationTitle, bindConversationTranscript, isValidSessionId, lookupConversation,
  markConversationLifecycle, readJson, registerConversation, sessionPaths, withPoolWrite, writeJsonAtomic,
} from "../scripts/fons-store.mjs";
import {
  START_SOURCES, absolutePath, asIdentifier, findMarkedWorkspace, formatDeliveredLine, hostAppData, matchesScope,
  matchesTranscriptAnchor, pathKey, standardPoolPolicy, withLockFallback,
} from "./shared.mjs";

const HOST = "claude";
const HOOK_EVENTS = new Set(["SessionStart", "UserPromptSubmit", "PostToolBatch", "Stop", "SessionEnd"]);
const MARKERS = [".agents", ".claude", ".git"];
const MAX_CONTEXT_CHARS = 10_000;
const TOKEN_PLACEHOLDER = "00000000";
const SESSION_START_CONTEXT =
  "本会话启用了 Fons 灵感池。处理完用户通过 Fons 补充的事项后，在回复最后一行写出 [FONS_ACK: 编号]（多个编号用英文逗号分隔）即视为已确认，Fons 会自动更新收件箱，无需手动编辑收件箱文件。";
const DELIVERY_HEADER = "用户在 Fons 灵感池补充了以下事项，编号用于回执：";
const STOP_HEADER = "Fons 灵感池中还有以下未确认的补充事项，编号用于回执：";
const RETRACTION_HEADER = "用户已从 Fons 灵感池撤回以下补充事项，无需再处理：";
const LINE_FORMAT_OPTIONS = {
  emptyNote: "附带以下参考文件",
  noWorkspaceHint: "；该附件位于无工作区目录",
};

export function claudeAppData(env = process.env, homeDir, cwd = process.cwd()) {
  return hostAppData("CLAUDE_CONFIG_DIR", ".claude", env, homeDir, cwd);
}

export function findClaudeWorkspace(cwd, homeDir) {
  return findMarkedWorkspace(cwd, MARKERS, homeDir);
}

export function isMainTranscriptPath(transcriptPath, sessionId) {
  if (!transcriptPath) return false;
  if (path.basename(transcriptPath).toLowerCase() !== (sessionId + ".jsonl").toLowerCase()) return false;
  const segments = path.dirname(transcriptPath).split(/[\\/]+/).map((part) => part.toLowerCase());
  return !segments.includes("subagents");
}

function hookContextOutput(eventName, additionalContext) {
  return { hookSpecificOutput: { hookEventName: eventName, additionalContext } };
}

function updateExistingStart(input, scopeMode, context, existing) {
  if (existing.host !== HOST || !matchesScope(scopeMode, existing.scope)) return {};
  if (existing.scope === "workspace" && !isWorkspaceEnabled({ appData: context.appData, rootDir: existing.rootDir })) return {};
  const sameAnchor = pathKey(context.transcriptPath) === pathKey(existing.transcriptPath);
  if (input.source !== "resume") {
    return sameAnchor ? hookContextOutput("SessionStart", SESSION_START_CONTEXT) : {};
  }
  if (!sameAnchor) {
    withPoolWrite({ ...existing, sessionId: context.sessionId }, () => {
      bindConversationTranscript({
        ...context, expectedTranscriptPath: existing.transcriptPath, host: HOST,
      });
    });
  }
  markConversationLifecycle({ ...context, host: HOST, endedAt: null });
  return hookContextOutput("SessionStart", SESSION_START_CONTEXT);
}

function registerStart(input, scopeMode, context) {
  if (!START_SOURCES.has(input.source) || !isMainTranscriptPath(context.transcriptPath, context.sessionId)) return {};
  const existing = lookupConversation(context);
  if (existing) return updateExistingStart(input, scopeMode, context, existing);
  const startDir = process.env.CLAUDE_PROJECT_DIR?.trim() || input.cwd;
  const rootDir = findClaudeWorkspace(startDir);
  const scope = rootDir ? "workspace" : "no-workspace";
  if (!matchesScope(scopeMode, scope)) return {};
  if (scope === "workspace" && !isWorkspaceEnabled({ appData: context.appData, rootDir })) return {};
  registerConversation({ ...context, rootDir, scope, host: HOST, title: input.session_title });
  return hookContextOutput("SessionStart", SESSION_START_CONTEXT);
}

function clampText(text, maxLength) {
  if (text.length <= maxLength) return text;
  if (maxLength <= 1) return "…".slice(0, Math.max(0, maxLength));
  return text.slice(0, maxLength - 1) + "…";
}

function deliveryHeading(kind) {
  return kind === "continue" || kind === "stop" ? STOP_HEADER : DELIVERY_HEADER;
}

function formatDeliveryEntry(item, index, paths, scope) {
  const body = formatDeliveredLine(item, paths, { ...LINE_FORMAT_OPTIONS, scope });
  return (index + 1) + ". " + body + " [FONS:" + (item.ackToken ?? TOKEN_PLACEHOLDER) + "]";
}

function formatSingleDelivery(item, paths, scope, budget) {
  const prefix = "1. ";
  const suffix = " [FONS:" + item.ackToken + "]";
  const body = formatDeliveredLine(item, paths, { ...LINE_FORMAT_OPTIONS, scope });
  const maxBody = Math.max(0, budget - prefix.length - suffix.length);
  return prefix + clampText(body, maxBody) + suffix;
}

function countFitting(lengths, budget) {
  let count = 0;
  let used = 0;
  for (const length of lengths) {
    const needed = (count ? 1 : 0) + length;
    if (used + needed > budget) break;
    count += 1;
    used += needed;
  }
  return { count, used };
}

function limitBatchForContext({ kind, items, retractions, ui }, paths, { scope, sessionId }) {
  const retractionLengths = retractions.map(([, entry]) => formatRetractedIdea(entry.text, sessionId).length);
  const retractionBudget = MAX_CONTEXT_CHARS - RETRACTION_HEADER.length - 1;
  const fittedRetractions = countFitting(retractionLengths, retractionBudget);
  if (retractions.length && fittedRetractions.count === 0) {
    return { items: [], retractions: retractions.slice(0, 1) };
  }
  if (fittedRetractions.count < retractions.length) {
    return { items: [], retractions: retractions.slice(0, fittedRetractions.count) };
  }
  const usedByRetractions = fittedRetractions.count
    ? RETRACTION_HEADER.length + 1 + fittedRetractions.used + 2
    : 0;
  const itemBudget = MAX_CONTEXT_CHARS - usedByRetractions - deliveryHeading(kind).length - 1;
  const itemLengths = items.map((item, index) =>
    formatDeliveryEntry({ ...item, readded: Boolean(ui.retracted?.[item.id]) }, index, paths, scope).length
  );
  let itemCount = itemBudget > 0 ? countFitting(itemLengths, itemBudget).count : 0;
  if (items.length && itemCount === 0 && fittedRetractions.count === 0) itemCount = 1;
  return {
    items: items.slice(0, itemCount),
    retractions: retractions.slice(0, fittedRetractions.count),
  };
}

function formatMessages(result, paths, { scope, sessionId }) {
  const sections = [];
  let remaining = MAX_CONTEXT_CHARS;
  if (result.retractions.length) {
    const header = RETRACTION_HEADER + "\n";
    const text = result.retractions.map((item) => formatRetractedIdea(item, sessionId)).join("\n");
    const section = header + clampText(text, remaining - header.length);
    sections.push(section);
    remaining -= section.length;
  }
  if (result.deliveries.length) {
    const separator = sections.length ? 2 : 0;
    const heading = deliveryHeading(result.kind) + "\n";
    const bodyBudget = Math.max(0, remaining - separator - heading.length);
    const lines = result.deliveries.length === 1
      ? [formatSingleDelivery(result.deliveries[0], paths, scope, bodyBudget)]
      : result.deliveries.map((item, index) => formatDeliveryEntry(item, index, paths, scope));
    sections.push(heading + lines.join("\n"));
  }
  return sections.join("\n\n");
}

function encodeResult(result, eventName, paths, context) {
  if (result.kind === "allow") return {};
  const message = formatMessages(result, paths, context);
  if (!message) return {};
  return hookContextOutput(eventName, message);
}

function stopAcknowledgment(lastMessage, turnId) {
  if (typeof lastMessage !== "string" || !lastMessage.trim()) return undefined;
  const digest = crypto.createHash("sha256").update(lastMessage, "utf8").digest("hex");
  return {
    message: { promptId: turnId ?? null, digest },
    tokens: extractAckTokensFromText(lastMessage),
  };
}

function poolEvent(input, paths) {
  const explicitPromptId = asIdentifier(input.prompt_id);
  if (input.hook_event_name === "Stop") {
    const turnId = explicitPromptId ?? asIdentifier(readJson(paths.state).lastPromptId) ?? undefined;
    return {
      kind: "stop",
      turnId,
      continuationActive: input.stop_hook_active === true,
      acknowledgment: stopAcknowledgment(input.last_assistant_message, turnId),
    };
  }
  const event = { kind: "delivery", turnId: explicitPromptId };
  if (explicitPromptId) event.rememberPromptId = explicitPromptId;
  return event;
}

function syncEmptyInboxPromptId(context, paths, promptId) {
  if (!fs.existsSync(paths.state)) return;
  if (asIdentifier(readJson(paths.state).lastPromptId) === promptId) return;
  withPoolWrite(context, () => {
    if (!fs.existsSync(paths.state)) return;
    const state = readJson(paths.state);
    if (asIdentifier(state.lastPromptId) === promptId) return;
    if (promptId) state.lastPromptId = promptId;
    else delete state.lastPromptId;
    writeJsonAtomic(paths.state, state);
  });
}

function handlePoolHook(input, context) {
  if (context.scope === "workspace" && !isWorkspaceEnabled({ appData: context.appData, rootDir: context.rootDir })) return {};
  const eventName = input.hook_event_name;
  if (eventName === "UserPromptSubmit") backfillConversationTitle({ ...context, title: input.prompt });
  const paths = sessionPaths(context);
  const inbox = fs.statSync(paths.ideas, { throwIfNoEntry: false });
  if (!inbox?.size && !fs.existsSync(paths.retractMarker)) {
    if (eventName === "UserPromptSubmit") syncEmptyInboxPromptId(context, paths, asIdentifier(input.prompt_id));
    return {};
  }
  const event = poolEvent(input, paths);
  const policy = {
    ...standardPoolPolicy({ appData: context.appData }),
    limitBatch: (batch) => limitBatchForContext(batch, paths, context),
  };
  const result = executePoolEvent(context, { ...event, transcriptPath: context.transcriptPath }, policy);
  return encodeResult(result, eventName, paths, context);
}

function applyHook(input, scopeMode) {
  const { hook_event_name: eventName, agent_id: agentId, session_id: sessionId } = input;
  if (!HOOK_EVENTS.has(eventName) || agentId || !isValidSessionId(sessionId)) return {};
  const context = { appData: claudeAppData(), sessionId, transcriptPath: absolutePath(input.transcript_path) };
  if (eventName === "SessionStart") return registerStart(input, scopeMode, context);
  const entry = lookupConversation(context);
  if (!matchesTranscriptAnchor({ entry, context, scopeMode, host: HOST })) return {};
  if (eventName === "SessionEnd") {
    markConversationLifecycle({ ...context, host: HOST, endedAt: Date.now() });
    return {};
  }
  return handlePoolHook(input, { ...context, ...entry });
}

export function evaluateClaudeHook(input, scopeMode) {
  return withLockFallback(() => applyHook(input, scopeMode));
}
