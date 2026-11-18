import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK_SCRIPT = path.join(REPO_ROOT, "scripts", "fons-hook.mjs");
const RUN_HOOK_CMD = path.join(REPO_ROOT, "scripts", "run-hook.cmd");
const HOOKS_JSON = path.join(REPO_ROOT, "hooks.json");
const FONS_BIN = path.join(REPO_ROOT, "bin", process.platform === "win32" ? "fons.cmd" : "fons");

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fons-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeIdeas(workspaceDir, content, ageSeconds = 0) {
  const fonsDir = path.join(workspaceDir, ".agents", "fons");
  fs.mkdirSync(fonsDir, { recursive: true });
  const ideasPath = path.join(fonsDir, "ideas.md");
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
  const ws = makeTempDir(t);
  const preInput = { hookEventName: "PreInvocation", conversationId: "c1", cwd: ws };
  const stopInput = {
    hookEventName: "Stop",
    conversationId: "c1",
    cwd: ws,
    terminationReason: "NO_TOOL_CALL",
    fullyIdle: true,
    continuationActive: false,
  };

  assert.deepEqual(runHook(preInput), {});
  assert.deepEqual(runHook(stopInput), { decision: "allow" });

  writeIdeas(ws, "", 120);
  assert.deepEqual(runHook(preInput), {});
  assert.deepEqual(runHook(stopInput), { decision: "allow" });

  writeIdeas(
    ws,
    [
      "# 灵感池",
      "",
      "-",
      "*",
      "- [ ]   ",
      "- [x] 已完成条目一",
      "- [X] 已完成条目二",
      "* [x] 已完成条目三",
    ].join("\n"),
    120
  );
  assert.deepEqual(runHook(preInput), {});
  assert.deepEqual(runHook(stopInput), { decision: "allow" });
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

  assert.deepEqual(
    runHookCmd(localPluginDir, "PreInvocation", {
      hookEventName: "PreInvocation",
      conversationId: "w1",
      cwd: localWs,
    }),
    {}
  );
  assert.deepEqual(
    runHookCmd(localPluginDir, "Stop", {
      hookEventName: "Stop",
      conversationId: "w1",
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

  const targetWs = path.join(root, "target-ws");
  writeIdeas(targetWs, "- [ ] 补充全局安装隔离测试", 70);

  const out = runHookCmd(globalPluginDir, "PreInvocation", {
    hookEventName: "PreInvocation",
    conversationId: "g1",
    cwd: targetWs,
  });
  assert.equal(out.injectSteps.length, 1);
  assert.match(out.injectSteps[0].systemMessage.systemMessage, /\[FONS\][\s\S]*1\. 补充全局安装隔离测试/);
});

test("PreInvocation 消抖、合并编号、幂等去重与跨会话独立账本", (t) => {
  const ws = makeTempDir(t);
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
    runHook({ hookEventName: "PreInvocation", conversationId: "s1", cwd: ws }),
    {}
  );
  assert.equal(fs.existsSync(path.join(ws, ".agents", "fons", ".state.json")), false);

  // 消抖窗口期满（65s >= 60s）：合并编号并写入 delivered
  writeIdeas(ws, ideasContent, 65);
  const firstOut = runHook({ hookEventName: "PreInvocation", conversationId: "s1", cwd: ws });
  const msg = firstOut.injectSteps[0].systemMessage.systemMessage;
  assert.match(msg, /^\[FONS\]/);
  assert.match(
    msg,
    /1\. 导出接口补充 created_at 字段\n2\. 增加导出权限校验\n3\. 补充错误码文档$/
  );

  // 同会话二次调用不重复注入
  assert.deepEqual(
    runHook({ hookEventName: "PreInvocation", conversationId: "s1", cwd: ws }),
    {}
  );

  // 新增条目且过消抖期后仅注入新增条目
  writeIdeas(ws, `${ideasContent}\n- [ ] 新增第四条灵感`, 65);
  const deltaOut = runHook({ hookEventName: "PreInvocation", conversationId: "s1", cwd: ws });
  const deltaMsg = deltaOut.injectSteps[0].systemMessage.systemMessage;
  assert.match(deltaMsg, /1\. 新增第四条灵感$/);
  assert.doesNotMatch(deltaMsg, /created_at/);

  // 换新会话：独立账本重新完整投递
  const newConvOut = runHook({ hookEventName: "PreInvocation", conversationId: "s2", cwd: ws });
  assert.match(newConvOut.injectSteps[0].systemMessage.systemMessage, /4\. 新增第四条灵感$/);

  // FONS_DEBOUNCE_SEC=0 时立即投递
  writeIdeas(ws, "- [ ] 零秒消抖即时测试", 0);
  const zeroDebounceOut = runHook(
    { hookEventName: "PreInvocation", conversationId: "s3", cwd: ws },
    { FONS_DEBOUNCE_SEC: "0" }
  );
  assert.match(zeroDebounceOut.injectSteps[0].systemMessage.systemMessage, /1\. 零秒消抖即时测试$/);
});

test("Stop 收尾兜底、避免续跑重复注入与防死循环上限", (t) => {
  const ws = makeTempDir(t);
  writeIdeas(ws, "- [ ] 未满消抖即结束的任务补充", 0);

  // 1. 非正常结束或后台未空闲时直接放行
  assert.deepEqual(
    runHook({
      hookEventName: "Stop",
      conversationId: "stop-1",
      cwd: ws,
      terminationReason: "USER_CANCELED",
      fullyIdle: true,
      continuationActive: false,
    }),
    { decision: "allow" }
  );
  assert.deepEqual(
    runHook({
      hookEventName: "Stop",
      conversationId: "stop-1",
      cwd: ws,
      terminationReason: "NO_TOOL_CALL",
      fullyIdle: false,
      continuationActive: false,
    }),
    { decision: "allow" }
  );

  // 2. 正常结束且未投递时触发 Stop 兜底续跑
  const stopOut1 = runHook({
    hookEventName: "Stop",
    conversationId: "stop-1",
    cwd: ws,
    terminationReason: "NO_TOOL_CALL",
    fullyIdle: true,
    continuationActive: false,
  });
  assert.equal(stopOut1.decision, "continue");
  assert.match(stopOut1.reason, /\[FONS 收尾核对\][\s\S]*1\. 未满消抖即结束的任务补充/);

  // 3. 续跑期间紧接着的 PreInvocation 不应重复注入 Stop 已兜底的条目
  writeIdeas(ws, "- [ ] 未满消抖即结束的任务补充", 65);
  assert.deepEqual(
    runHook({ hookEventName: "PreInvocation", conversationId: "stop-1", cwd: ws }),
    {}
  );

  // 4. continuationActive=true 且条目未变时防死循环放行
  assert.deepEqual(
    runHook({
      hookEventName: "Stop",
      conversationId: "stop-1",
      cwd: ws,
      terminationReason: "NO_TOOL_CALL",
      fullyIdle: true,
      continuationActive: true,
    }),
    { decision: "allow" }
  );

  // 5. 同一轮内条目持续变化也最多续跑 2 次
  writeIdeas(ws, "- [ ] 未满消抖即结束的任务补充\n- [ ] 续跑时新加第二条", 0);
  const stopOut2 = runHook({
    hookEventName: "Stop",
    conversationId: "stop-1",
    cwd: ws,
    terminationReason: "NO_TOOL_CALL",
    fullyIdle: true,
    continuationActive: true,
  });
  assert.equal(stopOut2.decision, "continue");

  writeIdeas(ws, "- [ ] 未满消抖即结束的任务补充\n- [ ] 续跑时新加第二条\n- [ ] 第三条", 0);
  assert.deepEqual(
    runHook({
      hookEventName: "Stop",
      conversationId: "stop-1",
      cwd: ws,
      terminationReason: "NO_TOOL_CALL",
      fullyIdle: true,
      continuationActive: true,
    }),
    { decision: "allow" }
  );
});

test("CLI (fons) 追加、查看、子目录寻根与归档闭环", (t) => {
  const ws = makeTempDir(t);
  const subDir = path.join(ws, "src", "nested");
  fs.mkdirSync(path.join(ws, ".agents", "fons"), { recursive: true });
  fs.mkdirSync(subDir, { recursive: true });

  // 帮助与无参校验
  const noArg = runCli([], { cwd: ws });
  assert.equal(noArg.status, 1);
  assert.match(noArg.stderr, /用法:/);

  const helpRes = runCli(["help"], { cwd: ws });
  assert.equal(helpRes.status, 0);
  assert.match(helpRes.stdout, /fons archive/);

  // 预先写入无尾换行的已有文件，测试追加自动换行及剥离前导 - [ ]
  const ideasPath = path.join(ws, ".agents", "fons", "ideas.md");
  fs.writeFileSync(ideasPath, "- [ ] 已有无尾换行条目", "utf8");

  const add1 = runCli(["- [ ] 补充中文测试条目A"], { cwd: subDir });
  assert.equal(add1.status, 0, add1.stderr);

  const add2 = runCli(["补充中文测试条目B"], { cwd: subDir });
  assert.equal(add2.status, 0, add2.stderr);

  const listRes = runCli(["list"], { cwd: subDir });
  assert.equal(listRes.status, 0);
  assert.equal(
    listRes.stdout.trim(),
    ["1. 已有无尾换行条目", "2. 补充中文测试条目A", "3. 补充中文测试条目B"].join("\n")
  );

  // 勾选部分条目后归档
  fs.writeFileSync(
    ideasPath,
    ["- [x] 已有无尾换行条目", "- [X] 补充中文测试条目A", "- [ ] 补充中文测试条目B"].join("\n") + "\n",
    "utf8"
  );
  const arch1 = runCli(["archive"], { cwd: ws });
  assert.equal(arch1.status, 0);
  assert.match(arch1.stdout, /已归档 2 条/);

  const archivePath = path.join(ws, ".agents", "fons", "archive.md");
  assert.equal(
    fs.readFileSync(archivePath, "utf8"),
    "- [x] 已有无尾换行条目\n- [X] 补充中文测试条目A\n"
  );
  assert.equal(fs.readFileSync(ideasPath, "utf8"), "- [ ] 补充中文测试条目B\n");

  // 勾选剩余最后一条后再次归档：ideas.md 应恢复为 0 字节
  fs.writeFileSync(ideasPath, "- [x] 补充中文测试条目B\n", "utf8");
  const arch2 = runCli(["archive"], { cwd: ws });
  assert.equal(arch2.status, 0);
  assert.equal(fs.statSync(ideasPath).size, 0);
  assert.equal(
    fs.readFileSync(archivePath, "utf8"),
    "- [x] 已有无尾换行条目\n- [X] 补充中文测试条目A\n- [x] 补充中文测试条目B\n"
  );
});
