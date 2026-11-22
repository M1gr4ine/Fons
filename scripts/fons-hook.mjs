import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { adapters } from "../adapters/index.mjs";

function readOption(argv, name, fallback) {
  let value = fallback;
  const prefix = name + "=";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith(prefix)) value = arg.slice(prefix.length);
    else if (arg === name) value = argv[++i] ?? "";
  }
  return value;
}

export function evaluateHook(input, scopeMode = "all", host = "antigravity") {
  if (!Object.hasOwn(adapters, host)) throw new Error("无效的 Hook 宿主：" + host);
  return adapters[host](input, scopeMode);
}

function parseHookInput(raw) {
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

export function runMain(argv = process.argv.slice(2)) {
  const scopeMode = readOption(argv, "--scope", "all");
  if (!["all", "workspace", "no-workspace", "global"].includes(scopeMode)) {
    throw new Error("无效的 Hook 作用域：" + scopeMode);
  }
  const host = readOption(argv, "--host", "antigravity");
  const input = parseHookInput(fs.readFileSync(0, "utf8"));
  process.stdout.write(JSON.stringify(evaluateHook(input, scopeMode, host)));
}

function isMainModule() {
  if (typeof import.meta.main === "boolean") return import.meta.main;
  if (!process.argv[1]) return false;
  return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  runMain();
}
