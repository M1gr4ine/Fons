import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { splitIdeaText } from "./fons-inbox.mjs";
import {
  completeAcknowledgedIdeas, computeDebounce, findAppData, isValidSessionId, migrateLegacyInbox,
  noWorkspaceFonsDir, readJson, readPoolData, registerConversation, sessionPaths, withPoolWrite,
  writeJsonAtomic,
} from "./fons-store.mjs";

const MAX_STOP_CONTINUES = 2;
const ACK_TAG = "\\[FONS_ACK[:：][ \\t]*[a-f0-9]{8}(?:(?:[ \\t]*[,，][ \\t]*|[ \\t]+)[a-f0-9]{8})*\\]";
const ACK_LINE = new RegExp(`^[ \\t]*${ACK_TAG}(?:[ \\t]*[,，]?[ \\t]*${ACK_TAG})*[ \\t]*$`);
const ACK_TOKEN = /\b[a-f0-9]{8}\b/g;
const NO_WORKSPACE_PRE_HEADER = "[FONS] 完成后末行附 [FONS_ACK: 编号]";

function tryParseJson(line) {
  try {
    return JSON.parse(line);
  } catch (err) {
    // 忽略尚未写完或损坏的单行日志，避免阻塞 Stop 收尾判定
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

function readJsonLines(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err?.code) return [];
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

function readTurnAcknowledgments(transcriptPath) {
  const steps = readJsonLines(transcriptPath);
  const userIndex = steps.findLastIndex((step) => step?.type === "USER_INPUT");
  if (userIndex < 0) return new Set();

  const response = steps.slice(userIndex + 1).findLast((step) => step?.type === "PLANNER_RESPONSE");
  if (!isCompletedResponse(response)) return new Set();

  const content = resolveResponseContent(transcriptPath, response);
  const lines = content.trimEnd().split(/\r?\n/);
  const tokens = new Set();
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!ACK_LINE.test(lines[i])) break;
    for (const token of lines[i].match(ACK_TOKEN)) tokens.add(token);
  }
  return tokens;
}

function toSlashPath(filePath) {
  return path.resolve(filePath).replace(/\\/g, "/");
}

function resolveDeliveredAttachmentPath(storedName, data, context) {
  const sourcePath = path.join(data.paths.attachmentsDir, storedName);
  if (context.scope === "no-workspace" && context.artifactDir && fs.existsSync(sourcePath)) {
    const mirrorDir = path.join(context.artifactDir, "fons-attachments");
    const mirrorPath = path.join(mirrorDir, storedName);
    if (!fs.existsSync(mirrorPath)) {
      fs.mkdirSync(mirrorDir, { recursive: true });
      try {
        fs.linkSync(sourcePath, mirrorPath);
      } catch (err) {
        if (!["EXDEV", "EPERM", "EACCES", "ENOSYS"].includes(err?.code)) throw err;
        fs.copyFileSync(sourcePath, mirrorPath);
      }
    }
    return toSlashPath(mirrorPath);
  }
  return toSlashPath(sourcePath);
}

function formatDeliveredLine(text, data, context, withdrawn) {
  const { note, attachments } = splitIdeaText(text, context.sessionId);
  if (!attachments.length) {
    return withdrawn ? `${text}（重新添加）` : text;
  }
  const resolved = attachments.map((att) => resolveDeliveredAttachmentPath(att.storedName, data, context));
  const base = note || "请结合附件处理";
  const head = withdrawn ? `${base}（重新添加）` : base;
  return `${head}（附件: ${resolved.join(", ")}）`;
}

function markDelivered(items, data, context) {
  const { state, ui } = data;
  state.delivered ??= {};
  return items.map(({ id, text }, index) => {
    const ackToken = crypto.randomBytes(4).toString("hex");
    const withdrawn = ui.retracted?.[id];
    const deliveredAt = Math.max(Date.now(), (ui.reopened?.[id] ?? 0) + 1, (withdrawn?.ts ?? 0) + 1);
    state.delivered[id] = { text, deliveredAt, ackToken };
    const label = formatDeliveredLine(text, data, context, withdrawn);
    return `${index + 1}. ${label} [FONS:${ackToken}]`;
  }).join("\n");
}

function unnotified(ui, state) {
  return Object.entries(ui.retracted ?? {}).filter(([id, entry]) => (state.retractNotified?.[id] ?? -1) < entry.ts);
}

function formatRetractedLine(text, sessionId) {
  const { note, attachments } = splitIdeaText(text, sessionId);
  if (!attachments.length) return text;
  const names = attachments.map((att) => att.name).join(", ");
  return note ? `${note}（附件: ${names}）` : `[附件: ${names}]`;
}

function collectRetractions({ state, ui }, sessionId) {
  const retracted = unnotified(ui, state);
  if (!retracted.length) return "";
  state.retractNotified ??= {};
  for (const [id, entry] of retracted) state.retractNotified[id] = entry.ts;
  return "[FONS 撤回] 用户已撤回以下补充，若尚未执行请跳过：\n" +
    retracted.map(([, entry]) => formatRetractedLine(entry.text, sessionId)).join("\n");
}

function clearRetractionMarker({ paths, state }) {
  if (!fs.existsSync(paths.retractMarker)) return;
  fs.rmSync(paths.retractMarker, { force: true });
  // A panel can enqueue another withdrawal while this invocation publishes its ledger.
  if (unnotified(readJson(paths.ui), state).length) fs.closeSync(fs.openSync(paths.retractMarker, "a"));
}

function syncPendingLedger(state, pendingAt, deliveredIds) {
  const next = {};
  for (const [id, since] of Object.entries(pendingAt)) {
    if (!deliveredIds.has(id)) next[id] = since;
  }
  if (Object.keys(next).length) state.pendingAt = next;
  else delete state.pendingAt;
  delete state.pendingSig;
  delete state.pendingSigAt;
}

function handlePreInvocation(data, context) {
  const { ready, pendingAt } = computeDebounce(data);
  const { state } = data;
  const deliveredIds = new Set();
  const messages = [];
  if (ready.length) {
    const numbered = markDelivered(ready, data, context);
    for (const item of ready) deliveredIds.add(item.id);
    const sendHint = context.scope === "no-workspace" && !state.ackHintSent;
    if (sendHint) state.ackHintSent = true;
    const header = sendHint ? NO_WORKSPACE_PRE_HEADER : "[FONS]";
    messages.push(header + "\n" + numbered);
  }
  syncPendingLedger(state, pendingAt, deliveredIds);
  const retracted = collectRetractions(data, context.sessionId);
  if (retracted) messages.unshift(retracted);
  if (!messages.length) return {};
  return { injectSteps: [{ systemMessage: { systemMessage: messages.join("\n\n") } }] };
}

function settleAcknowledged(items, data, tokens) {
  const { state } = data;
  const confirmed = items.filter(({ id, status }) => status === "delivered" && tokens.has(state.delivered[id].ackToken));
  if (!confirmed.length) return items;

  const ids = new Set(confirmed.map(({ id }) => id));
  if (!completeAcknowledgedIdeas(data, ids)) {
    state.acknowledged ??= {};
    for (const id of ids) {
      state.acknowledged[id] = { at: state.delivered[id].deliveredAt };
    }
  }
  for (const id of ids) delete state.delivered[id];
  return items.filter(({ id }) => !ids.has(id));
}

function handleStop(input, data, tokens, context) {
  const { state, ui, items } = data;
  const timing = computeDebounce(data);
  const open = items.filter((item) => {
    if (item.status === "done") return false;
    return !(item.status === "buffering" && timing.byId.get(item.id)?.editingHold);
  });
  const distinct = new Map(open.map((item) => [item.id, item]));
  const remaining = settleAcknowledged([...distinct.values()], data, tokens);
  if (!remaining.length) {
    syncPendingLedger(state, timing.pendingAt, new Set());
    return { decision: "allow" };
  }

  const signature = remaining.map(({ id }) => {
    const withdrawn = ui.retracted?.[id];
    return withdrawn ? `${id}@${withdrawn.ts}` : id;
  }).sort().join(",");
  const previousCount = state.stopCount ?? 0;
  const count = input.continuationActive ? previousCount : 0;
  if (count >= MAX_STOP_CONTINUES || (input.continuationActive && state.lastStopSig === signature)) {
    syncPendingLedger(state, timing.pendingAt, new Set());
    return { decision: "allow" };
  }
  state.lastStopSig = signature;
  state.stopCount = count + 1;
  if (context.scope === "no-workspace") state.ackHintSent = true;
  const numbered = markDelivered(remaining, data, context);
  syncPendingLedger(state, timing.pendingAt, new Set(remaining.map((item) => item.id)));
  const reminder = "[FONS 收尾核对] 以下补充待处理（完成后在回复末行附 [FONS_ACK: 编号]）：\n" + numbered;
  const reason = [collectRetractions(data, context.sessionId), reminder].filter(Boolean).join("\n\n");
  return { decision: "continue", reason };
}

function resolveAppData(input) {
  return findAppData(input.transcriptPath, "brain") || findAppData(input.artifactDirectoryPath, "brain");
}

function resolveArtifactDir(input) {
  return typeof input.artifactDirectoryPath === "string" && input.artifactDirectoryPath.trim()
    ? path.resolve(input.artifactDirectoryPath)
    : null;
}

function parseScope(argv) {
  let scope = "all";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--scope=")) scope = arg.slice("--scope=".length);
    else if (arg === "--scope") scope = argv[++i] ?? "";
  }
  if (!["all", "workspace", "no-workspace"].includes(scope)) {
    throw new Error(`无效的 Hook 作用域：${scope}`);
  }
  return scope;
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
    };
  }
  if (scopeMode === "no-workspace") return null;
  const rootDir = input.cwd || input.workspacePaths?.[0];
  if (!rootDir) return null;
  return {
    scope: "workspace",
    rootDir: path.resolve(rootDir),
    appData: resolveAppData(input),
    artifactDir,
    sessionId: input.conversationId,
  };
}

function handleSessionEvent(input, context, fallback) {
  const paths = sessionPaths(context);
  if (context.scope === "workspace" && fs.existsSync(path.join(paths.fonsDir, "ideas.md"))) {
    migrateLegacyInbox(context);
  }
  const event = input.hookEventName;
  if (event !== "Stop" && context.appData) {
    registerConversation({ ...context, title: input.lastUserInput });
  }
  if (event === "SessionStart") return fallback;
  const inbox = fs.statSync(paths.ideas, { throwIfNoEntry: false });
  const retraction = event === "PreInvocation" && fs.existsSync(paths.retractMarker);
  if (!inbox?.size && !retraction) return fallback;

  const tokens = event === "Stop" ? readTurnAcknowledgments(input.transcriptPath) : null;
  return withPoolWrite(context, () => {
    const data = readPoolData(context);
    const before = JSON.stringify(data.state);
    const result = event === "Stop" ? handleStop(input, data, tokens, context) : handlePreInvocation(data, context);
    if (JSON.stringify(data.state) !== before) writeJsonAtomic(paths.state, data.state);
    if (retraction || result.decision === "continue") clearRetractionMarker(data);
    return result;
  });
}

export function evaluateHook(input, scopeMode = "all") {
  const event = input.hookEventName;
  const fallback = event === "Stop" ? { decision: "allow" } : {};
  if (!["PreInvocation", "SessionStart", "Stop"].includes(event)) return fallback;
  if (event === "Stop" && (input.terminationReason !== "NO_TOOL_CALL" || input.fullyIdle === false)) return fallback;
  const context = resolveHookContext(input, scopeMode);
  if (!context) return fallback;
  return handleSessionEvent(input, context, fallback);
}

export function runMain(argv = process.argv.slice(2)) {
  const scopeMode = parseScope(argv);
  const rawInput = fs.readFileSync(0, "utf8");
  const input = rawInput ? JSON.parse(rawInput) : {};
  process.stdout.write(JSON.stringify(evaluateHook(input, scopeMode)));
}

function isMainModule() {
  if (typeof import.meta.main === "boolean") return import.meta.main;
  if (!process.argv[1]) return false;
  return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  runMain();
}
