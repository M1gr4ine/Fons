import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { evaluateHook } from "../scripts/fons-hook.mjs";
import {
  addIdeas, holdEditing, listConversations, lookupConversation, noWorkspaceFonsDir, readJson, readPoolSnapshot,
  registerConversation, releaseEditing, removeIdea, reopenIdea, sessionPaths,
} from "../scripts/fons-store.mjs";

const run = promisify(execFile);
const HOOK = fileURLToPath(new URL("../scripts/fons-hook.mjs", import.meta.url));
const SESSION = "019ac831-9047-7790-a03f-71a1d67d7601";
const OTHER = "019ac831-9047-7790-a03f-71a1d67d7602";
const TURN = "first-turn";
const ACK = /\[FONS:([a-f0-9]{8})\]/g;

function fixture(t, { workspace = true } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fons-codex-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const appData = path.join(directory, "codex home");
  const cwd = path.join(directory, "中文 worktree");
  const transcript_path = path.join(appData, "sessions", "rollout.jsonl");
  const oldHome = process.env.CODEX_HOME;
  const oldDebounce = process.env.FONS_DEBOUNCE_SEC;
  const oldStrict = process.env.FONS_STOP_WAIT_DEBOUNCE;
  process.env.CODEX_HOME = appData;
  process.env.FONS_DEBOUNCE_SEC = "0";
  delete process.env.FONS_STOP_WAIT_DEBOUNCE;
  t.after(() => {
    restoreEnv("CODEX_HOME", oldHome);
    restoreEnv("FONS_DEBOUNCE_SEC", oldDebounce);
    restoreEnv("FONS_STOP_WAIT_DEBOUNCE", oldStrict);
  });
  fs.mkdirSync(cwd);
  if (workspace) fs.writeFileSync(path.join(cwd, ".git"), "gitdir: ignored");
  fs.mkdirSync(path.dirname(transcript_path), { recursive: true });
  writeLog(transcript_path, { type: "session_meta", payload: { id: SESSION, session_id: SESSION, cwd, source: "cli" } });
  const ids = { session_id: SESSION, cwd, transcript_path };
  const scope = workspace ? { rootDir: cwd } : { fonsDir: noWorkspaceFonsDir(appData) };
  const context = { ...scope, sessionId: SESSION };
  return { appData, cwd, context, paths: sessionPaths(context), ids };
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function writeLog(file, ...lines) {
  fs.appendFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
}

function call(f, name, fields = {}) {
  return evaluateHook(input(f, name, fields), "all", "codex");
}

function input(f, name, fields = {}) {
  return { ...f.ids, hook_event_name: name, turn_id: TURN, ...fields };
}

async function childHook(payload, args = []) {
  const child = run(process.execPath, [...args, HOOK, "--host=codex"], { windowsHide: true });
  child.child.stdin.end(JSON.stringify(payload));
  return child;
}

function contextMessage(result) {
  return result.hookSpecificOutput?.additionalContext || "";
}

function tokens(message) {
  return [...message.matchAll(ACK)].map((match) => match[1]);
}

function finalAnswer(text, turn_id = TURN, phase = "final_answer") {
  return {
    type: "response_item",
    payload: {
      type: "message", role: "assistant", phase, content: [{ type: "output_text", text }],
      internal_chat_message_metadata_passthrough: { turn_id },
    },
  };
}

function remove(f, text) {
  const row = readPoolSnapshot(f.context).items.find((item) => item.note === text);
  removeIdea({ ...f.context, rowIndex: row.rowIndex, expectedRaw: row.raw });
}

test("empty Codex sessions register once and backfill first title through the anchor", (t) => {
  const f = fixture(t, { workspace: false });
  assert.deepEqual(call(f, "SessionStart", { source: "startup" }), {});
  const initial = lookupConversation({ appData: f.appData, sessionId: SESSION });
  assert.equal(initial.scope, "no-workspace");
  assert.equal(initial.host, "codex");
  assert.equal(initial.rootDir, null);
  assert.equal(initial.transcriptPath, f.ids.transcript_path);
  assert.equal(initial.title, "");
  assert.equal(fs.existsSync(path.join(f.cwd, ".agents")), false);
  assert.deepEqual(call(f, "UserPromptSubmit", { prompt: "first title" }), {});
  assert.deepEqual(call(f, "UserPromptSubmit", { prompt: "later" }), {});
  assert.deepEqual(call(f, "SessionStart", { source: "resume", cwd: path.dirname(f.cwd) }), {});
  const listed = listConversations({ appData: f.appData, scope: "no-workspace" });
  assert.equal(listed[0].sessionId, SESSION);
  assert.equal(listed[0].title, "first title");
  assert.equal(listed[0].registeredAt, initial.registeredAt);
  assert.equal(listed[0].transcriptPath, f.ids.transcript_path);
  assert.equal(fs.existsSync(f.paths.state), false);
});

test("old Antigravity records have explicit normalized defaults", (t) => {
  const f = fixture(t);
  registerConversation({ ...f.context, appData: f.appData, title: "old record" });
  const lookup = lookupConversation({ appData: f.appData, sessionId: SESSION });
  assert.equal(lookup.host, "antigravity");
  assert.equal(lookup.transcriptPath, null);
  const listed = listConversations({ appData: f.appData, rootDir: f.cwd });
  assert.equal(listed[0].host, "antigravity");
  assert.equal(listed[0].transcriptPath, null);
});

test("Codex rejects child events, same-ID conflicting anchors and unregistered pool access", (t) => {
  const f = fixture(t);
  const alternate = path.join(path.dirname(f.ids.transcript_path), "forked-rollout.jsonl");
  writeLog(alternate, { type: "session_meta", payload: { id: OTHER, session_id: SESSION, cwd: f.cwd, parent_thread_id: SESSION, source: "cli" } });
  addIdeas({ ...f.context, texts: ["bound work"] });
  assert.deepEqual(call(f, "SubagentStart", { agent_id: OTHER }), {});
  assert.deepEqual(call(f, "SessionStart", { source: "startup", agent_id: OTHER }), {});
  assert.deepEqual(call(f, "PostToolUse", { tool_use_id: "before-registration" }), {});
  assert.equal(lookupConversation({ appData: f.appData, sessionId: SESSION }), null);
  call(f, "SessionStart", { source: "startup" });
  for (const source of ["startup", "fork", "resume"]) call(f, "SessionStart", { source, transcript_path: alternate });
  assert.equal(lookupConversation({ appData: f.appData, sessionId: SESSION }).transcriptPath, f.ids.transcript_path);
  assert.deepEqual(call(f, "UserPromptSubmit", { transcript_path: null, prompt: "blocked" }), {});
  assert.deepEqual(call(f, "PostToolUse", { transcript_path: alternate }), {});
  assert.deepEqual(call(f, "PostToolUse", { agent_id: OTHER }), {});
  assert.deepEqual(call(f, "SubagentStop", { agent_id: OTHER }), {});
  assert.deepEqual(call(f, "Stop", { transcript_path: alternate }), {});
  assert.equal(fs.existsSync(f.paths.state), false);
  const command = call(f, "PostToolUse", { cwd: f.appData, tool_use_id: "root" });
  assert.equal(command.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(contextMessage(command), /bound work/);
  assert.equal(fs.existsSync(path.join(f.appData, ".agents")), false);
});

test("workspace detection stops at the worktree", (t) => {
  const f = fixture(t);
  const child = path.join(f.cwd, "directory");
  fs.mkdirSync(child);
  call(f, "SessionStart", { cwd: child, source: "startup" });
  assert.equal(lookupConversation({ appData: f.appData, sessionId: SESSION }).rootDir, f.cwd);
  assert.deepEqual(call(f, "UserPromptSubmit", { cwd: child }), {});
});

test("parallel PostToolUse claims once and replays only the same tool event", async (t) => {
  const f = fixture(t);
  call(f, "SessionStart", { source: "startup" });
  addIdeas({ ...f.context, texts: ["one claim"] });
  const event = input(f, "PostToolUse", { tool_use_id: "tool-1" });
  const results = (await Promise.all([childHook(event), childHook(event)])).map(({ stdout }) => JSON.parse(stdout));
  assert.equal(results.filter((result) => contextMessage(result).includes("one claim")).length, 1);
  assert.equal(results.filter((result) => Object.keys(result).length === 0).length, 1);
  addIdeas({ ...f.context, texts: ["second claim"] });
  assert.deepEqual(call(f, "PostToolUse", event), {});
  const distinct = call(f, "PostToolUse", { tool_use_id: "tool-2" });
  assert.match(contextMessage(distinct), /second claim/);
  addIdeas({ ...f.context, texts: ["first prompt addition"] });
  assert.match(contextMessage(call(f, "UserPromptSubmit")), /first prompt addition/);
  addIdeas({ ...f.context, texts: ["same-turn prompt addition"] });
  assert.match(contextMessage(call(f, "UserPromptSubmit")), /same-turn prompt addition/);
  assert.equal(Object.keys(readJson(f.paths.state).seenToolEvents).length, 2);
});

test("Stop ignores commentary and same-turn stale final records, persists the cursor on block and allow", (t) => {
  const f = fixture(t);
  call(f, "SessionStart", { source: "startup" });
  addIdeas({ ...f.context, texts: ["answered", "must stay"] });
  const [answerToken, otherToken] = tokens(contextMessage(call(f, "PostToolUse", { tool_use_id: "one" })));
  addIdeas({ ...f.context, texts: ["newly queued"] });
  writeLog(f.ids.transcript_path, finalAnswer("[FONS_ACK: " + otherToken + "]"), finalAnswer("[FONS_ACK: " + answerToken + "]"));
  writeLog(f.ids.transcript_path, finalAnswer("[FONS_ACK: " + otherToken + "]", TURN, "commentary"));
  const first = call(f, "Stop", { last_assistant_message: "[FONS_ACK: " + otherToken + "]" });
  assert.equal(first.decision, "block");
  assert.match(first.reason, /must stay[\s\S]*newly queued/);
  assert.doesNotMatch(first.reason, /answered/);
  const cursor = readJson(f.paths.state).lastAckedStopCursor;
  assert.equal(cursor.turnId, TURN);
  assert.deepEqual(call(f, "Stop", { stop_hook_active: true, last_assistant_message: null }), {});
  assert.deepEqual(readJson(f.paths.state).lastAckedStopCursor, cursor);
  const queuedToken = tokens(first.reason)[1];
  writeLog(f.ids.transcript_path, finalAnswer("[FONS_ACK: " + otherToken + ", " + queuedToken + "]"));
  assert.deepEqual(call(f, "Stop", { stop_hook_active: true }), {});
  const settled = readJson(f.paths.state);
  assert.ok(settled.lastAckedStopCursor.byteOffset > cursor.byteOffset);
  assert.equal(Object.keys(settled.delivered).length, 0);
  assert.equal(readPoolSnapshot(f.context).items.every((item) => item.status === "done"), true);
});

test("Stop uses trusted turn boundaries, ignores partial and other-turn finals, and honors aborts", (t) => {
  const f = fixture(t);
  call(f, "SessionStart", { source: "startup" });
  addIdeas({ ...f.context, texts: ["pending"] });
  const [ack] = tokens(contextMessage(call(f, "UserPromptSubmit")));
  writeLog(f.ids.transcript_path, finalAnswer("[FONS_ACK: " + ack + "]", "other-turn"));
  writeLog(f.ids.transcript_path, { type: "event_msg", payload: { type: "task_started", turn_id: TURN } });
  fs.appendFileSync(f.ids.transcript_path, '{"type":"response_item"');
  assert.equal(call(f, "Stop").decision, "block");
  assert.equal(readPoolSnapshot(f.context).items[0].status, "delivered");
  fs.appendFileSync(f.ids.transcript_path, "\n");
  writeLog(f.ids.transcript_path, { type: "event_msg", payload: { type: "turn_aborted", turn_id: TURN, reason: "interrupted" } });
  const before = fs.readFileSync(f.paths.state);
  assert.deepEqual(call(f, "Interrupt"), {});
  assert.deepEqual(call(f, "Stop", { stop_hook_active: true }), {});
  assert.deepEqual(fs.readFileSync(f.paths.state), before);
  const second = "second-turn";
  writeLog(f.ids.transcript_path, { type: "turn_context", payload: { turn_id: second, cwd: f.cwd } });
  const answer = finalAnswer("[FONS_ACK: " + ack + "]", second);
  delete answer.payload.internal_chat_message_metadata_passthrough;
  writeLog(f.ids.transcript_path, answer);
  assert.deepEqual(call(f, "Stop", { turn_id: second, stop_hook_active: true }), {});
  assert.equal(readPoolSnapshot(f.context).items[0].status, "done");
});

test("Stop resets quota for a new turn even with another hook already active and keeps delivery identity", (t) => {
  const f = fixture(t);
  call(f, "SessionStart", { source: "startup" });
  process.env.FONS_DEBOUNCE_SEC = "45";
  addIdeas({ ...f.context, texts: ["first"] });
  const first = call(f, "Stop");
  assert.equal(first.decision, "block");
  const firstDelivery = Object.values(readJson(f.paths.state).delivered)[0];
  assert.deepEqual(call(f, "Stop", { stop_hook_active: true }), {});
  addIdeas({ ...f.context, texts: ["second"] });
  assert.equal(call(f, "Stop", { stop_hook_active: true }).decision, "block");
  addIdeas({ ...f.context, texts: ["third"] });
  assert.deepEqual(call(f, "Stop", { stop_hook_active: true }), {});
  const resumed = call(f, "Stop", { turn_id: "new-turn", stop_hook_active: true });
  assert.equal(resumed.decision, "block");
  assert.ok(tokens(resumed.reason).includes(firstDelivery.ackToken));
  const { delivered, lastStopTurnId, stopCount } = readJson(f.paths.state);
  const current = Object.values(delivered).find((item) => item.text === "first");
  assert.equal(current.generation, 1);
  assert.equal(current.deliveryUid, firstDelivery.deliveryUid);
  assert.equal(current.deliveredAt, firstDelivery.deliveredAt);
  assert.equal(current.attempt, 3);
  assert.equal(current.firstTurnId, TURN);
  assert.equal(current.lastTurnId, "new-turn");
  assert.equal(lastStopTurnId, "new-turn");
  assert.equal(stopCount, 1);
});

test("strict Stop waits for buffering items until debounce expires", (t) => {
  const f = fixture(t);
  call(f, "SessionStart", { source: "startup" });
  process.env.FONS_DEBOUNCE_SEC = "45";
  process.env.FONS_STOP_WAIT_DEBOUNCE = "1";
  addIdeas({ ...f.context, texts: ["under threshold"] });
  assert.deepEqual(call(f, "Stop"), {});
  assert.equal(readPoolSnapshot(f.context).items[0].status, "buffering");
  delete process.env.FONS_STOP_WAIT_DEBOUNCE;
  assert.equal(call(f, "Stop").decision, "block");
});

test("lock contention preserves ledger, pending withdrawal and tool dedupe state", async (t) => {
  const f = fixture(t);
  call(f, "SessionStart", { source: "startup" });
  addIdeas({ ...f.context, texts: ["withdraw me", "still active"] });
  call(f, "UserPromptSubmit");
  remove(f, "withdraw me");
  const lock = path.join(f.paths.fonsDir, ".inbox-" + SESSION + ".lock");
  const owner = path.join(lock, process.pid + "-fixture");
  fs.mkdirSync(owner, { recursive: true });
  const before = fs.readFileSync(f.paths.state);
  const result = await childHook(input(f, "PostToolUse", { tool_use_id: "locked" }));
  assert.deepEqual(JSON.parse(result.stdout), {});
  assert.match(result.stderr, /写入锁/);
  assert.deepEqual(fs.readFileSync(f.paths.state), before);
  assert.equal(fs.existsSync(f.paths.retractMarker), true);
  fs.rmdirSync(owner);
  fs.rmdirSync(lock);
  assert.match(contextMessage(call(f, "PostToolUse", { tool_use_id: "locked" })), /撤回[\s\S]*withdraw me/);
  assert.equal(fs.existsSync(f.paths.retractMarker), false);
});

test("Stop notifies standalone withdrawals once in a block", (t) => {
  const f = fixture(t);
  call(f, "SessionStart", { source: "startup" });
  addIdeas({ ...f.context, texts: ["last item"] });
  call(f, "UserPromptSubmit");
  remove(f, "last item");
  const last = call(f, "Stop");
  assert.equal(last.decision, "block");
  assert.match(last.reason, /撤回[\s\S]*last item/);
  assert.equal(fs.existsSync(f.paths.retractMarker), false);
  assert.deepEqual(call(f, "Stop", { stop_hook_active: true }), {});
});

for (const lifecycle of ["writable ack", "readonly ack", "withdraw and re-add"]) {
  test("Codex issues a new generation after " + lifecycle, (t) => {
    const f = fixture(t);
    call(f, "SessionStart", { source: "startup" });
    addIdeas({ ...f.context, texts: ["reopen me"] });
    const [oldToken] = tokens(contextMessage(call(f, "UserPromptSubmit")));
    const initial = readPoolSnapshot(f.context).items[0];
    const first = readJson(f.paths.state).delivered[initial.id];
    if (lifecycle === "withdraw and re-add") {
      remove(f, "reopen me");
      const ui = readJson(f.paths.ui);
      // Model the same-millisecond boundary while the pool lock still uses the real clock.
      ui.retracted[initial.id].ts = first.deliveredAt;
      fs.writeFileSync(f.paths.ui, JSON.stringify(ui));
      addIdeas({ ...f.context, texts: ["reopen me"] });
    } else {
      if (lifecycle === "readonly ack") fs.chmodSync(f.paths.ideas, 0o444);
      writeLog(f.ids.transcript_path, finalAnswer("[FONS_ACK: " + oldToken + "]"));
      assert.deepEqual(call(f, "Stop"), {});
      if (lifecycle === "readonly ack") fs.chmodSync(f.paths.ideas, 0o666);
      const done = readPoolSnapshot(f.context).items[0];
      assert.equal(done.status, "done");
      assert.equal(done.doneSource, lifecycle === "readonly ack" ? "readonly_ack" : "inline");
      reopenIdea({ ...f.context, rowIndex: done.rowIndex, expectedRaw: done.raw });
    }
    writeLog(f.ids.transcript_path, finalAnswer("[FONS_ACK: " + oldToken + "]"));
    const retry = call(f, "Stop");
    assert.equal(retry.decision, "block");
    assert.notEqual(tokens(retry.reason)[0], oldToken);
    const next = readJson(f.paths.state);
    assert.equal(next.generations[initial.id], 2);
    assert.equal(next.delivered[initial.id].generation, 2);
    assert.notEqual(next.delivered[initial.id].deliveryUid, first.deliveryUid);
    assert.equal(readPoolSnapshot(f.context).items[0].status, "delivered");
  });
}

test("Codex emits native absolute attachment paths and preserves Markdown links on ACK", (t) => {
  const f = fixture(t);
  call(f, "SessionStart", { source: "startup" });
  addIdeas({ ...f.context, texts: ["inspect screenshot"], attachments: [{ name: "截图.png", buffer: Buffer.from("image") }] });
  const item = readPoolSnapshot(f.context).items[0];
  const message = contextMessage(call(f, "PostToolUse", { cwd: f.appData, tool_use_id: "attachment" }));
  const target = path.join(f.paths.attachmentsDir, item.attachments[0].storedName);
  assert.ok(message.includes(String.fromCharCode(96) + target + String.fromCharCode(96)), message);
  assert.match(message, /末行附 \[FONS_ACK: 编号\]/);
  const [ack] = tokens(message);
  writeLog(f.ids.transcript_path, finalAnswer("[FONS_ACK: " + ack + "]"));
  assert.deepEqual(call(f, "Stop"), {});
  assert.match(fs.readFileSync(f.paths.ideas, "utf8"), /\[截图\.png\]\(attachments\//);
});

test("a rollout replacement updates the anchor on resume without accepting fork or delayed revert", (t) => {
  const f = fixture(t);
  const transcriptDir = path.dirname(f.ids.transcript_path);
  const oldPath = path.join(transcriptDir, "rollout-2026-11-20T21-21-16-" + SESSION + ".jsonl");
  const oldMeta = { id: SESSION, session_id: SESSION, cwd: f.cwd, source: "cli", history_mode: "paginated" };
  writeLog(oldPath, { type: "session_meta", payload: oldMeta, ordinal: 0, timestamp: "2026-11-20T13:21:16.056Z" });
  const oldInput = { transcript_path: oldPath };
  call(f, "SessionStart", { ...oldInput, source: "startup" });
  addIdeas({ ...f.context, texts: ["old delivery"] });
  const [ack] = tokens(contextMessage(call(f, "UserPromptSubmit", oldInput)));
  writeLog(oldPath, { ...finalAnswer("no ACK yet"), ordinal: 1 });
  assert.equal(call(f, "Stop", oldInput).decision, "block");
  assert.equal(readJson(f.paths.state).lastAckedStopCursor.turnId, TURN);

  const replacement = path.join(transcriptDir, "rollout-2026-11-20T21-21-18-" + SESSION + "_" + OTHER + ".jsonl");
  const newInput = { transcript_path: process.platform === "win32" ? "\\\\?\\" + replacement : replacement };
  const header = {
    type: "session_meta",
    payload: { ...oldMeta, history_base: { thread_id: SESSION } },
    timestamp: "2026-11-20T13:21:18.185Z",
  };
  writeLog(replacement, header);
  call(f, "SessionStart", { ...newInput, source: "fork" });
  assert.equal(lookupConversation({ appData: f.appData, sessionId: SESSION }).transcriptPath, oldPath);

  call(f, "SessionStart", { ...newInput, source: "resume" });
  assert.equal(lookupConversation({ appData: f.appData, sessionId: SESSION }).transcriptPath, replacement);
  call(f, "SessionStart", { ...oldInput, source: "resume" });
  assert.equal(lookupConversation({ appData: f.appData, sessionId: SESSION }).transcriptPath, replacement);
  const nextTurn = "after-revert";
  writeLog(oldPath, finalAnswer("[FONS_ACK: " + ack + "]", nextTurn));
  assert.deepEqual(call(f, "Stop", { ...oldInput, turn_id: nextTurn }), {});
  assert.equal(readPoolSnapshot(f.context).items[0].status, "delivered");
  writeLog(replacement, finalAnswer("[FONS_ACK: " + ack + "]", nextTurn));
  assert.deepEqual(call(f, "Stop", { ...newInput, turn_id: nextTurn }), {});
  assert.equal(readPoolSnapshot(f.context).items[0].status, "done");
  assert.equal(readJson(f.paths.state).lastAckedStopCursor.turnId, nextTurn);
});


test("a lost stdout batch can be retried at Stop while a cleared last withdrawal stays best effort", async (t) => {
  const f = fixture(t);
  call(f, "SessionStart", { source: "startup" });
  const cutOutput = path.join(f.appData, "cut-output.cjs");
  fs.writeFileSync(cutOutput, "process.stdout.write = () => process.exit(97);");
  addIdeas({ ...f.context, texts: ["lost first batch"] });
  await assert.rejects(childHook(input(f, "PostToolUse", { tool_use_id: "drop-1" }), ["--require", cutOutput]),
    (error) => error.code === 97 && error.stdout === "");
  const initial = readJson(f.paths.state);
  const [delivery] = Object.values(initial.delivered);
  assert.deepEqual(call(f, "PostToolUse", { tool_use_id: "next-event" }), {});
  const resumed = call(f, "Stop");
  assert.equal(resumed.decision, "block");
  assert.deepEqual(tokens(resumed.reason), [delivery.ackToken]);

  remove(f, "lost first batch");
  assert.equal(fs.existsSync(f.paths.retractMarker), true);
  await assert.rejects(childHook(input(f, "Stop", { stop_hook_active: true }), ["--require", cutOutput]),
    (error) => error.code === 97 && error.stdout === "");
  assert.equal(fs.existsSync(f.paths.retractMarker), false);
  assert.deepEqual(call(f, "Stop", { stop_hook_active: true }), {});
});

test("Stop preserves all buffering when the log shows an abort before the first delivery", (t) => {
  const f = fixture(t);
  call(f, "SessionStart", { source: "startup" });
  addIdeas({ ...f.context, texts: ["buffered only"] });
  writeLog(f.ids.transcript_path, { type: "event_msg", payload: { type: "turn_aborted", turn_id: TURN } });
  assert.deepEqual(call(f, "Stop"), {});
  assert.equal(readPoolSnapshot(f.context).items[0].status, "buffering");
  assert.equal(fs.existsSync(f.paths.state), false);
});

test("acknowledging an older delivery preserves its implicit first generation", (t) => {
  const f = fixture(t);
  call(f, "SessionStart", { source: "startup" });
  addIdeas({ ...f.context, texts: ["legacy active delivery"] });
  const { id, text } = readPoolSnapshot(f.context).items[0];
  const ackToken = "417cf23f";
  fs.writeFileSync(f.paths.state, JSON.stringify({ delivered: { [id]: { text, ackToken, deliveredAt: Date.now() } } }));
  writeLog(f.ids.transcript_path, finalAnswer("[FONS_ACK: " + ackToken + "]"));
  assert.deepEqual(call(f, "Stop"), {});
  const done = readPoolSnapshot(f.context).items[0];
  assert.equal(done.status, "done");
  assert.equal(readJson(f.paths.state).generations[id], 1);
  reopenIdea({ ...f.context, rowIndex: done.rowIndex, expectedRaw: done.raw });
  const next = call(f, "Stop", { turn_id: "follow-up" });
  assert.equal(next.decision, "block");
  assert.equal(readJson(f.paths.state).delivered[id].generation, 2);
});

test("an empty anchor binds on resume with a valid root rollout", (t) => {
  const f = fixture(t);
  call(f, "SessionStart", { source: "startup", transcript_path: null });
  const registered = () => lookupConversation({ appData: f.appData, sessionId: SESSION });
  assert.equal(registered().transcriptPath, null);
  addIdeas({ ...f.context, texts: ["only the original thread may claim this"] });
  call(f, "SessionStart", { source: "resume", transcript_path: f.ids.transcript_path });
  assert.equal(registered().transcriptPath, f.ids.transcript_path);
  assert.match(contextMessage(call(f, "PostToolUse", { transcript_path: f.ids.transcript_path })), /only the original thread/);
});

test("Codex holds an edited draft even when debounce is disabled", (t) => {
  const f = fixture(t);
  call(f, "SessionStart", { source: "startup" });
  addIdeas({ ...f.context, texts: ["currently editing"] });
  const { id } = readPoolSnapshot(f.context).items[0];
  assert.equal(holdEditing({ ...f.context, id }).editingHold, true);
  assert.deepEqual(call(f, "UserPromptSubmit"), {});
  assert.deepEqual(call(f, "Stop"), {});
  assert.equal(readPoolSnapshot(f.context).items[0].status, "buffering");
  releaseEditing({ ...f.context, id });
  assert.match(contextMessage(call(f, "PostToolUse", { tool_use_id: "after-release" })), /currently editing/);
});
