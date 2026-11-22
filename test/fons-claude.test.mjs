import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { updateFonsConfig } from "../scripts/fons-config.mjs";
import { evaluateHook } from "../scripts/fons-hook.mjs";
import {
  addIdeas, archiveCompleted, holdEditing, listConversations, lookupConversation, noWorkspaceFonsDir, readJson,
  readPoolSnapshot, registerConversation, releaseEditing, removeIdea, sessionPaths,
} from "../scripts/fons-store.mjs";

const run = promisify(execFile);
const HOOK = fileURLToPath(new URL("../scripts/fons-hook.mjs", import.meta.url));
const CLI = fileURLToPath(new URL("../scripts/fons-cli.mjs", import.meta.url));
const SESSION = "11111111-1111-4111-8111-111111111101";
const SESSION_B = "22222222-2222-4222-8222-222222222202";
const OTHER = "33333333-3333-4333-8333-333333333303";
const PROMPT_1 = "aaaa1111-1111-4111-8111-111111111111";
const PROMPT_2 = "bbbb2222-2222-4222-8222-222222222222";
const ACK = /\[FONS:([a-f0-9]{8})\]/g;

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function fixture(t, { workspace = true, marker = ".claude" } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fons-claude-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const appData = path.join(directory, "claude home");
  const cwd = path.join(directory, "中文 project");
  const transcript_path = path.join(appData, "projects", "demo-proj", SESSION + ".jsonl");

  const saved = {
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
    FONS_DEBOUNCE_SEC: process.env.FONS_DEBOUNCE_SEC,
    FONS_STOP_WAIT_DEBOUNCE: process.env.FONS_STOP_WAIT_DEBOUNCE,
  };
  process.env.CLAUDE_CONFIG_DIR = appData;
  delete process.env.CLAUDE_PROJECT_DIR;
  process.env.FONS_DEBOUNCE_SEC = "0";
  delete process.env.FONS_STOP_WAIT_DEBOUNCE;
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) restoreEnv(key, value);
  });

  fs.mkdirSync(cwd, { recursive: true });
  if (workspace) fs.mkdirSync(path.join(cwd, marker), { recursive: true });
  fs.mkdirSync(path.dirname(transcript_path), { recursive: true });
  fs.writeFileSync(transcript_path, "");

  const ids = { session_id: SESSION, cwd, transcript_path };
  const scope = workspace ? { rootDir: cwd } : { fonsDir: noWorkspaceFonsDir(appData) };
  const context = { ...scope, sessionId: SESSION };
  return { directory, appData, cwd, context, paths: sessionPaths(context), ids };
}

function call(f, name, fields = {}, scopeMode = "all") {
  return evaluateHook({ ...f.ids, hook_event_name: name, prompt_id: PROMPT_1, ...fields }, scopeMode, "claude");
}

function contextText(result) {
  return result.hookSpecificOutput?.additionalContext || "";
}

function tokens(message) {
  return [...message.matchAll(ACK)].map((match) => match[1]);
}

function removeByNote(f, note) {
  const row = readPoolSnapshot(f.context).items.find((item) => item.note === note);
  removeIdea({ ...f.context, rowIndex: row.rowIndex, expectedRaw: row.raw });
}

test("workspace and no-workspace registration, title backfill, SessionEnd and resume lifecycle", (t) => {
  const noWs = fixture(t, { workspace: false });
  const startNoWs = call(noWs, "SessionStart", { source: "startup" });
  assert.equal(startNoWs.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(contextText(startNoWs), /\[FONS_ACK: 编号\]/);

  const regNoWs = lookupConversation({ appData: noWs.appData, sessionId: SESSION });
  assert.equal(regNoWs.host, "claude");
  assert.equal(regNoWs.scope, "no-workspace");
  assert.equal(regNoWs.rootDir, null);
  assert.equal(regNoWs.endedAt, null);
  assert.equal(fs.existsSync(path.join(noWs.cwd, ".agents")), false);

  assert.deepEqual(call(noWs, "UserPromptSubmit", { prompt: "第一次对话标题" }), {});
  assert.deepEqual(call(noWs, "UserPromptSubmit", { prompt: "第二次不覆盖" }), {});
  assert.equal(lookupConversation({ appData: noWs.appData, sessionId: SESSION }).title, "第一次对话标题");
  assert.equal(fs.existsSync(noWs.paths.state), false);

  // Workspace detection via CLAUDE_PROJECT_DIR overrides cwd and stops before home.
  const ws = fixture(t, { workspace: true, marker: ".claude" });
  const unrelatedCwd = path.join(ws.directory, "elsewhere");
  fs.mkdirSync(unrelatedCwd);
  process.env.CLAUDE_PROJECT_DIR = path.join(ws.cwd, "nested");
  fs.mkdirSync(process.env.CLAUDE_PROJECT_DIR);

  const startWs = call(ws, "SessionStart", { source: "startup", cwd: unrelatedCwd });
  assert.equal(startWs.hookSpecificOutput.hookEventName, "SessionStart");
  const regWs = lookupConversation({ appData: ws.appData, sessionId: SESSION });
  assert.equal(regWs.scope, "workspace");
  assert.equal(regWs.rootDir, ws.cwd);
  assert.equal(regWs.endedAt, null);

  // SessionEnd atomically marks endedAt and returns empty object.
  assert.deepEqual(call(ws, "SessionEnd", { reason: "clear" }), {});
  const ended = lookupConversation({ appData: ws.appData, sessionId: SESSION });
  assert.equal(typeof ended.endedAt, "number");
  assert.ok(ended.endedAt > 0);

  // Resume clears endedAt and updates anchor when transcript relocates under a valid <session_id>.jsonl path.
  const migrated = path.join(ws.appData, "projects", "moved-proj", SESSION + ".jsonl");
  fs.mkdirSync(path.dirname(migrated), { recursive: true });
  fs.writeFileSync(migrated, "");
  assert.deepEqual(call(ws, "SessionStart", { source: "fork", transcript_path: migrated }), {});
  assert.equal(lookupConversation({ appData: ws.appData, sessionId: SESSION }).transcriptPath, ws.ids.transcript_path);

  const resumed = call(ws, "SessionStart", { source: "resume", transcript_path: migrated });
  assert.equal(resumed.hookSpecificOutput.hookEventName, "SessionStart");
  const afterResume = lookupConversation({ appData: ws.appData, sessionId: SESSION });
  assert.equal(afterResume.endedAt, null);
  assert.equal(afterResume.transcriptPath, migrated);
  assert.equal(listConversations({ appData: ws.appData, rootDir: ws.cwd })[0].endedAt, null);
});

test("PostToolBatch delivery, editing hold, withdrawal notice, and 10k character deferral/clamping", (t) => {
  const f = fixture(t);
  call(f, "SessionStart", { source: "startup" });
  addIdeas({ ...f.context, texts: ["held draft", "ready item"] });
  const heldItem = readPoolSnapshot(f.context).items.find((item) => item.note === "held draft");
  assert.equal(holdEditing({ ...f.context, id: heldItem.id }).editingHold, true);

  const batch1 = call(f, "PostToolBatch", { tool_calls: [{ tool_name: "Read", tool_use_id: "t1" }] });
  assert.equal(batch1.hookSpecificOutput.hookEventName, "PostToolBatch");
  const msg1 = contextText(batch1);
  assert.match(msg1, /ready item/);
  assert.doesNotMatch(msg1, /held draft/);

  // Withdraw delivered item and release held draft.
  removeByNote(f, "ready item");
  releaseEditing({ ...f.context, id: heldItem.id });
  const batch2 = call(f, "PostToolBatch", { tool_calls: [{ tool_name: "Bash", tool_use_id: "t2" }] });
  const msg2 = contextText(batch2);
  assert.match(msg2, /撤回[\s\S]*ready item/);
  assert.match(msg2, /held draft/);
  assert.equal(fs.existsSync(f.paths.retractMarker), false);

  // 10k char cap: three 4,000-char items split across two deliveries without losing or pre-marking the third.
  const longA = "A".repeat(4000);
  const longB = "B".repeat(4000);
  const longC = "C".repeat(4000);
  addIdeas({ ...f.context, texts: [longA, longB, longC] });

  const chunk1 = contextText(call(f, "PostToolBatch"));
  assert.ok(chunk1.length <= 10_000, "first chunk length was " + chunk1.length);
  assert.ok(chunk1.includes(longA));
  assert.ok(chunk1.includes(longB));
  assert.equal(chunk1.includes(longC), false);
  const snapshotMid = readPoolSnapshot(f.context).items;
  assert.equal(snapshotMid.find((item) => item.text === longC).status, "buffering");

  const chunk2 = contextText(call(f, "PostToolBatch"));
  assert.ok(chunk2.length <= 10_000, "second chunk length was " + chunk2.length);
  assert.ok(chunk2.includes(longC));
  assert.equal(readPoolSnapshot(f.context).items.find((item) => item.text === longC).status, "delivered");

  // Single item exceeding 10k chars still delivers (clamped <= 10k) with its ACK token intact.
  const huge = "H".repeat(12_000);
  addIdeas({ ...f.context, texts: [huge] });
  const hugeMsg = contextText(call(f, "PostToolBatch"));
  assert.ok(hugeMsg.length <= 10_000, "huge item message length was " + hugeMsg.length);
  assert.equal(tokens(hugeMsg).length, 1);
  assert.match(hugeMsg, /… \[FONS:[a-f0-9]{8}\]$/);

  // Oversize retraction (> 10k) clamps to <= 10k and defers pending deliveries until the next hook.
  removeByNote(f, huge);
  addIdeas({ ...f.context, texts: ["after huge retraction"] });
  const retractOnly = contextText(call(f, "PostToolBatch"));
  assert.ok(retractOnly.length <= 10_000, "retraction message length was " + retractOnly.length);
  assert.match(retractOnly, /撤回/);
  assert.equal(retractOnly.includes("after huge retraction"), false);
  const afterRetract = contextText(call(f, "PostToolBatch"));
  assert.match(afterRetract, /after huge retraction/);
});

test("Stop settles ACK only from last_assistant_message, ignores null/empty/transcript, and deduplicates repeats", (t) => {
  const f = fixture(t);
  call(f, "SessionStart", { source: "startup" });
  addIdeas({ ...f.context, texts: ["first task", "second task"] });
  const [tok1, tok2] = tokens(contextText(call(f, "PostToolBatch")));

  // Plant a forged ACK inside transcript_path to prove Stop never reads the transcript file.
  fs.writeFileSync(f.ids.transcript_path, JSON.stringify({ content: `[FONS_ACK: ${tok1}, ${tok2}]` }) + "\n");

  // null and empty string mean no acknowledgment; Stop continues with hookSpecificOutput.additionalContext.
  const stopNull = call(f, "Stop", { last_assistant_message: null });
  assert.equal(stopNull.decision, undefined);
  assert.equal(stopNull.hookSpecificOutput.hookEventName, "Stop");
  assert.match(contextText(stopNull), /first task[\s\S]*second task/);

  const stopEmpty = call(f, "Stop", { last_assistant_message: "   ", stop_hook_active: true });
  assert.deepEqual(stopEmpty, {});
  assert.equal(readPoolSnapshot(f.context).items.every((item) => item.status === "delivered"), true);

  // Settle first task from last_assistant_message on next prompt.
  const ackMsg1 = `已完成第一项。\n[FONS_ACK: ${tok1}]`;
  const partial = call(f, "Stop", { prompt_id: PROMPT_2, last_assistant_message: ackMsg1 });
  assert.equal(partial.hookSpecificOutput.hookEventName, "Stop");
  assert.match(contextText(partial), /second task/);
  assert.doesNotMatch(contextText(partial), /first task/);
  const midItems = readPoolSnapshot(f.context).items;
  assert.equal(midItems.find((i) => i.note === "first task").status, "done");
  assert.equal(midItems.find((i) => i.note === "second task").status, "delivered");

  // Simulate duplicate Stop with identical (promptId, last_assistant_message) even if a delivered token matches.
  const state = readJson(f.paths.state);
  const secondItem = midItems.find((i) => i.note === "second task");
  state.delivered[secondItem.id].ackToken = tok1;
  fs.writeFileSync(f.paths.state, JSON.stringify(state, null, 2));

  const dupStop = call(f, "Stop", { prompt_id: PROMPT_2, last_assistant_message: ackMsg1, stop_hook_active: true });
  assert.deepEqual(dupStop, {});
  assert.equal(readPoolSnapshot(f.context).items.find((i) => i.note === "second task").status, "delivered");

  // Distinct message settles remaining item and allows Stop ({}).
  const finalStop = call(f, "Stop", {
    prompt_id: PROMPT_2,
    last_assistant_message: `第二项也已完成。\n[FONS_ACK: ${tok1}]`,
    stop_hook_active: true,
  });
  assert.deepEqual(finalStop, {});
  assert.equal(readPoolSnapshot(f.context).items.every((i) => i.status === "done"), true);
});

test("subagent events are isolated while --agent main sessions work normally", (t) => {
  const f = fixture(t);
  const subagentTranscript = path.join(f.appData, "projects", "demo-proj", SESSION, "subagents", SESSION + ".jsonl");
  const wrongNameTranscript = path.join(f.appData, "projects", "demo-proj", OTHER + ".jsonl");
  fs.mkdirSync(path.dirname(subagentTranscript), { recursive: true });
  fs.writeFileSync(subagentTranscript, "");
  fs.writeFileSync(wrongNameTranscript, "");

  // Reject subagent SessionStart, subagents/ transcript, wrong basename, and unsupported PostToolUse.
  assert.deepEqual(call(f, "SessionStart", { source: "startup", agent_id: "sub-1", agent_type: "Explore" }), {});
  assert.deepEqual(call(f, "SessionStart", { source: "startup", transcript_path: subagentTranscript }), {});
  assert.deepEqual(call(f, "SessionStart", { source: "startup", transcript_path: wrongNameTranscript }), {});
  assert.equal(lookupConversation({ appData: f.appData, sessionId: SESSION }), null);

  // Main session launched via `claude --agent reviewer` has agent_type only (no agent_id) -> works normally.
  const started = call(f, "SessionStart", { source: "startup", agent_type: "reviewer" });
  assert.equal(started.hookSpecificOutput.hookEventName, "SessionStart");
  addIdeas({ ...f.context, texts: ["main agent idea"] });

  // Subagent events with agent_id and mismatched transcripts are ignored.
  assert.deepEqual(call(f, "PostToolBatch", { agent_id: "sub-1", agent_type: "Explore" }), {});
  assert.deepEqual(call(f, "UserPromptSubmit", { agent_id: "sub-1", prompt: "sub prompt" }), {});
  assert.deepEqual(call(f, "Stop", { agent_id: "sub-1", last_assistant_message: "nope" }), {});
  assert.deepEqual(call(f, "SessionEnd", { agent_id: "sub-1", reason: "other" }), {});
  assert.deepEqual(call(f, "PostToolBatch", { transcript_path: subagentTranscript }), {});
  assert.deepEqual(call(f, "PostToolUse", { tool_name: "Read", tool_use_id: "u1" }), {});
  assert.deepEqual(call(f, "PostToolUseFailure", { tool_name: "Bash", tool_use_id: "u2" }), {});
  assert.equal(lookupConversation({ appData: f.appData, sessionId: SESSION }).endedAt, null);

  // Main --agent session delivers and settles cleanly.
  const delivered = call(f, "PostToolBatch", { agent_type: "reviewer" });
  assert.match(contextText(delivered), /main agent idea/);
  const [ack] = tokens(contextText(delivered));
  assert.deepEqual(call(f, "Stop", { agent_type: "reviewer", last_assistant_message: `完成。\n[FONS_ACK: ${ack}]` }), {});
  assert.equal(readPoolSnapshot(f.context).items[0].status, "done");
});

test("Stop resets 2-continue quota per prompt_id and falls back to persisted UserPromptSubmit prompt_id", (t) => {
  const f = fixture(t);
  call(f, "SessionStart", { source: "startup" });
  process.env.FONS_DEBOUNCE_SEC = "45";
  addIdeas({ ...f.context, texts: ["item one"] });

  // Same prompt_id: 1st Stop continues, 2nd Stop with identical signature stops, new item uses 2nd quota, 3rd stops.
  const s1 = call(f, "Stop", { prompt_id: PROMPT_1, last_assistant_message: "r1" });
  assert.equal(s1.hookSpecificOutput.hookEventName, "Stop");
  assert.deepEqual(call(f, "Stop", { prompt_id: PROMPT_1, stop_hook_active: true, last_assistant_message: "r2" }), {});

  addIdeas({ ...f.context, texts: ["item two"] });
  const s2 = call(f, "Stop", { prompt_id: PROMPT_1, stop_hook_active: true, last_assistant_message: "r3" });
  assert.equal(s2.hookSpecificOutput.hookEventName, "Stop");

  addIdeas({ ...f.context, texts: ["item three"] });
  assert.deepEqual(call(f, "Stop", { prompt_id: PROMPT_1, stop_hook_active: true, last_assistant_message: "r4" }), {});

  // New prompt_id resets quota even when stop_hook_active is true.
  const sNew = call(f, "Stop", { prompt_id: PROMPT_2, stop_hook_active: true, last_assistant_message: "r5" });
  assert.equal(sNew.hookSpecificOutput.hookEventName, "Stop");
  assert.equal(readJson(f.paths.state).lastStopTurnId, PROMPT_2);
  assert.equal(readJson(f.paths.state).stopCount, 1);

  // Fallback when Stop lacks prompt_id: UserPromptSubmit persists lastPromptId (non-empty inbox), Stop reuses it.
  const PROMPT_3 = "cccc3333-3333-4333-8333-333333333333";
  call(f, "UserPromptSubmit", { prompt_id: PROMPT_3, prompt: "third turn" });
  assert.equal(readJson(f.paths.state).lastPromptId, PROMPT_3);

  const sFallback = call(f, "Stop", { prompt_id: undefined, stop_hook_active: true, last_assistant_message: "r6" });
  assert.equal(sFallback.hookSpecificOutput.hookEventName, "Stop");
  assert.equal(readJson(f.paths.state).lastStopTurnId, PROMPT_3);
  assert.equal(readJson(f.paths.state).stopCount, 1);

  // Empty-inbox turn refreshes existing state.lastPromptId so a mid-turn idea is not blocked by prior turn's quota.
  const stale = fixture(t);
  call(stale, "SessionStart", { source: "startup" });
  addIdeas({ ...stale.context, texts: ["turn1-a"] });
  const staleStop1 = call(stale, "Stop", { prompt_id: PROMPT_1, last_assistant_message: "m1" });
  const [tokA] = tokens(contextText(staleStop1));
  addIdeas({ ...stale.context, texts: ["turn1-b"] });
  const staleStop2 = call(stale, "Stop", { prompt_id: PROMPT_1, stop_hook_active: true, last_assistant_message: "m2" });
  const [, tokB] = tokens(contextText(staleStop2));
  assert.deepEqual(call(stale, "Stop", {
    prompt_id: PROMPT_1, stop_hook_active: true, last_assistant_message: `done\n[FONS_ACK: ${tokA}, ${tokB}]`,
  }), {});
  archiveCompleted(stale.context);
  assert.equal(fs.existsSync(stale.paths.ideas), false);
  // Turn 2 starts with empty inbox -> updates existing state.lastPromptId to PROMPT_2.
  assert.deepEqual(call(stale, "UserPromptSubmit", { prompt_id: PROMPT_2, prompt: "empty turn 2" }), {});
  addIdeas({ ...stale.context, texts: ["mid-turn2 idea"] });
  const turn2Stop = call(stale, "Stop", { prompt_id: undefined, stop_hook_active: true, last_assistant_message: "r" });
  assert.equal(turn2Stop.hookSpecificOutput.hookEventName, "Stop");
  assert.match(contextText(turn2Stop), /mid-turn2 idea/);
});

test("injection wording uses factual statements without imperative ACK commands", (t) => {
  const f = fixture(t);
  const startMsg = contextText(call(f, "SessionStart", { source: "startup" }));
  assert.match(startMsg, /\[FONS_ACK: 编号\]/);
  assert.doesNotMatch(startMsg, /请|必须|勿改|不要/);

  addIdeas({ ...f.context, texts: ["补充接口文档"], attachments: [{ name: "spec.md", buffer: Buffer.from("# spec") }] });
  const deliverMsg = contextText(call(f, "PostToolBatch"));
  assert.match(deliverMsg, /用户在 Fons 灵感池补充了以下事项/);
  assert.doesNotMatch(deliverMsg, /\[FONS_ACK|末行附|勿改|请结合|请跳过/);

  const stopMsg = contextText(call(f, "Stop", { last_assistant_message: "暂未处理" }));
  assert.match(stopMsg, /未确认的补充事项/);
  assert.doesNotMatch(stopMsg, /\[FONS_ACK|末行附|勿改|收尾核对/);

  removeByNote(f, "补充接口文档");
  const retractMsg = contextText(call(f, "UserPromptSubmit", { prompt: "next" }));
  assert.match(retractMsg, /用户已从 Fons 灵感池撤回以下补充事项/);
  assert.doesNotMatch(retractMsg, /请跳过|请|必须|勿/);
});

test("lock contention degrades cleanly without losing state", async (t) => {
  const f = fixture(t);
  call(f, "SessionStart", { source: "startup" });
  addIdeas({ ...f.context, texts: ["locked item"] });
  const lock = path.join(f.paths.fonsDir, ".inbox-" + SESSION + ".lock");
  const owner = path.join(lock, process.pid + "-lock-test");
  fs.mkdirSync(owner, { recursive: true });
  t.after(() => fs.rmSync(lock, { recursive: true, force: true }));

  const child = run(process.execPath, [HOOK, "--host=claude"], {
    windowsHide: true,
    env: { ...process.env, CLAUDE_CONFIG_DIR: f.appData },
  });
  child.child.stdin.end(JSON.stringify({ ...f.ids, hook_event_name: "PostToolBatch", prompt_id: PROMPT_1 }));
  const result = await child;
  assert.deepEqual(JSON.parse(result.stdout), {});
  assert.match(result.stderr, /写入锁/);
  assert.equal(fs.existsSync(f.paths.state), false);
});

test("CLI --host claude prefers the unique active session and marks ended sessions", (t) => {
  const f = fixture(t);
  const transcriptB = path.join(f.appData, "projects", "demo-proj", SESSION_B + ".jsonl");
  fs.writeFileSync(transcriptB, "");

  call(f, "SessionStart", { source: "startup", session_title: "旧会话" });
  call(f, "SessionStart", { source: "startup", session_id: SESSION_B, transcript_path: transcriptB, session_title: "新会话" });

  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: f.appData,
    FONS_APP_DATA: undefined,
    FONS_ROOT: undefined,
    FONS_HOST: "",
    FONS_SESSION: "",
    HOME: path.join(f.directory, "home"),
    USERPROFILE: path.join(f.directory, "home"),
  };
  const runCli = (args) => spawnSync(process.execPath, [CLI, ...args], { cwd: f.cwd, encoding: "utf8", env });

  // Two active sessions -> ambiguous error.
  const bothActive = runCli(["--host", "claude", "list"]);
  assert.equal(bothActive.status, 2);
  assert.match(bothActive.stderr, new RegExp(SESSION));
  assert.match(bothActive.stderr, new RegExp(SESSION_B));

  // End session A -> unique active session B is automatically selected without -s.
  call(f, "SessionEnd", { reason: "clear" });
  const sessionsOut = runCli(["--host", "claude", "sessions"]);
  assert.equal(sessionsOut.status, 0, sessionsOut.stderr);
  assert.match(sessionsOut.stdout, new RegExp(SESSION + "[\\s\\S]*\\[已结束\\]"));
  assert.doesNotMatch(sessionsOut.stdout, new RegExp(SESSION_B + ".*\\[已结束\\]"));

  const added = runCli(["--host", "claude", "自动落入活跃会话"]);
  assert.equal(added.status, 0, added.stderr);
  assert.equal(fs.readFileSync(path.join(f.cwd, ".agents", "fons", `ideas-${SESSION_B}.md`), "utf8"), "- [ ] 自动落入活跃会话\n");
  assert.equal(fs.existsSync(f.paths.ideas), false);

  // Two ended sessions (0 active) -> still ambiguous without -s.
  call(f, "SessionEnd", { session_id: SESSION_B, transcript_path: transcriptB, reason: "clear" });
  const bothEnded = runCli(["--host", "claude", "list"]);
  assert.equal(bothEnded.status, 2);
  assert.match(bothEnded.stderr, /\[已结束\]/);

  // Explicit -s shared across two hosts still requires --host even when one is ended.
  const codexHome = path.join(f.directory, "codex-home");
  registerConversation({ appData: codexHome, sessionId: SESSION, rootDir: f.cwd, host: "codex", title: "Codex 同 ID" });
  const sharedId = spawnSync(process.execPath, [CLI, "-s", SESSION, "list"], {
    cwd: f.cwd, encoding: "utf8", env: { ...env, CODEX_HOME: codexHome },
  });
  assert.equal(sharedId.status, 2);
  assert.match(sharedId.stderr, /\[claude\]/);
  assert.match(sharedId.stderr, /\[codex\]/);
});

test("Claude adapter honors config.json debounceSec, stopWaitDebounce, and disabledWorkspaces", (t) => {
  const f = fixture(t);
  delete process.env.FONS_DEBOUNCE_SEC;
  delete process.env.FONS_STOP_WAIT_DEBOUNCE;

  updateFonsConfig(f.appData, { debounceSec: 60, stopWaitDebounce: true });
  assert.ok(contextText(call(f, "SessionStart", { source: "startup" })));
  addIdeas({ ...f.context, texts: ["受配置约束"] });
  assert.deepEqual(call(f, "PostToolBatch", { prompt_id: PROMPT_1 }), {});
  assert.deepEqual(call(f, "Stop", { prompt_id: PROMPT_1, last_assistant_message: "done" }), {});
  assert.equal(readPoolSnapshot({ ...f.context, appData: f.appData }).items[0].status, "buffering");

  // Disabling workspace stops mid-session delivery and blocks new session registration
  updateFonsConfig(f.appData, { debounceSec: 0, stopWaitDebounce: false, workspaceAction: { path: f.cwd, mode: "disable" } });
  assert.deepEqual(call(f, "PostToolBatch", { prompt_id: PROMPT_1 }), {});
  assert.deepEqual(call(f, "Stop", { prompt_id: PROMPT_1, last_assistant_message: "done" }), {});
  const transcriptB = path.join(f.appData, "projects", "demo-proj", SESSION_B + ".jsonl");
  fs.writeFileSync(transcriptB, "");
  assert.deepEqual(call(f, "SessionStart", { source: "startup", session_id: SESSION_B, transcript_path: transcriptB }), {});
  assert.equal(lookupConversation({ appData: f.appData, sessionId: SESSION_B }), null);

  // Re-enabling restores immediate delivery
  updateFonsConfig(f.appData, { workspaceAction: { path: f.cwd, mode: "enable" } });
  assert.match(contextText(call(f, "PostToolBatch", { prompt_id: PROMPT_2 })), /受配置约束/);
});
