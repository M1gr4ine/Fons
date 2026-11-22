import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { formatRetractedIdea } from "../scripts/fons-inbox.mjs";
import { isWorkspaceEnabled } from "../scripts/fons-config.mjs";
import { executePoolEvent, extractAckTokensFromText } from "../scripts/fons-engine.mjs";
import {
  backfillConversationTitle, bindConversationTranscript, isValidSessionId, lookupConversation, readJson,
  registerConversation, sessionPaths, withPoolWrite,
} from "../scripts/fons-store.mjs";
import {
  START_SOURCES, UNREADABLE_LOG, absolutePath, asIdentifier, findMarkedWorkspace, formatDeliveredLine, hostAppData,
  matchesScope, matchesTranscriptAnchor, pathKey, standardPoolPolicy, withLockFallback,
} from "./shared.mjs";

const HOST = "codex";
const HOOK_EVENTS = new Set(["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"]);
const START_EVENTS = new Set(["task_started", "turn_started"]);
const ABORT_EVENTS = new Set(["turn_aborted", "TurnAborted"]);
const INTERRUPTED = new Set(["interrupted", "aborted", "user_interrupt", "user_interrupted", "turn_aborted"]);
const MARKERS = [".agents", ".codex", ".git"];
const LOG_BLOCK_BYTES = 64 * 1024;
const LOG_TAIL_BYTES = 4 * LOG_BLOCK_BYTES;
const MAX_RECORD_BYTES = 8 * 1024 * 1024;
const ACK_HINT = "[FONS] 完成后末行附 [FONS_ACK: 编号]（勿改收件箱文件）";
const STOP_HEADER = "[FONS 收尾核对] 以下补充待处理";
const RETRACTION_HEADER = "[FONS 撤回] 用户已撤回以下补充，若尚未执行请跳过：";

export function codexAppData(env = process.env, homeDir, cwd = process.cwd()) {
  return hostAppData("CODEX_HOME", ".codex", env, homeDir, cwd);
}

export function findCodexWorkspace(cwd, homeDir) {
  return findMarkedWorkspace(cwd, MARKERS, homeDir);
}

function readRollout(filePath, read) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const info = fs.fstatSync(fd, { bigint: true });
    if (!info.isFile()) return null;
    return read(fd, { size: Number(info.size), fileId: info.dev + ":" + info.ino });
  } catch (error) {
    if (UNREADABLE_LOG.has(error.code)) return null;
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function* readBlocks(fd, start, end) {
  const buffer = Buffer.allocUnsafe(LOG_BLOCK_BYTES);
  for (let offset = start; offset < end;) {
    const size = fs.readSync(fd, buffer, 0, Math.min(end - offset, buffer.length), offset);
    if (!size) break;
    yield { offset, bytes: buffer.subarray(0, size) };
    offset += size;
  }
}

function* newlineIndices(bytes) {
  let position = bytes.indexOf(10);
  while (position >= 0) {
    yield position;
    position = bytes.indexOf(10, position + 1);
  }
}

function* readRecords(fd, start, end) {
  let parts = [];
  let lineStart = start;
  for (const { offset, bytes } of readBlocks(fd, start, end)) {
    let index = 0;
    for (const newline of newlineIndices(bytes)) {
      const byteOffset = offset + newline + 1;
      if (byteOffset - lineStart <= MAX_RECORD_BYTES) {
        const part = bytes.subarray(index, newline);
        const line = parts.length ? Buffer.concat([...parts, part]) : part;
        yield { line, lineStart, byteOffset };
      }
      parts = [];
      lineStart = byteOffset;
      index = newline + 1;
    }
    if (index < bytes.length && offset + bytes.length - lineStart < MAX_RECORD_BYTES) {
      parts.push(Buffer.from(bytes.subarray(index)));
    }
  }
}

function parseRecord(line) {
  try {
    return JSON.parse(line.toString("utf8"));
  } catch {
    return null;
  }
}

function readSessionHeader(filePath) {
  if (!filePath) return null;
  return readRollout(filePath, (fd, { size }) => {
    const first = readRecords(fd, 0, Math.min(size, MAX_RECORD_BYTES)).next().value;
    if (!first) return null;
    const record = parseRecord(first.line);
    if (record?.type !== "session_meta") return null;
    return record;
  });
}

function validRootMetadata(meta, sessionId) {
  if (meta.id !== sessionId || (meta.session_id && meta.session_id !== sessionId)) return false;
  if (meta.parent_thread_id || meta.agent_path || meta.thread_source === "subagent") return false;
  if (meta.source && typeof meta.source === "object") {
    return !Object.hasOwn(meta.source, "subagent") && !Object.hasOwn(meta.source, "sub_agent");
  }
  return meta.source !== "subagent";
}

function canReplaceAnchor(existing, replacement, sessionId) {
  const meta = replacement?.payload;
  if (!meta || !validRootMetadata(meta, sessionId)) return false;
  if (!existing.transcriptPath) return true;
  if (!meta.history_base) return false;
  const predecessor = readSessionHeader(existing.transcriptPath);
  return predecessor ? Date.parse(replacement.timestamp) > Date.parse(predecessor.timestamp) : true;
}

function updateAnchor(input, scopeMode, context, existing) {
  const { transcriptPath } = context;
  if (existing.host !== HOST || !matchesScope(scopeMode, existing.scope) || !transcriptPath) return;
  if (existing.scope === "workspace" && !isWorkspaceEnabled({ appData: context.appData, rootDir: existing.rootDir })) return;
  if (pathKey(transcriptPath) === pathKey(existing.transcriptPath) || input.source !== "resume") return;
  const replacement = readSessionHeader(transcriptPath);
  if (!canReplaceAnchor(existing, replacement, context.sessionId)) return;
  withPoolWrite({ ...existing, sessionId: context.sessionId }, () => {
    bindConversationTranscript({ ...context, expectedTranscriptPath: existing.transcriptPath, host: HOST });
  });
}

function registerStart(input, scopeMode, context) {
  if (!START_SOURCES.has(input.source)) return;
  const existing = lookupConversation(context);
  if (existing) return updateAnchor(input, scopeMode, context, existing);
  const meta = readSessionHeader(context.transcriptPath)?.payload;
  if (meta && !validRootMetadata(meta, context.sessionId)) return;
  const rootDir = findCodexWorkspace(input.cwd);
  const scope = rootDir ? "workspace" : "no-workspace";
  if (!matchesScope(scopeMode, scope)) return;
  if (scope === "workspace" && !isWorkspaceEnabled({ appData: context.appData, rootDir })) return;
  registerConversation({ ...context, rootDir, scope, host: HOST });
}

function digestLine(line) {
  return crypto.createHash("sha256").update(line).digest("hex");
}

function intactCursor(fd, { fileId, size }, cursor) {
  if (!cursor) return true;
  const { byteOffset, lineStart, digest } = cursor;
  if (cursor.fileId !== fileId || !Number.isSafeInteger(byteOffset) || !Number.isSafeInteger(lineStart)) return false;
  if (lineStart < 0 || byteOffset <= lineStart || byteOffset > size || byteOffset - lineStart > MAX_RECORD_BYTES) return false;
  const record = readRecords(fd, lineStart, byteOffset).next().value;
  return record?.byteOffset === byteOffset && digestLine(record.line) === digest;
}

function recordTurnId(record) {
  if (record?.type === "turn_context") return asIdentifier(record.payload?.turn_id);
  if (record?.type !== "event_msg" || !START_EVENTS.has(record.payload?.type)) return null;
  return asIdentifier(record.payload.turn_id);
}

function isAbortRecord(record) {
  return (record?.type === "event_msg" && ABORT_EVENTS.has(record.payload?.type)) || ABORT_EVENTS.has(record?.type);
}

function responseText(content) {
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "output_text" && typeof part.text === "string")
    .map((part) => part.text).join("\n");
}

function finalResponse(record, latestTurn, currentTurn) {
  const payload = record?.payload;
  if (record?.type !== "response_item" || payload?.type !== "message" || payload.role !== "assistant") return undefined;
  if (payload.phase === "commentary") return undefined;
  const declaredTurn = asIdentifier(payload.internal_chat_message_metadata_passthrough?.turn_id);
  if ((declaredTurn ?? latestTurn) !== currentTurn || payload.phase !== "final_answer") return null;
  return responseText(payload.content);
}

function observeRecord(observed, record, currentTurn, { line, lineStart, byteOffset }) {
  const turnId = recordTurnId(record);
  if (turnId && observed.activeTurn !== turnId) {
    observed.activeTurn = turnId;
    observed.aborted = false;
    observed.candidate = null;
  }
  if (isAbortRecord(record)) {
    const abortedTurn = asIdentifier(record.payload?.turn_id) ?? observed.activeTurn;
    if (!abortedTurn || abortedTurn === currentTurn) observed.aborted = true;
    return;
  }
  if (!observed.acceptAnswers) return;
  const text = finalResponse(record, observed.activeTurn, currentTurn);
  if (text === undefined) return;
  observed.candidate = text === null ? null : { lineStart, byteOffset, text, digest: digestLine(line) };
}

function startScan(fd, file, { inspectAnswers, previousCursor, transcriptPath }) {
  const tailScan = { start: Math.max(0, file.size - LOG_TAIL_BYTES), turn: null, canConsume: false };
  if (!inspectAnswers) return tailScan;
  let previous = null;
  if (previousCursor?.transcriptPath === transcriptPath) previous = previousCursor;
  if (!intactCursor(fd, file, previous)) return tailScan;
  if (!previous) return { start: 0, turn: null, canConsume: true };
  return { start: previous.byteOffset, turn: previous.turnId, canConsume: true };
}

function scanRollout(fd, file, request) {
  const { turnId, previousCursor, transcriptPath } = request;
  const { start, turn, canConsume } = startScan(fd, file, request);
  const observed = { activeTurn: turn, candidate: null, aborted: false, acceptAnswers: canConsume };
  const records = readRecords(fd, start, file.size);
  if (start > 0 && !canConsume) records.next();
  for (const record of records) observeRecord(observed, parseRecord(record.line), turnId, record);
  if (observed.aborted || !canConsume || !observed.candidate) return { aborted: observed.aborted };
  const { lineStart, byteOffset, text, digest } = observed.candidate;
  const cursor = { turnId, transcriptPath, fileId: file.fileId, byteOffset, lineStart, digest };
  const previousCursorKey = JSON.stringify(previousCursor ?? null);
  const acknowledgment = { cursor, previousCursorKey, tokens: extractAckTokensFromText(text) };
  return { acknowledgment };
}

function readStopTranscript({ transcriptPath }, paths, turnId) {
  const state = readJson(paths.state);
  const inspectAnswers = Object.keys(state.delivered ?? {}).length > 0;
  const request = { turnId, transcriptPath, previousCursor: state.lastAckedStopCursor, inspectAnswers };
  return readRollout(transcriptPath, (fd, info) => scanRollout(fd, info, request));
}

function interrupted(input) {
  return input.interrupted === true || input.aborted === true ||
    INTERRUPTED.has(input.termination_reason) || INTERRUPTED.has(input.stop_reason);
}

function poolEvent(input, context, paths) {
  const turnId = asIdentifier(input.turn_id);
  if (input.hook_event_name === "Stop") {
    if (!turnId || interrupted(input)) return null;
    const observed = readStopTranscript(context, paths, turnId);
    if (observed?.aborted) return null;
    return { kind: "stop", turnId, continuationActive: input.stop_hook_active === true, acknowledgment: observed?.acknowledgment };
  }
  const event = { kind: "delivery", turnId };
  const toolCall = asIdentifier(input.tool_use_id);
  if (input.hook_event_name === "PostToolUse" && toolCall && turnId) {
    event.toolEventKey = "PostToolUse:" + turnId + ":" + toolCall;
  }
  return event;
}

function formatMessages(result, paths, { scope, sessionId }) {
  const messages = [];
  if (result.retractions.length) {
    messages.push(RETRACTION_HEADER + "\n" + result.retractions.map((text) => formatRetractedIdea(text, sessionId)).join("\n"));
  }
  if (result.deliveries.length) {
    const numbered = result.deliveries.map((item, index) =>
      (index + 1) + ". " + formatDeliveredLine(item, paths, { scope }) + " [FONS:" + item.ackToken + "]"
    ).join("\n");
    const heading = result.kind === "continue" ? STOP_HEADER + "\n" + ACK_HINT : ACK_HINT;
    messages.push(heading + "\n" + numbered);
  }
  return messages.join("\n\n");
}

function encodeResult(result, eventName, paths, context) {
  if (result.kind === "allow") return {};
  const message = formatMessages(result, paths, context);
  if (!message) return {};
  if (result.kind === "continue") return { decision: "block", reason: message };
  return { hookSpecificOutput: { hookEventName: eventName, additionalContext: message } };
}

function handlePoolHook(input, context) {
  if (context.scope === "workspace" && !isWorkspaceEnabled({ appData: context.appData, rootDir: context.rootDir })) return {};
  const eventName = input.hook_event_name;
  if (eventName === "UserPromptSubmit") backfillConversationTitle({ ...context, title: input.prompt });
  const paths = sessionPaths(context);
  const inbox = fs.statSync(paths.ideas, { throwIfNoEntry: false });
  if (!inbox?.size && !fs.existsSync(paths.retractMarker)) return {};
  const event = poolEvent(input, context, paths);
  if (!event) return {};
  const policy = standardPoolPolicy({ appData: context.appData });
  return encodeResult(executePoolEvent(context, { ...event, transcriptPath: context.transcriptPath }, policy), eventName, paths, context);
}

function applyHook(input, scopeMode) {
  const { hook_event_name: eventName, agent_id: agentId, session_id: sessionId } = input;
  if (!HOOK_EVENTS.has(eventName) || agentId || !isValidSessionId(sessionId)) return {};
  const context = { appData: codexAppData(), sessionId, transcriptPath: absolutePath(input.transcript_path) };
  if (eventName === "SessionStart") {
    registerStart(input, scopeMode, context);
    return {};
  }
  const entry = lookupConversation(context);
  if (!matchesTranscriptAnchor({ entry, context, scopeMode, host: HOST })) return {};
  return handlePoolHook(input, { ...context, ...entry });
}

export function evaluateCodexHook(input, scopeMode) {
  return withLockFallback(() => applyHook(input, scopeMode));
}
