import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as store from "../scripts/fons-store.mjs";
import { archiveCompleted } from "../scripts/fons-store.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK_SCRIPT = path.join(REPO_ROOT, "scripts", "fons-hook.mjs");
const RUN_HOOK_CMD = path.join(REPO_ROOT, "scripts", "run-hook.cmd");
const HOOKS_JSON = path.join(REPO_ROOT, "hooks.json");
const FONS_BIN = path.join(REPO_ROOT, "bin", process.platform === "win32" ? "fons.cmd" : "fons");

const workspaceSessions = new Map();

function makeTempDir(t, sessionId) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fons-test-"));
  t.after(() => { workspaceSessions.delete(dir); fs.rmSync(dir, { recursive: true, force: true }); });
  if (sessionId) workspaceSessions.set(dir, sessionId);
  return dir;
}

function writeIdeas(workspaceDir, content, ageSeconds = 0, sessionId = workspaceSessions.get(workspaceDir)) {
  const fonsDir = path.join(workspaceDir, ".agents", "fons");
  fs.mkdirSync(fonsDir, { recursive: true });
  const ideasPath = path.join(fonsDir, `ideas-${sessionId}.md`);
  fs.writeFileSync(ideasPath, content, "utf8");
  if (ageSeconds !== 0) {
    const mtime = new Date(Date.now() - ageSeconds * 1000);
    fs.utimesSync(ideasPath, mtime, mtime);
  }
  return ideasPath;
}

function runHook(payload, env = {}) {
  const res = spawnSync(process.execPath, [HOOK_SCRIPT], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  assert.equal(res.status, 0, `hook exited with ${res.status}: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

function runStop(cwd, conversationId, overrides = {}) {
  return runHook({
    hookEventName: "Stop",
    conversationId,
    cwd,
    terminationReason: "NO_TOOL_CALL",
    fullyIdle: true,
    continuationActive: false,
    ...overrides,
  });
}

function runHookCmd(pluginDir, eventName, payload, env = {}) {
  const res = spawnSync("cmd.exe", ["/c", `scripts\\run-hook.cmd ${eventName}`], {
    cwd: pluginDir,
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  assert.equal(res.status, 0, `run-hook.cmd exited with ${res.status}: ${res.stderr}`);
  return JSON.parse(res.stdout.trim());
}

function runCli(args, { cwd, env = {} } = {}) {
  if (process.platform === "win32") {
    return spawnSync("cmd.exe", ["/c", FONS_BIN, ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
  }
  return spawnSync(FONS_BIN, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("空收件箱、零字节与全完成/无效行均安全放行", (t) => {
  const ws = makeTempDir(t, "11111111-1111-4111-8111-111111111101");
  const preInput = { hookEventName: "PreInvocation", conversationId: "11111111-1111-4111-8111-111111111101", cwd: ws };

  assert.deepEqual(runHook(preInput), {});
  assert.deepEqual(runStop(ws, "11111111-1111-4111-8111-111111111101"), { decision: "allow" });

  writeIdeas(ws, "", 120);
  assert.deepEqual(runHook(preInput), {});
  assert.deepEqual(runStop(ws, "11111111-1111-4111-8111-111111111101"), { decision: "allow" });

  writeIdeas(
    ws,
    [
      "# 灵感池",
      "",
      "-",
      "*",
      "- [ ]   ",
      "- [√] 已完成条目一",
      "* [√] 已完成条目二",
      "[√] 已完成条目三",
      "【√】已完成条目四",
      "- 【√】已完成条目五",
      "- [✓] 已完成条目六",
      "- [✔] 已完成条目七",
      "✓ 裸勾号已完成条目",
      "- ✓ 列表裸勾号条目",
      "- [x] 历史完成条目八",
      "- [X] 历史完成条目九",
      "* [x] 历史完成条目十",
    ].join("\n"),
    120
  );
  assert.deepEqual(runHook(preInput), {});
  assert.deepEqual(runStop(ws, "11111111-1111-4111-8111-111111111101"), { decision: "allow" });
});

test("Windows run-hook.cmd 空箱短路与全局安装隔离", { skip: process.platform !== "win32" }, (t) => {
  const root = makeTempDir(t);

  // 1. 工作区内 .agents/plugins/fons 安装：空收件箱短路返回
  const localWs = path.join(root, "local-ws");
  const localPluginDir = path.join(localWs, ".agents", "plugins", "fons");
  fs.mkdirSync(path.join(localPluginDir, "scripts"), { recursive: true });
  fs.copyFileSync(HOOKS_JSON, path.join(localPluginDir, "hooks.json"));
  fs.copyFileSync(RUN_HOOK_CMD, path.join(localPluginDir, "scripts", "run-hook.cmd"));
  fs.copyFileSync(HOOK_SCRIPT, path.join(localPluginDir, "scripts", "fons-hook.mjs"));
  fs.copyFileSync(path.join(path.dirname(HOOK_SCRIPT), "fons-store.mjs"), path.join(localPluginDir, "scripts", "fons-store.mjs"));
  fs.copyFileSync(path.join(path.dirname(HOOK_SCRIPT), "fons-inbox.mjs"),
    path.join(localPluginDir, "scripts", "fons-inbox.mjs"));

  assert.deepEqual(
    runHookCmd(localPluginDir, "PreInvocation", {
      hookEventName: "PreInvocation",
      conversationId: "11111111-1111-4111-8111-111111111102",
      cwd: localWs,
    }),
    {}
  );
  assert.deepEqual(
    runHookCmd(localPluginDir, "Stop", {
      hookEventName: "Stop",
      conversationId: "11111111-1111-4111-8111-111111111102",
      cwd: localWs,
      terminationReason: "NO_TOOL_CALL",
      fullyIdle: true,
    }),
    { decision: "allow" }
  );

  // 2. 模拟全局目录 ~/.gemini/config/plugins/fons 安装：不应误判工作区空箱而短路
  const globalPluginDir = path.join(root, ".gemini", "config", "plugins", "fons");
  fs.mkdirSync(path.join(globalPluginDir, "scripts"), { recursive: true });
  fs.copyFileSync(HOOKS_JSON, path.join(globalPluginDir, "hooks.json"));
  fs.copyFileSync(RUN_HOOK_CMD, path.join(globalPluginDir, "scripts", "run-hook.cmd"));
  fs.copyFileSync(HOOK_SCRIPT, path.join(globalPluginDir, "scripts", "fons-hook.mjs"));
  fs.copyFileSync(path.join(path.dirname(HOOK_SCRIPT), "fons-store.mjs"), path.join(globalPluginDir, "scripts", "fons-store.mjs"));
  fs.copyFileSync(path.join(path.dirname(HOOK_SCRIPT), "fons-inbox.mjs"),
    path.join(globalPluginDir, "scripts", "fons-inbox.mjs"));

  const targetWs = path.join(root, "target-ws");
  writeIdeas(targetWs, "- [ ] 补充全局安装隔离测试", 70, "11111111-1111-4111-8111-111111111103");

  const out = runHookCmd(globalPluginDir, "PreInvocation", {
    hookEventName: "PreInvocation",
    conversationId: "11111111-1111-4111-8111-111111111103",
    cwd: targetWs,
  });
  assert.equal(out.injectSteps.length, 1);
  assert.match(out.injectSteps[0].systemMessage.systemMessage, /\[FONS\][\s\S]*1\. 补充全局安装隔离测试/);
});

test("PreInvocation 消抖、合并编号、幂等去重与跨会话独立账本", (t) => {
  const ws = makeTempDir(t, "11111111-1111-4111-8111-111111111104");
  const ideasContent = [
    "# 待办",
    "导出接口补充 created_at 字段",
    "- [ ] 增加导出权限校验",
    "- 导出接口补充 created_at 字段",
    "* 补充错误码文档",
    "- [x] 已完成忽略项",
  ].join("\n");

  // 消抖窗口未满（5s < 60s）：不投递、不写账本
  writeIdeas(ws, ideasContent, 5);
  assert.deepEqual(
    runHook({ hookEventName: "PreInvocation", conversationId: "11111111-1111-4111-8111-111111111104", cwd: ws }),
    {}
  );
  const pendingState = JSON.parse(fs.readFileSync(path.join(ws, ".agents", "fons", ".state-11111111-1111-4111-8111-111111111104.json"), "utf8"));
  assert.ok(pendingState.pendingSig);
  assert.equal(Object.keys(pendingState.delivered ?? {}).length, 0);

  // 消抖窗口期满（65s >= 60s）：合并编号并写入 delivered
  writeIdeas(ws, ideasContent, 65);
  pendingState.pendingSigAt -= 61000;
  fs.writeFileSync(path.join(ws, ".agents", "fons", ".state-11111111-1111-4111-8111-111111111104.json"), JSON.stringify(pendingState));
  const firstOut = runHook({ hookEventName: "PreInvocation", conversationId: "11111111-1111-4111-8111-111111111104", cwd: ws });
  const msg = firstOut.injectSteps[0].systemMessage.systemMessage;
  assert.match(msg, /^\[FONS\]/);
  assert.match(msg, /【√】/);
  assert.match(msg, /edit_file/);
  assert.match(msg, /write_file/);
  assert.match(msg, /exit_plan_mode/);
  assert.match(
    msg,
    /1\. 导出接口补充 created_at 字段 \[FONS:[a-f0-9]{16}\]\n2\. 增加导出权限校验 \[FONS:[a-f0-9]{16}\]\n3\. 补充错误码文档/
  );

  // 同会话二次调用不重复注入
  assert.deepEqual(
    runHook({ hookEventName: "PreInvocation", conversationId: "11111111-1111-4111-8111-111111111104", cwd: ws }),
    {}
  );

  // 新增条目且过消抖期后仅注入新增条目
  writeIdeas(ws, `${ideasContent}\n- [ ] 新增第四条灵感`, 65);
  const deltaOut = runHook({ hookEventName: "PreInvocation", conversationId: "11111111-1111-4111-8111-111111111104", cwd: ws });
  const deltaMsg = deltaOut.injectSteps[0].systemMessage.systemMessage;
  assert.match(deltaMsg, /1\. 新增第四条灵感 /);
  assert.doesNotMatch(deltaMsg, /created_at/);

  // 独立新会话初始为空，写入其收件箱后才投递
  assert.deepEqual(runHook({ hookEventName: "PreInvocation", conversationId: "11111111-1111-4111-8111-111111111105", cwd: ws }), {});
  writeIdeas(ws, `${ideasContent}\n- [ ] 新增第四条灵感`, 65, "11111111-1111-4111-8111-111111111105");
  const newConvOut = runHook({ hookEventName: "PreInvocation", conversationId: "11111111-1111-4111-8111-111111111105", cwd: ws });
  assert.match(newConvOut.injectSteps[0].systemMessage.systemMessage, /4\. 新增第四条灵感 /);

  // FONS_DEBOUNCE_SEC=0 时立即投递
  writeIdeas(ws, "- [ ] 零秒消抖即时测试", 0, "11111111-1111-4111-8111-111111111106");
  const zeroDebounceOut = runHook(
    { hookEventName: "PreInvocation", conversationId: "11111111-1111-4111-8111-111111111106", cwd: ws },
    { FONS_DEBOUNCE_SEC: "0" }
  );
  assert.match(zeroDebounceOut.injectSteps[0].systemMessage.systemMessage, /1\. 零秒消抖即时测试 /);
});

test("Stop 收尾兜底、避免续跑重复注入与防死循环上限", (t) => {
  const ws = makeTempDir(t, "11111111-1111-4111-8111-111111111107");
  writeIdeas(ws, "- [ ] 未满消抖即结束的任务补充", 0);

  // 1. 非正常结束或后台未空闲时直接放行
  assert.deepEqual(
    runStop(ws, "11111111-1111-4111-8111-111111111107", { terminationReason: "USER_CANCELED" }),
    { decision: "allow" }
  );
  assert.deepEqual(
    runStop(ws, "11111111-1111-4111-8111-111111111107", { fullyIdle: false }),
    { decision: "allow" }
  );

  // 2. 正常结束且未投递时触发 Stop 兜底续跑
  const stopOut1 = runStop(ws, "11111111-1111-4111-8111-111111111107");
  assert.equal(stopOut1.decision, "continue");
  assert.match(stopOut1.reason, /\[FONS 收尾核对\][\s\S]*1\. 未满消抖即结束的任务补充/);

  // 3. 续跑期间紧接着的 PreInvocation 不应重复注入 Stop 已兜底的条目
  writeIdeas(ws, "- [ ] 未满消抖即结束的任务补充", 65);
  assert.deepEqual(
    runHook({ hookEventName: "PreInvocation", conversationId: "11111111-1111-4111-8111-111111111107", cwd: ws }),
    {}
  );

  // 4. continuationActive=true 且条目未变时防死循环放行
  assert.deepEqual(
    runStop(ws, "11111111-1111-4111-8111-111111111107", { continuationActive: true }),
    { decision: "allow" }
  );

  // 5. 同一轮内条目持续变化也最多续跑 2 次
  writeIdeas(ws, "- [ ] 未满消抖即结束的任务补充\n- [ ] 续跑时新加第二条", 0);
  const stopOut2 = runStop(ws, "11111111-1111-4111-8111-111111111107", { continuationActive: true });
  assert.equal(stopOut2.decision, "continue");

  writeIdeas(ws, "- [ ] 未满消抖即结束的任务补充\n- [ ] 续跑时新加第二条\n- [ ] 第三条", 0);
  assert.deepEqual(
    runStop(ws, "11111111-1111-4111-8111-111111111107", { continuationActive: true }),
    { decision: "allow" }
  );
});

test("CLI (fons) 追加、查看、子目录寻根与归档闭环", (t) => {
  const ws = makeTempDir(t);
  const subDir = path.join(ws, "src", "nested");
  const appData = path.join(ws, "host");
  const env = { FONS_ROOT: "", FONS_APP_DATA: appData, HOME: path.join(ws, "home"), USERPROFILE: path.join(ws, "home"), FONS_SESSION: "" };
  const index = path.join(appData, "fons", "conversations");
  fs.mkdirSync(index, { recursive: true });
  fs.writeFileSync(path.join(index, `${HOOK_A}.json`), JSON.stringify({ rootDir: ws, title: "test", registeredAt: 1 }));
  fs.mkdirSync(path.join(ws, ".agents", "fons"), { recursive: true });
  fs.mkdirSync(subDir, { recursive: true });

  // 帮助与无参校验
  const noArg = runCli([], { cwd: ws, env });
  assert.equal(noArg.status, 1);
  assert.match(noArg.stderr, /用法:/);

  const helpRes = runCli(["help"], { cwd: ws, env });
  assert.equal(helpRes.status, 0);
  assert.match(helpRes.stdout, /fons.*archive/);

  // 预先写入无尾换行的已有文件，测试追加自动换行及剥离前导 - [ ]
  const ideasPath = path.join(ws, ".agents", "fons", `ideas-${HOOK_A}.md`);
  fs.writeFileSync(ideasPath, "- [ ] 已有无尾换行条目", "utf8");

  const add1 = runCli(["- [ ] 补充中文测试条目A"], { cwd: subDir, env });
  assert.equal(add1.status, 0, add1.stderr);

  const add2 = runCli(["补充中文测试条目B"], { cwd: subDir, env });
  assert.equal(add2.status, 0, add2.stderr);

  const listRes = runCli(["list"], { cwd: subDir, env });
  assert.equal(listRes.status, 0);
  assert.equal(
    listRes.stdout.trim().replace(/ \[\d+-[a-f0-9]{64}\]$/gm, ""),
    ["1. 已有无尾换行条目", "2. 补充中文测试条目A", "3. 补充中文测试条目B"].join("\n")
  );

  // 勾选部分条目后归档
  fs.writeFileSync(
    ideasPath,
    ["- [x] 已有无尾换行条目", "- [X] 补充中文测试条目A", "- [ ] 补充中文测试条目B"].join("\n") + "\n",
    "utf8"
  );
  const arch1 = runCli(["archive"], { cwd: ws, env });
  assert.equal(arch1.status, 0);
  assert.match(arch1.stdout, /已归档 2 条/);

  const archivePath = path.join(ws, ".agents", "fons", "archive", `${HOOK_A}.md`);
  assert.equal(
    fs.readFileSync(archivePath, "utf8"),
    "- [x] 已有无尾换行条目\n- [X] 补充中文测试条目A\n"
  );
  assert.equal(fs.readFileSync(ideasPath, "utf8"), "- [ ] 补充中文测试条目B\n");

  // 勾选剩余最后一条后再次归档：ideas.md 应恢复为 0 字节
  fs.writeFileSync(ideasPath, "- [x] 补充中文测试条目B\n", "utf8");
  const arch2 = runCli(["archive"], { cwd: ws, env });
  assert.equal(arch2.status, 0);
  assert.equal(fs.existsSync(ideasPath), false);
  assert.equal(
    fs.readFileSync(archivePath, "utf8"),
    "- [x] 已有无尾换行条目\n- [X] 补充中文测试条目A\n- [x] 补充中文测试条目B\n"
  );
});

function writeTranscript(dir, filename, steps) {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  const lines = steps.map((s) => (typeof s === "string" ? s : JSON.stringify(s)));
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
  return filePath;
}

function deliver(cwd, conversationId) {
  return runHook({ hookEventName: "PreInvocation", cwd, conversationId })
    .injectSteps[0].systemMessage.systemMessage;
}

function ackToken(message, index = 0) {
  const match = [...message.matchAll(/\[FONS:([a-f0-9]{16})\]/g)][index];
  assert.ok(match, "delivery includes an acknowledgment token");
  return match[1];
}

function answer(content, stepIndex = 1) {
  return { step_index: stepIndex, type: "PLANNER_RESPONSE", source: "MODEL", status: "DONE", content };
}

const userStep = { step_index: 0, type: "USER_INPUT", content: "评审代码" };

test("Stop 不接受文件名、批量命令或写入回合工具名作为确认", (t) => {
  const ws = makeTempDir(t, "11111111-1111-4111-8111-111111111108");
  writeIdeas(ws, "- [ ] 补充测试\n[ ] 解释架构", 70);
  deliver(ws, "11111111-1111-4111-8111-111111111108");

  const transcriptPath = writeTranscript(ws, "transcript.jsonl", [
    userStep,
    { ...answer(""), tool_calls: [{ name: "run_command" }] },
    answer("插件会读取 ideas.md。可以用 fons done。", 2),
  ]);
  const stop = runStop(ws, "11111111-1111-4111-8111-111111111108", { transcriptPath });
  assert.equal(stop.decision, "continue");
  assert.match(stop.reason, /补充测试/);
  assert.match(stop.reason, /解释架构/);
});

test("Stop 仅结清回复中确认的条目，并补投新条目", (t) => {
  const ws = makeTempDir(t, "11111111-1111-4111-8111-111111111109");
  writeIdeas(ws, "【√】 已完成\n- [√] 旧完成项\n[ ] 第一个补充", 70);
  const first = ackToken(deliver(ws, "11111111-1111-4111-8111-111111111109"));
  writeIdeas(ws, "[ ] 第一个补充\n- [ ] 新追加的补充", 5);

  const log = "transcript.jsonl";
  const transcriptPath = writeTranscript(ws, log, [userStep, answer("已回答第一项。\n[FONS_ACK: " + first + "]")]);
  const stop = runStop(ws, "11111111-1111-4111-8111-111111111109", { transcriptPath });
  assert.equal(stop.decision, "continue");
  assert.match(stop.reason, /新追加的补充/);
  assert.doesNotMatch(stop.reason, /第一个补充/);

  const second = ackToken(stop.reason);
  assert.notEqual(first, second);
  writeTranscript(ws, log, [userStep, answer("已回答第二项。\n[FONS_ACK: " + second + "]", 2)]);
  assert.deepEqual(runStop(ws, "11111111-1111-4111-8111-111111111109", { transcriptPath, continuationActive: true }), { decision: "allow" });

  writeTranscript(ws, log, [userStep, { ...userStep, step_index: 3 }, answer("新的一轮。", 4)]);
  assert.deepEqual(runStop(ws, "11111111-1111-4111-8111-111111111109", { transcriptPath }), { decision: "allow" });
});

test("Stop 拒绝跨轮确认和旧启发式账本，并检查完整日志的最后一条答复", (t) => {
  const ws = makeTempDir(t, "11111111-1111-4111-8111-111111111110");
  writeIdeas(ws, "- [ ] 解释模块职责", 70);
  const delivered = ackToken(deliver(ws, "11111111-1111-4111-8111-111111111110"));
  const state = path.join(ws, ".agents", "fons", ".state-11111111-1111-4111-8111-111111111110.json");
  const records = JSON.parse(fs.readFileSync(state, "utf8"));
  const conversation = records;
  conversation.settledReadOnly = Object.fromEntries(Object.keys(conversation.delivered).map((id) => [id, true]));
  fs.writeFileSync(state, JSON.stringify(records));
  const oldAck = answer("旧回复。\n[FONS_ACK: " + delivered + "]");
  const nextUser = { ...userStep, step_index: 2 };
  const current = { ...answer("当前回复开头。", 3), truncated_fields: ["content"] };
  const transcriptPath = writeTranscript(ws, "transcript.jsonl", [
    userStep, oldAck, "{corrupted-half-json", nextUser, current,
  ]);
  const fullLog = "transcript_full.jsonl";
  writeTranscript(ws, fullLog, [
    userStep, oldAck, nextUser, answer("未给出回应。", 3),
    { step_index: 3, type: "GENERIC", content: oldAck.content },
  ]);
  const stop = runStop(ws, "11111111-1111-4111-8111-111111111110", { transcriptPath });
  assert.equal(stop.decision, "continue");

  const retry = ackToken(stop.reason);
  assert.notEqual(retry, delivered);
  const full = answer("回答了模块职责。\n[FONS_ACK: " + retry + "]", 3);
  writeTranscript(ws, fullLog, [userStep, oldAck, nextUser, full]);
  assert.deepEqual(runStop(ws, "11111111-1111-4111-8111-111111111110", { transcriptPath, continuationActive: true }), { decision: "allow" });
});

test("已完成的同文灵感重新加入时投递一次，归档不改变它的投递状态", (t) => {
  const ws = makeTempDir(t, "11111111-1111-4111-8111-111111111111");
  const text = "检查文档";
  const pending = "- [ ] " + text;
  const done = "【√】 " + text;
  const pre = { hookEventName: "PreInvocation", cwd: ws, conversationId: "11111111-1111-4111-8111-111111111111" };

  writeIdeas(ws, pending, 70);
  assert.match(deliver(ws, "11111111-1111-4111-8111-111111111111"), /检查文档/);
  writeIdeas(ws, done + "\n" + pending, 70);
  assert.match(deliver(ws, "11111111-1111-4111-8111-111111111111"), /检查文档/);

  archiveCompleted({ rootDir: ws, sessionId: "11111111-1111-4111-8111-111111111111" });
  assert.deepEqual(runHook(pre, { FONS_DEBOUNCE_SEC: "0" }), {});

  writeIdeas(ws, done, 70);
  archiveCompleted({ rootDir: ws, sessionId: "11111111-1111-4111-8111-111111111111" });
  writeIdeas(ws, pending, 70);
  assert.match(deliver(ws, "11111111-1111-4111-8111-111111111111"), /检查文档/);
});

test('No Project does not register a scratch cwd or deliver from it', (t) => {
  const cwd = makeTempDir(t, HOOK_A);
  const appData = path.join(cwd, 'host');
  const transcriptPath = path.join(appData, 'brain', HOOK_A, 'transcript.jsonl');
  const input = { cwd, workspacePaths: [], conversationId: HOOK_A, transcriptPath };
  writeIdeas(cwd, 'scratch marker', 70);
  assert.deepEqual(runHook({ ...input, hookEventName: 'SessionStart' }), {});
  assert.deepEqual(runHook({ ...input, hookEventName: 'PreInvocation' }, { FONS_DEBOUNCE_SEC: '0' }), {});
  assert.deepEqual(runStop(cwd, HOOK_A, input), { decision: 'allow' });
  assert.equal(fs.existsSync(path.join(appData, 'fons')), false);
  assert.equal(fs.existsSync(path.join(cwd, '.agents', 'fons', '.state-' + HOOK_A + '.json')), false);
});

test('SessionStart registers an empty session without creating a workspace inbox', (t) => {
  const ws = makeTempDir(t);
  const appData = path.join(ws, 'host');
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const transcriptPath = path.join(appData, 'brain', sessionId, 'transcript.jsonl');
  assert.deepEqual(runHook({ hookEventName: 'SessionStart', conversationId: sessionId, cwd: ws, transcriptPath, lastUserInput: 'first message' }), {});
  const index = path.join(appData, 'fons', 'conversations', `${sessionId}.json`);
  const entry = JSON.parse(fs.readFileSync(index, 'utf8'));
  assert.equal(entry.rootDir, ws);
  assert.equal(entry.title, 'first message');
  assert.equal(fs.existsSync(path.join(ws, '.agents', 'fons')), false);
});

test('the installed launcher starts Node for SessionStart even when the workspace inbox is empty', { skip: process.platform !== 'win32' }, (t) => {
  const ws = makeTempDir(t);
  const plugin = path.join(ws, '.agents', 'plugins', 'fons');
  fs.mkdirSync(path.join(plugin, 'scripts'), { recursive: true });
  fs.copyFileSync(HOOKS_JSON, path.join(plugin, 'hooks.json'));
  fs.copyFileSync(RUN_HOOK_CMD, path.join(plugin, 'scripts', 'run-hook.cmd'));
  fs.writeFileSync(path.join(plugin, 'scripts', 'fons-hook.mjs'), "process.stdout.write('NODE_STARTED');\n");
  const result = spawnSync('cmd.exe', ['/c', 'scripts\\run-hook.cmd', 'SessionStart'], { cwd: plugin, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'NODE_STARTED');
});

function launcherFixture(t, placement = 'local') {
  const root = makeTempDir(t);
  const plugin = placement === 'local' ? path.join(root, '.agents', 'plugins', 'fons') : path.join(root, 'global', 'fons');
  fs.mkdirSync(path.join(plugin, 'scripts'), { recursive: true });
  fs.copyFileSync(HOOKS_JSON, path.join(plugin, 'hooks.json'));
  fs.copyFileSync(RUN_HOOK_CMD, path.join(plugin, 'scripts', 'run-hook.cmd'));
  fs.writeFileSync(path.join(plugin, 'scripts', 'fons-hook.mjs'), "process.stdout.write('NODE_STARTED');\n");
  return { root, plugin, fonsDir: path.join(root, '.agents', 'fons') };
}

function launch(fixture, event) {
  const result = spawnSync('cmd.exe', ['/c', 'scripts\\run-hook.cmd', event], { cwd: fixture.plugin, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('launcher notices a nonempty session inbox created in an editor', { skip: process.platform !== 'win32' }, (t) => {
  const fixture = launcherFixture(t);
  fs.mkdirSync(fixture.fonsDir, { recursive: true });
  fs.writeFileSync(path.join(fixture.fonsDir, 'ideas-11111111-1111-4111-8111-111111111111.md'), '- [ ] manual\n');
  assert.equal(launch(fixture, 'PreInvocation'), 'NODE_STARTED');
});

test('launcher starts PreInvocation for an empty retraction marker but keeps Stop short-circuited', { skip: process.platform !== 'win32' }, (t) => {
  const fixture = launcherFixture(t);
  fs.mkdirSync(fixture.fonsDir, { recursive: true });
  fs.writeFileSync(path.join(fixture.fonsDir, '.retract-11111111-1111-4111-8111-111111111111.pending'), '');
  assert.equal(launch(fixture, 'PreInvocation'), 'NODE_STARTED');
  assert.deepEqual(JSON.parse(launch(fixture, 'Stop')), { decision: 'allow' });
});

test('launcher does not start Node for only a migration lock', { skip: process.platform !== 'win32' }, (t) => {
  const fixture = launcherFixture(t);
  fs.mkdirSync(path.join(fixture.fonsDir, '.migration.lock'), { recursive: true });
  assert.deepEqual(JSON.parse(launch(fixture, 'PreInvocation')), {});
  assert.deepEqual(JSON.parse(launch(fixture, 'Stop')), { decision: 'allow' });
});

test('launcher outside a workspace plugin mount does not apply workspace short circuit', { skip: process.platform !== 'win32' }, (t) => {
  const fixture = launcherFixture(t, 'global');
  assert.equal(launch(fixture, 'PreInvocation'), 'NODE_STARTED');
});

test('SessionStart strips line breaks, keeps twenty Unicode characters and never overwrites registration', (t) => {
  const ws = makeTempDir(t);
  const appData = path.join(ws, 'host');
  const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const transcriptPath = path.join(appData, 'brain', sessionId, 'transcript.jsonl');
  const input = { hookEventName: 'SessionStart', conversationId: sessionId, cwd: ws, transcriptPath, lastUserInput: `甲\n${'乙'.repeat(18)}😀丙` };
  assert.deepEqual(runHook(input), {});
  const file = path.join(appData, 'fons', 'conversations', `${sessionId}.json`);
  const before = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(before.title, `甲${'乙'.repeat(18)}😀`);
  assert.ok(before.registeredAt > 0);
  assert.deepEqual(runHook({ ...input, cwd: path.join(ws, 'other'), lastUserInput: 'replacement' }), {});
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), before);
});

const HOOK_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HOOK_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

test('invalid identifiers never read or write workspace files', (t) => {
  const ws = makeTempDir(t);
  for (const conversationId of ['', '../escape', 'CON']) {
    assert.deepEqual(runHook({ hookEventName: 'PreInvocation', conversationId, cwd: ws }), {});
    assert.deepEqual(runStop(ws, conversationId), { decision: 'allow' });
  }
  assert.equal(fs.existsSync(path.join(ws, '.agents')), false);
});

test('one session never reads an unrelated session ledger or archive', (t) => {
  const ws = makeTempDir(t, HOOK_A);
  writeIdeas(ws, '- [ ] private A', 70);
  const foreign = store.sessionPaths({ rootDir: ws, sessionId: HOOK_B });
  fs.mkdirSync(foreign.state, { recursive: true });
  fs.mkdirSync(foreign.archive, { recursive: true });
  const message = deliver(ws, HOOK_A);
  assert.match(message, /private A/);
  assert.deepEqual(runHook({ hookEventName: 'PreInvocation', conversationId: HOOK_B, cwd: ws }), {});
  assert.deepEqual(runStop(ws, HOOK_B), { decision: 'allow' });
  assert.equal(fs.statSync(foreign.state).isDirectory(), true);
});

test('a readonly item reopened after an ACK cannot reuse its old token', (t) => {
  const ws = makeTempDir(t, HOOK_A);
  writeIdeas(ws, '- [ ] answer once', 70);
  const firstToken = ackToken(deliver(ws, HOOK_A));
  const transcriptPath = writeTranscript(ws, 'reopen.jsonl', [userStep, answer(`answered\n[FONS_ACK: ${firstToken}]`)]);
  assert.deepEqual(runStop(ws, HOOK_A, { transcriptPath }), { decision: 'allow' });
  const ctx = { rootDir: ws, sessionId: HOOK_A };
  const row = store.readPoolSnapshot(ctx).items[0];
  assert.equal(row.doneSource, 'readonly_ack');
  store.reopenIdea({ ...ctx, rowIndex: row.rowIndex, expectedRaw: row.raw });
  const retry = runStop(ws, HOOK_A, { transcriptPath });
  assert.equal(retry.decision, 'continue');
  assert.notEqual(ackToken(retry.reason), firstToken);
  assert.match(retry.reason, /answer once/);
});

test('editing a delivered item causes the revised text to be delivered once', (t) => {
  const ws = makeTempDir(t, HOOK_A);
  writeIdeas(ws, '- [ ] initial', 70);
  assert.match(deliver(ws, HOOK_A), /initial/);
  const ctx = { rootDir: ws, sessionId: HOOK_A };
  const row = store.readPoolSnapshot(ctx).items[0];
  store.updateIdeaText({ ...ctx, rowIndex: row.rowIndex, expectedRaw: row.raw, newText: 'revised' });
  const message = runHook({ hookEventName: 'PreInvocation', conversationId: HOOK_A, cwd: ws }, { FONS_DEBOUNCE_SEC: '0' });
  assert.match(message.injectSteps[0].systemMessage.systemMessage, /revised/);
  assert.deepEqual(runHook({ hookEventName: 'PreInvocation', conversationId: HOOK_A, cwd: ws }, { FONS_DEBOUNCE_SEC: '0' }), {});
});

test('a retained migration lock leaves another session PreInvocation and Stop operational', (t) => {
  const ws = makeTempDir(t);
  const fonsDir = path.join(ws, '.agents', 'fons');
  const lock = path.join(fonsDir, '.migration.lock');
  fs.mkdirSync(lock, { recursive: true });
  const claimed = path.join(fonsDir, 'ideas.migrating-999999.md');
  fs.writeFileSync(claimed, '- [ ] preserved legacy\n');
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: 999999, startedAt: 1, step: 'publishing' }));
  const ctx = { rootDir: ws, sessionId: HOOK_B };
  store.addIdeas({ ...ctx, texts: ['new independent item'] });
  const message = runHook({ hookEventName: 'PreInvocation', cwd: ws, conversationId: HOOK_B }, { FONS_DEBOUNCE_SEC: '0' });
  assert.match(message.injectSteps[0].systemMessage.systemMessage, /new independent item/);
  const stop = runStop(ws, HOOK_B);
  assert.equal(stop.decision, 'continue');
  assert.match(stop.reason, /new independent item/);
  assert.equal(fs.readFileSync(claimed, 'utf8'), '- [ ] preserved legacy\n');
  assert.equal(fs.existsSync(lock), true);
});

test('countdown follows the same pending signature as Hook and flush delivers immediately', (t) => {
  const ws = makeTempDir(t, HOOK_A);
  const ctx = { rootDir: ws, sessionId: HOOK_A };
  writeIdeas(ws, '- [ ] sent', 70);
  assert.match(deliver(ws, HOOK_A), /sent/);
  store.addIdeas({ ...ctx, texts: ['draft'] });
  const pre = { hookEventName: 'PreInvocation', conversationId: HOOK_A, cwd: ws };
  assert.deepEqual(runHook(pre), {});
  const statePath = store.sessionPaths(ctx).state;
  const before = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const snap = store.readPoolSnapshot(ctx);
  assert.ok(snap.debounceRemainingMs > 0 && snap.debounceRemainingMs <= 60000);
  const delivered = snap.items.find((row) => row.text === 'sent');
  store.completeIdea({ ...ctx, token: delivered.token });
  assert.deepEqual(runHook(pre), {});
  archiveCompleted(ctx);
  assert.deepEqual(runHook(pre), {});
  const after = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(after.pendingSigAt, before.pendingSigAt);
  assert.equal(after.pendingSig, before.pendingSig);
  store.requestFlush(ctx);
  assert.equal(store.readPoolSnapshot(ctx).debounceRemainingMs, 0);
  assert.match(runHook(pre).injectSteps[0].systemMessage.systemMessage, /draft/);
  assert.equal(store.readPoolSnapshot(ctx).flushPending, false);
});

test('launcher sends a last-item retraction once and then resumes empty fast exit', { skip: process.platform !== 'win32' }, (t) => {
  const fixture = launcherFixture(t);
  for (const name of ['fons-hook.mjs', 'fons-inbox.mjs', 'fons-store.mjs']) {
    fs.copyFileSync(path.join(path.dirname(HOOK_SCRIPT), name), path.join(fixture.plugin, 'scripts', name));
  }
  const ctx = { rootDir: fixture.root, sessionId: HOOK_A };
  store.addIdeas({ ...ctx, texts: ['remove last'] });
  const pre = { hookEventName: 'PreInvocation', conversationId: HOOK_A, cwd: fixture.root };
  const first = runHookCmd(fixture.plugin, 'PreInvocation', pre, { FONS_DEBOUNCE_SEC: '0' });
  assert.match(first.injectSteps[0].systemMessage.systemMessage, /remove last/);
  const row = store.readPoolSnapshot(ctx).items[0];
  store.removeIdea({ ...ctx, rowIndex: row.rowIndex, expectedRaw: row.raw });
  const withdrawal = runHookCmd(fixture.plugin, 'PreInvocation', pre);
  assert.match(withdrawal.injectSteps[0].systemMessage.systemMessage, /\[FONS 撤回\][\s\S]*remove last/);
  assert.deepEqual(runHookCmd(fixture.plugin, 'PreInvocation', pre), {});
  assert.deepEqual(runHookCmd(fixture.plugin, 'Stop', { ...pre, hookEventName: 'Stop', terminationReason: 'NO_TOOL_CALL', fullyIdle: true }), { decision: 'allow' });
  fs.writeFileSync(path.join(fixture.plugin, 'scripts', 'fons-hook.mjs'), "process.stdout.write('NODE_STARTED');\n");
  assert.deepEqual(JSON.parse(launch(fixture, 'PreInvocation')), {});
});

test('POSIX launcher short circuits an empty inbox and detects an editor-created session inbox', { skip: process.platform === 'win32' }, (t) => {
  const ws = makeTempDir(t);
  const plugin = path.join(ws, '.agents', 'plugins', 'fons');
  fs.mkdirSync(path.join(plugin, 'scripts'), { recursive: true });
  fs.copyFileSync(HOOKS_JSON, path.join(plugin, 'hooks.json'));
  fs.copyFileSync(path.join(path.dirname(HOOK_SCRIPT), 'run-hook.sh'), path.join(plugin, 'scripts', 'run-hook.sh'));
  fs.writeFileSync(path.join(plugin, 'scripts', 'fons-hook.mjs'), "process.stdout.write('NODE_STARTED');\n");
  const invoke = () => spawnSync('sh', ['scripts/run-hook.sh', 'PreInvocation'], { cwd: plugin, encoding: 'utf8' });
  assert.equal(invoke().stdout.trim(), '{}');
  const dir = path.join(ws, '.agents', 'fons');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `ideas-${HOOK_A}.md`), '- [ ] manual\n');
  assert.equal(invoke().stdout.trim(), 'NODE_STARTED');
});

test('an old session registers only when a nonempty workspace inbox lets its launcher run', { skip: process.platform !== 'win32' }, (t) => {
  const fixture = launcherFixture(t);
  for (const name of ['fons-hook.mjs', 'fons-inbox.mjs', 'fons-store.mjs']) {
    fs.copyFileSync(path.join(path.dirname(HOOK_SCRIPT), name), path.join(fixture.plugin, 'scripts', name));
  }
  const appData = path.join(fixture.root, 'host');
  const transcriptPath = path.join(appData, 'brain', HOOK_A, 'transcript.jsonl');
  const input = { hookEventName: 'PreInvocation', conversationId: HOOK_A, cwd: fixture.root, transcriptPath, lastUserInput: 'old session' };
  const index = path.join(appData, 'fons', 'conversations', `${HOOK_A}.json`);
  assert.deepEqual(runHookCmd(fixture.plugin, 'PreInvocation', input), {});
  assert.equal(fs.existsSync(index), false);
  store.addIdeas({ rootDir: fixture.root, sessionId: HOOK_B, texts: ['other session'] });
  assert.deepEqual(runHookCmd(fixture.plugin, 'PreInvocation', input), {});
  const registered = JSON.parse(fs.readFileSync(index, 'utf8'));
  assert.equal(registered.rootDir, fixture.root);
  assert.equal(registered.title, 'old session');
  assert.deepEqual(runHookCmd(fixture.plugin, 'PreInvocation', { ...input, lastUserInput: 'changed' }), {});
  assert.deepEqual(JSON.parse(fs.readFileSync(index, 'utf8')), registered);
});

test('Hook migration preserves a delivered item without injecting it again', (t) => {
  const ws = makeTempDir(t);
  const dir = path.join(ws, '.agents', 'fons');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ideas.md'), '- [ ] already delivered\n');
  const id = crypto.createHash('sha1').update('already delivered').digest('hex').slice(0, 12);
  fs.writeFileSync(path.join(dir, '.state.json'), JSON.stringify({ [HOOK_A]: { delivered: { [id]: { text: 'already delivered', deliveredAt: 1, ackToken: 'aaaaaaaaaaaaaaaa' } } } }));
  const input = { hookEventName: 'PreInvocation', cwd: ws, conversationId: HOOK_A };
  assert.deepEqual(runHook(input, { FONS_DEBOUNCE_SEC: '0' }), {});
  assert.deepEqual(runHook(input, { FONS_DEBOUNCE_SEC: '0' }), {});
  const item = store.readPoolSnapshot({ rootDir: ws, sessionId: HOOK_A }).items[0];
  assert.equal(item.status, 'delivered');
  assert.equal(fs.existsSync(path.join(dir, 'ideas.md')), false);
});

test('a concurrent flush does not lose Hook delivery or UI state', async (t) => {
  const ws = makeTempDir(t, HOOK_A);
  const ctx = { rootDir: ws, sessionId: HOOK_A };
  writeIdeas(ws, '- [ ] parallel', 70);
  const proc = spawn(process.execPath, [HOOK_SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, FONS_DEBOUNCE_SEC: '0' } });
  let output = '';
  let stderr = '';
  proc.stdout.on('data', (part) => { output += part; });
  proc.stderr.on('data', (part) => { stderr += part; });
  const done = new Promise((resolve, reject) => {
    proc.once('error', reject);
    proc.once('close', (code) => resolve(code));
  });
  const storeUrl = new URL('../scripts/fons-store.mjs', import.meta.url).href;
  const uiScript = `import { requestFlush } from ${JSON.stringify(storeUrl)}; requestFlush({ rootDir: process.argv[1], sessionId: process.argv[2] });`;
  const ui = spawn(process.execPath, ['--input-type=module', '-e', uiScript, ws, HOOK_A], { stdio: ['ignore', 'ignore', 'pipe'] });
  let uiError = '';
  ui.stderr.on('data', (part) => { uiError += part; });
  const uiDone = new Promise((resolve, reject) => {
    ui.once('error', reject);
    ui.once('close', (code) => resolve(code));
  });
  proc.stdin.end(JSON.stringify({ hookEventName: 'PreInvocation', cwd: ws, conversationId: HOOK_A }));
  const [hookCode, uiCode] = await Promise.all([done, uiDone]);
  assert.equal(hookCode, 0, stderr);
  assert.equal(uiCode, 0, uiError);
  assert.match(JSON.parse(output).injectSteps[0].systemMessage.systemMessage, /parallel/);
  const files = store.sessionPaths(ctx);
  assert.ok(Object.keys(JSON.parse(fs.readFileSync(files.state, 'utf8')).delivered).length);
  assert.ok(JSON.parse(fs.readFileSync(files.ui, 'utf8')).flushRequestedAt > 0);
});

function itemFor(ctx, text) {
  const item = store.readPoolSnapshot(ctx).items.find((row) => row.text === text);
  assert.ok(item, `missing item ${text}`);
  return item;
}

function removeCurrent(ctx, text) {
  const item = itemFor(ctx, text);
  store.removeIdea({ ...ctx, rowIndex: item.rowIndex, expectedRaw: item.raw });
}

function preNow(ctx) {
  return runHook({ hookEventName: 'PreInvocation', cwd: ctx.rootDir, conversationId: ctx.sessionId }, { FONS_DEBOUNCE_SEC: '0' });
}

function assertReaddedMessage(message, text, deliveryTag = '[FONS]') {
  const withdraw = message.indexOf('[FONS 撤回]');
  const delivery = message.indexOf(deliveryTag);
  assert.ok(withdraw >= 0 && delivery > withdraw, 'withdrawal precedes the new delivery');
  assert.match(message, /重新添加/);
  assert.equal(message.split('[FONS 撤回]').length - 1, 1);
  assert.equal(message.split(text).length - 1, 2);
}

test('deleting and re-adding delivered text twice sends each withdrawal and new delivery once', (t) => {
  const ws = makeTempDir(t);
  const ctx = { rootDir: ws, sessionId: HOOK_A };
  const text = '同文补充';
  store.addIdeas({ ...ctx, texts: [text] });
  const id = itemFor(ctx, text).id;
  const initial = preNow(ctx).injectSteps[0].systemMessage.systemMessage;
  const firstToken = ackToken(initial);
  const tokens = [firstToken];
  for (let round = 0; round < 2; round++) {
    removeCurrent(ctx, text);
    assert.deepEqual(runStop(ws, HOOK_A), { decision: 'allow' });
    store.addIdeas({ ...ctx, texts: [text] });
    assert.equal(itemFor(ctx, text).id, id);
    const result = preNow(ctx);
    assert.ok(result.injectSteps, 're-added item and withdrawal are sent');
    const message = result.injectSteps[0].systemMessage.systemMessage;
    assertReaddedMessage(message, text);
    const token = ackToken(message);
    assert.equal(tokens.includes(token), false);
    tokens.push(token);
    assert.deepEqual(preNow(ctx), {});
  }
  const transcriptPath = writeTranscript(ws, 'previous-ack.jsonl', [userStep, answer(`old response\n[FONS_ACK: ${tokens[1]}]`)]);
  const retry = runStop(ws, HOOK_A, { transcriptPath });
  assert.equal(retry.decision, 'continue');
  const retryToken = ackToken(retry.reason);
  assert.equal(tokens.includes(retryToken), false);
  writeTranscript(ws, 'previous-ack.jsonl', [userStep, answer(`current response\n[FONS_ACK: ${retryToken}]`)]);
  assert.deepEqual(runStop(ws, HOOK_A, { transcriptPath, continuationActive: true }), { decision: 'allow' });
});


test('Stop before Pre sends the withdrawal followed by the re-added item and rejects the old ACK', (t) => {
  const ws = makeTempDir(t);
  const ctx = { rootDir: ws, sessionId: HOOK_A };
  const text = '优先收尾的同文补充';
  store.addIdeas({ ...ctx, texts: [text] });
  const id = itemFor(ctx, text).id;
  const initial = preNow(ctx).injectSteps[0].systemMessage.systemMessage;
  const previousToken = ackToken(initial);
  removeCurrent(ctx, text);
  assert.deepEqual(runStop(ws, HOOK_A), { decision: 'allow' });
  store.addIdeas({ ...ctx, texts: [text] });
  assert.equal(itemFor(ctx, text).id, id);
  const transcriptPath = writeTranscript(ws, 'stop-first.jsonl', [userStep, answer(`old\n[FONS_ACK: ${previousToken}]`)]);
  const stop = runStop(ws, HOOK_A, { transcriptPath });
  assert.equal(stop.decision, 'continue');
  assertReaddedMessage(stop.reason, text, '[FONS 收尾核对]');
  const currentToken = ackToken(stop.reason);
  assert.notEqual(currentToken, previousToken);
  assert.deepEqual(preNow(ctx), {});
  writeTranscript(ws, 'stop-first.jsonl', [userStep, answer(`current\n[FONS_ACK: ${currentToken}]`)]);
  assert.deepEqual(runStop(ws, HOOK_A, { transcriptPath, continuationActive: true }), { decision: 'allow' });
  assert.deepEqual(preNow(ctx), {});
});

test('model completion preserves another draft timer and editing that draft resets it', (t) => {
  const ws = makeTempDir(t);
  const ctx = { rootDir: ws, sessionId: HOOK_A };
  const paths = store.sessionPaths(ctx);
  const pre = { hookEventName: 'PreInvocation', cwd: ws, conversationId: HOOK_A };
  store.addIdeas({ ...ctx, texts: ['sent'] });
  assert.match(preNow(ctx).injectSteps[0].systemMessage.systemMessage, /sent/);
  store.addIdeas({ ...ctx, texts: ['draft'] });
  const initialMtime = new Date(Date.now() - 30000);
  fs.utimesSync(paths.ideas, initialMtime, initialMtime);
  assert.deepEqual(runHook(pre), {});
  const initial = JSON.parse(fs.readFileSync(paths.state, 'utf8'));
  assert.equal(initial.pendingSigAt, fs.statSync(paths.ideas).mtimeMs);
  fs.writeFileSync(paths.ideas, '【√】 sent\n- [ ] draft\n');
  const completionMtime = new Date(Date.now() - 15000);
  fs.utimesSync(paths.ideas, completionMtime, completionMtime);
  assert.deepEqual(runHook(pre), {});
  const afterCompletion = JSON.parse(fs.readFileSync(paths.state, 'utf8'));
  assert.equal(afterCompletion.pendingSig, initial.pendingSig);
  assert.equal(afterCompletion.pendingSigAt, initial.pendingSigAt);
  fs.writeFileSync(paths.ideas, '【√】 sent\n- [ ] revised draft\n');
  const editMtime = new Date(Date.now() - 5000);
  fs.utimesSync(paths.ideas, editMtime, editMtime);
  const expectedAt = fs.statSync(paths.ideas).mtimeMs;
  assert.deepEqual(runHook(pre), {});
  const afterEdit = JSON.parse(fs.readFileSync(paths.state, 'utf8'));
  assert.notEqual(afterEdit.pendingSig, initial.pendingSig);
  assert.equal(afterEdit.pendingSigAt, expectedAt);
  assert.ok(afterEdit.pendingSigAt > initial.pendingSigAt);
  const snapshot = store.readPoolSnapshot({ ...ctx, debounceMs: 60000, now: expectedAt + 2000 });
  assert.equal(snapshot.debounceRemainingMs, 58000);
  assert.equal(snapshot.items.find((item) => item.text === 'sent').status, 'done');
  assert.equal(snapshot.items.find((item) => item.text === 'revised draft').status, 'buffering');
});
