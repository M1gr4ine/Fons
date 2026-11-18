import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const MAX_STOP_CONTINUES = 2;

export function parseActiveItems(content) {
  const seen = new Set();
  const activeItems = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || /^[-*]\s*\[[xX]\]/.test(trimmed)) continue;
    const text = trimmed.replace(/^[-*]\s*\[\s*\]\s*/, "").replace(/^[-*](?:\s+|$)/, "").trim();
    if (!text) continue;
    const id = crypto.createHash("sha1").update(text).digest("hex").slice(0, 12);
    if (seen.has(id)) continue;
    seen.add(id);
    activeItems.push({ id, text });
  }
  return activeItems;
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
  } catch {
    // 状态文件属于可重建缓存，损坏时重置以免阻塞每次模型调用
    return {};
  }
}

function main() {
  const debounceMs = resolveDebounceMs();
  const rawInput = fs.readFileSync(0, "utf8");
  const input = rawInput ? JSON.parse(rawInput) : {};
  const event = input.hookEventName;
  const convId = input.conversationId || "default";
  const rootDir = input.cwd || input.workspacePaths?.[0];

  const safeExit = () => {
    process.stdout.write(event === "Stop" ? JSON.stringify({ decision: "allow" }) : "{}");
    process.exit(0);
  };

  if (!rootDir) safeExit();

  const fonsDir = path.join(rootDir, ".agents", "fons");
  const ideasPath = path.join(fonsDir, "ideas.md");
  const statePath = path.join(fonsDir, ".state.json");

  if (!fs.existsSync(ideasPath)) safeExit();

  const stat = fs.statSync(ideasPath);
  if (stat.size === 0) safeExit();

  const activeItems = parseActiveItems(fs.readFileSync(ideasPath, "utf8"));
  if (activeItems.length === 0) safeExit();

  const allState = readState(statePath);
  const convState = allState[convId] || { delivered: {}, lastStopSig: "", stopCount: 0 };
  convState.delivered ??= {};
  convState.lastStopSig ??= "";
  convState.stopCount ??= 0;

  const saveState = () => {
    fs.mkdirSync(fonsDir, { recursive: true });
    allState[convId] = convState;
    fs.writeFileSync(statePath, JSON.stringify(allState, null, 2), "utf8");
  };

  if (event === "PreInvocation") {
    // debounceMs === 0 时跳过时间差判定，避免 NTFS 亚毫秒级舍入误拦
    if (debounceMs > 0 && Date.now() - stat.mtimeMs < debounceMs) safeExit();

    const pending = activeItems.filter((item) => !convState.delivered[item.id]);
    if (pending.length === 0) safeExit();

    const now = Date.now();
    for (const item of pending) {
      convState.delivered[item.id] = { text: item.text, deliveredAt: now };
    }
    saveState();

    const numbered = pending.map((it, i) => `${i + 1}. ${it.text}`).join("\n");
    const msg =
      `[FONS] 以下是用户的非紧急补充，不要中断当前步骤；` +
      `在完成当前修改闭环（编辑+验证）后统一处理，处理完在 .agents/fons/ideas.md 中把对应条目标为已处理（- [x]）：\n` +
      numbered;

    process.stdout.write(
      JSON.stringify({
        injectSteps: [{ systemMessage: { systemMessage: msg } }],
      })
    );
    process.exit(0);
  }

  if (event === "Stop") {
    if (input.terminationReason !== "NO_TOOL_CALL" || input.fullyIdle === false) {
      safeExit();
    }

    const currentSig = activeItems.map((i) => i.id).sort().join(",");
    if (!input.continuationActive) {
      convState.stopCount = 0;
    }

    if (
      (input.continuationActive && convState.lastStopSig === currentSig) ||
      convState.stopCount >= MAX_STOP_CONTINUES
    ) {
      safeExit();
    }

    const now = Date.now();
    for (const item of activeItems) {
      convState.delivered[item.id] ??= { text: item.text, deliveredAt: now };
    }
    convState.lastStopSig = currentSig;
    convState.stopCount += 1;
    saveState();

    const numbered = activeItems.map((it, i) => `${i + 1}. ${it.text}`).join("\n");
    process.stdout.write(
      JSON.stringify({
        decision: "continue",
        reason:
          `[FONS 收尾核对] .agents/fons/ideas.md 中仍有未标为已处理（- [x]）的补充条目，` +
          `请统一处理并更新标记后再结束：\n${numbered}`,
      })
    );
    process.exit(0);
  }

  safeExit();
}

function isMainModule() {
  if (typeof import.meta.main === "boolean") return import.meta.main;
  if (!process.argv[1]) return false;
  return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  main();
}
