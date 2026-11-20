import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function resolveRepoRoot(pluginRoot) {
  const pointer = path.join(pluginRoot, 'fons-root.json');
  if (fs.existsSync(pointer)) {
    const { root } = JSON.parse(fs.readFileSync(pointer, 'utf8'));
    if (typeof root !== 'string' || !root.trim()) throw new Error('fons-root.json 缺少有效的 root 路径。');
    return path.resolve(root);
  }
  return path.resolve(pluginRoot, '..');
}

const rawInput = fs.readFileSync(0, 'utf8');
const input = rawInput ? JSON.parse(rawInput) : {};
const event = input.hookEventName;
const fallback = event === 'Stop' ? { decision: 'allow' } : {};

if (
  !['PreInvocation', 'SessionStart', 'Stop'].includes(event) ||
  (Array.isArray(input.workspacePaths) ? input.workspacePaths.length > 0 : Boolean(input.cwd)) ||
  (event === 'Stop' && (input.terminationReason !== 'NO_TOOL_CALL' || input.fullyIdle === false))
) {
  process.stdout.write(JSON.stringify(fallback));
} else {
  const realDir = fs.realpathSync(path.dirname(fileURLToPath(import.meta.url)));
  const repoRoot = resolveRepoRoot(path.resolve(realDir, '..'));
  const hookPath = path.join(repoRoot, 'scripts', 'fons-hook.mjs');
  const { evaluateHook } = await import(pathToFileURL(hookPath).href);
  process.stdout.write(JSON.stringify(evaluateHook(input, 'no-workspace')));
}
