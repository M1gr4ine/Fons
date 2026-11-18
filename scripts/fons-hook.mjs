import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  computeDebounce, findAppData, isValidSessionId, migrateLegacyInbox,
  readJson, readPoolData, registerConversation, sessionPaths, writeJsonAtomic,
} from "./fons-store.mjs";

const MAX_STOP_CONTINUES = 2;
const ACK_LINE = /(?:^|\r?\n)\[FONS_ACK:[ \t]*([a-f0-9]{16}(?:,[ \t]*[a-f0-9]{16})*)\][ \t]*$/;
function handlingInstructions(ideasPath) {
  return `有写权限时，处理后用 edit_file 仅将本会话收件箱 ${ideasPath} 对应行的前缀改为 "【√】 "，禁止用 write_file 整文件覆盖。` +
  '若处于只读 Plan 模式且任务无需写文件，请勿为勾选调用 exit_plan_mode。直接回答补充项，' +
  '并在回复最后一行用 [FONS_ACK: 编号] 确认已回答的条目。' +
  '使用各条目 [FONS:编号] 内的真实编号，多条以英文逗号分隔。' +
  '仅确认实际回答的条目，不要建议批量勾选。';
}

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
  const match = ACK_LINE.exec(content.trimEnd());
  return new Set(match?.[1].split(/,[ \t]*/));
}

function markDelivered(items, { state, ui }) {
  state.delivered ??= {};
  return items.map(({ id, text }, index) => {
    const ackToken = crypto.randomBytes(8).toString("hex");
    const withdrawn = ui.retracted?.[id];
    const deliveredAt = Math.max(Date.now(), (ui.reopened?.[id] ?? 0) + 1, (withdrawn?.ts ?? 0) + 1);
    state.delivered[id] = { text, deliveredAt, ackToken };
    const label = withdrawn ? `${text}（重新添加）` : text;
    return `${index + 1}. ${label} [FONS:${ackToken}]`;
  }).join("\n");
}

function unnotified(ui, state) {
  return Object.entries(ui.retracted ?? {}).filter(([id, entry]) => (state.retractNotified?.[id] ?? -1) < entry.ts);
}

function collectRetractions({ state, ui }) {
  const retracted = unnotified(ui, state);
  if (!retracted.length) return "";
  state.retractNotified ??= {};
  for (const [id, entry] of retracted) state.retractNotified[id] = entry.ts;
  return "[FONS 撤回] 用户已撤回以下补充，若尚未执行请跳过：\n" +
    retracted.map(([, entry]) => entry.text).join("\n");
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

function handlePreInvocation(data) {
  const { ready, pendingAt } = computeDebounce(data);
  const { state, paths } = data;
  const deliveredIds = new Set();
  const messages = [];
  if (ready.length) {
    const numbered = markDelivered(ready, data);
    for (const item of ready) deliveredIds.add(item.id);
    messages.push("[FONS] 以下是用户的非紧急补充。请先完成当前编辑和验证，再统一处理。\n" +
      handlingInstructions(paths.ideas) + "\n" + numbered);
  }
  syncPendingLedger(state, pendingAt, deliveredIds);
  const retracted = collectRetractions(data);
  if (retracted) messages.unshift(retracted);
  if (!messages.length) return {};
  return { injectSteps: [{ systemMessage: { systemMessage: messages.join("\n\n") } }] };
}

function stillUnconfirmed(items, data, transcriptPath) {
  const tokens = readTurnAcknowledgments(transcriptPath);
  const remaining = [];
  for (const item of items) {
    const delivery = data.state.delivered?.[item.id];
    const reopened = data.ui.reopened?.[item.id] ?? -1;
    if (item.status !== "delivered" || !tokens.has(delivery?.ackToken) || delivery.deliveredAt <= reopened) {
      remaining.push(item);
      continue;
    }
    data.state.acknowledged ??= {};
    data.state.acknowledged[item.id] = { at: Math.max(Date.now(), reopened + 1) };
  }
  return remaining;
}

function handleStop(input, data) {
  const { state, ui, items } = data;
  const timing = computeDebounce(data);
  const open = items.filter((item) => {
    if (item.status === "done") return false;
    return !(item.status === "buffering" && timing.byId.get(item.id)?.editingHold);
  });
  if (!open.length) {
    syncPendingLedger(state, timing.pendingAt, new Set());
    return { decision: "allow" };
  }
  const distinct = new Map(open.map((item) => [item.id, item]));
  const remaining = stillUnconfirmed(distinct.values(), data, input.transcriptPath);
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
  const numbered = markDelivered(remaining, data);
  syncPendingLedger(state, timing.pendingAt, new Set(remaining.map((item) => item.id)));
  const reminder = "[FONS 收尾核对] 以下补充条目仍需回应或标记完成。\n" +
    handlingInstructions(data.paths.ideas) + "\n" + numbered;
  const reason = [collectRetractions(data), reminder].filter(Boolean).join("\n\n");
  return { decision: "continue", reason };
}

function registerSession(input, context) {
  const appData = findAppData(input.transcriptPath, "brain");
  if (appData) registerConversation({ ...context, appData, title: input.lastUserInput });
}

function handleSessionEvent(input, context, fallback) {
  const paths = sessionPaths(context);
  if (fs.existsSync(path.join(paths.fonsDir, "ideas.md"))) migrateLegacyInbox(context);
  const event = input.hookEventName;
  if (event !== "Stop") registerSession(input, context);
  if (event === "SessionStart") return fallback;
  const inbox = fs.statSync(paths.ideas, { throwIfNoEntry: false });
  const retraction = event === "PreInvocation" && fs.existsSync(paths.retractMarker);
  if (!inbox?.size && !retraction) return fallback;

  const data = readPoolData(context);
  const before = JSON.stringify(data.state);
  const result = event === "Stop" ? handleStop(input, data) : handlePreInvocation(data);
  if (JSON.stringify(data.state) !== before) writeJsonAtomic(paths.state, data.state);
  if (retraction || result.decision === "continue") clearRetractionMarker(data);
  return result;
}

function evaluateHook(input) {
  const event = input.hookEventName;
  const fallback = event === "Stop" ? { decision: "allow" } : {};
  if (!["PreInvocation", "SessionStart", "Stop"].includes(event)) return fallback;
  if (input.workspacePaths?.length === 0) return fallback;
  const rootDir = input.cwd || input.workspacePaths?.[0];
  if (!rootDir || !isValidSessionId(input.conversationId)) return fallback;
  if (event === "Stop" && (input.terminationReason !== "NO_TOOL_CALL" || input.fullyIdle === false)) return fallback;
  return handleSessionEvent(input, { rootDir: path.resolve(rootDir), sessionId: input.conversationId }, fallback);
}

function main() {
  const rawInput = fs.readFileSync(0, "utf8");
  const input = rawInput ? JSON.parse(rawInput) : {};
  process.stdout.write(JSON.stringify(evaluateHook(input)));
}

function isMainModule() {
  if (typeof import.meta.main === "boolean") return import.meta.main;
  if (!process.argv[1]) return false;
  return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  main();
}
