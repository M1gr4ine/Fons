import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { COMPLETED_PREFIX, parseActiveItems } from "./fons-inbox.mjs";

const MAX_STOP_CONTINUES = 2;
const ACK_LINE = /(?:^|\r?\n)\[FONS_ACK:[ \t]*([a-f0-9]{16}(?:,[ \t]*[a-f0-9]{16})*)\][ \t]*$/;
const HANDLING_INSTRUCTIONS =
  '有写权限时，处理后用 edit_file 仅将 ideas.md 对应行的前缀改为 "' + COMPLETED_PREFIX +
  '"，禁止用 write_file 整文件覆盖。' +
  '若处于只读 Plan 模式且任务无需写文件，请勿为勾选调用 exit_plan_mode。直接回答补充项，' +
  '并在回复最后一行用 [FONS_ACK: 编号] 确认已回答的条目。' +
  '使用各条目 [FONS:编号] 内的真实编号，多条以英文逗号分隔。' +
  '仅确认实际回答的条目，不要建议批量勾选。';

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

function resolveDebounceMs() {
  const raw = process.env.FONS_DEBOUNCE_SEC;
  if (raw === undefined || raw.trim() === "") return 60_000;
  const sec = Number(raw);
  return (Number.isFinite(sec) && sec >= 0 ? sec : 60) * 1000;
}

function readState(statePath) {
  if (!fs.existsSync(statePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    // 状态文件属于可重建缓存，解析或 I/O 失败时重置以免阻塞每次模型调用
    if (err instanceof SyntaxError || err?.code) return {};
    throw err;
  }
}

function getConvState(allState, convId) {
  const convState = (allState[convId] ??= {});
  convState.delivered ??= {};
  convState.acknowledged ??= {};
  convState.lastStopSig ??= "";
  convState.stopCount ??= 0;
  return convState;
}

function markDelivered(items, convState) {
  const deliveredAt = Date.now();
  return items.map(({ id, text }, index) => {
    const ackToken = crypto.randomBytes(8).toString("hex");
    convState.delivered[id] = { text, deliveredAt, ackToken };
    return (index + 1) + ". " + text + " [FONS:" + ackToken + "]";
  }).join("\n");
}

function handlePreInvocation({ activeItems, stat, debounceMs, convState, saveState }) {
  // debounceMs === 0 时跳过时间差判定，避免 NTFS 亚毫秒级舍入误拦
  if (debounceMs > 0 && Date.now() - stat.mtimeMs < debounceMs) return {};

  const pending = activeItems.filter(({ id }) => !convState.delivered[id]);
  if (pending.length === 0) return {};

  const numbered = markDelivered(pending, convState);
  saveState();

  const systemMessage =
    "[FONS] 以下是用户的非紧急补充。请先完成当前编辑和验证，再统一处理。\n" +
    HANDLING_INSTRUCTIONS + "\n" + numbered;
  return { injectSteps: [{ systemMessage: { systemMessage } }] };
}

function recordAcknowledgments(items, convState, transcriptPath) {
  const tokens = readTurnAcknowledgments(transcriptPath);
  const confirmed = items.filter(({ id }) => tokens.has(convState.delivered[id]?.ackToken));
  for (const { id } of confirmed) convState.acknowledged[id] = true;
  return confirmed.length > 0;
}

function handleStop({ input, activeItems, convState, saveState }) {
  if (input.terminationReason !== "NO_TOOL_CALL" || input.fullyIdle === false) {
    return { decision: "allow" };
  }

  const unconfirmed = activeItems.filter(({ id }) => !convState.acknowledged[id]);
  if (unconfirmed.length === 0) return { decision: "allow" };

  if (recordAcknowledgments(unconfirmed, convState, input.transcriptPath)) saveState();
  const remaining = unconfirmed.filter(({ id }) => !convState.acknowledged[id]);
  if (remaining.length === 0) return { decision: "allow" };

  const currentSig = remaining.map(({ id }) => id).sort().join(",");
  if (!input.continuationActive) convState.stopCount = 0;
  if (
    (input.continuationActive && convState.lastStopSig === currentSig) ||
    convState.stopCount >= MAX_STOP_CONTINUES
  ) {
    return { decision: "allow" };
  }

  const numbered = markDelivered(remaining, convState);
  convState.lastStopSig = currentSig;
  convState.stopCount += 1;
  saveState();

  return {
    decision: "continue",
    reason: "[FONS 收尾核对] 以下补充条目仍需回应或标记完成。\n" +
      HANDLING_INSTRUCTIONS + "\n" + numbered,
  };
}

function readArchive(fonsDir) {
  try {
    return fs.readFileSync(path.join(fonsDir, "archive.md"), "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return "";
    throw err;
  }
}

function evaluateHook(input) {
  const event = input.hookEventName;
  const defaultRes = event === "Stop" ? { decision: "allow" } : {};
  const rootDir = input.cwd || input.workspacePaths?.[0];
  if (!rootDir) return defaultRes;

  const fonsDir = path.join(rootDir, ".agents", "fons");
  const ideasPath = path.join(fonsDir, "ideas.md");
  if (!fs.existsSync(ideasPath)) return defaultRes;

  const stat = fs.statSync(ideasPath);
  if (stat.size === 0) return defaultRes;

  const activeItems = parseActiveItems(fs.readFileSync(ideasPath, "utf8"), readArchive(fonsDir));
  if (activeItems.length === 0) return defaultRes;

  const statePath = path.join(fonsDir, ".state.json");
  const allState = readState(statePath);
  const convState = getConvState(allState, input.conversationId || "default");
  const saveState = () => {
    fs.mkdirSync(fonsDir, { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(allState, null, 2), "utf8");
  };

  if (event === "PreInvocation") {
    return handlePreInvocation({
      activeItems,
      stat,
      debounceMs: resolveDebounceMs(),
      convState,
      saveState,
    });
  }
  if (event === "Stop") {
    return handleStop({ input, activeItems, convState, saveState });
  }
  return defaultRes;
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
