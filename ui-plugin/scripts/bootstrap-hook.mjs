import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resolveRepoRoot(pluginRoot) {
  const pointer = path.join(pluginRoot, 'fons-root.json');
  if (fs.existsSync(pointer)) {
    const { root } = JSON.parse(fs.readFileSync(pointer, 'utf8'));
    if (typeof root !== 'string' || !root.trim()) throw new Error('fons-root.json 缺少有效的 root 路径。');
    return path.resolve(root);
  }
  return path.resolve(pluginRoot, '..');
}

function findBrainAppData(startPath) {
  if (typeof startPath !== 'string' || !startPath.trim()) return null;
  let dir = path.resolve(startPath);
  while (true) {
    if (path.basename(dir).toLowerCase() === 'brain') return path.dirname(dir);
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function resolveFastFonsDir(input) {
  const isNoWorkspace = Array.isArray(input.workspacePaths) ? input.workspacePaths.length === 0 : !input.cwd;
  if (isNoWorkspace) {
    const appData = findBrainAppData(input.transcriptPath) || findBrainAppData(input.artifactDirectoryPath);
    return appData ? path.join(appData, 'fons', 'no-workspace') : null;
  }
  const rootDir = input.cwd || input.workspacePaths?.[0];
  return typeof rootDir === 'string' && rootDir.trim() ? path.join(path.resolve(rootDir), '.agents', 'fons') : null;
}

function hasPendingWork(input, event) {
  if (event === 'SessionStart') return true;
  const sessionId = input.conversationId;
  if (typeof sessionId !== 'string' || !UUID.test(sessionId)) return false;
  const fonsDir = resolveFastFonsDir(input);
  if (!fonsDir) return false;
  const ideas = fs.statSync(path.join(fonsDir, `ideas-${sessionId}.md`), { throwIfNoEntry: false });
  if (ideas?.size) return true;
  return event === 'PreInvocation' && fs.existsSync(path.join(fonsDir, `.retract-${sessionId}.pending`));
}

const rawInput = fs.readFileSync(0, 'utf8');
const input = rawInput ? JSON.parse(rawInput) : {};
const event = input.hookEventName;
const fallback = event === 'Stop' ? { decision: 'allow' } : {};

if (
  !['PreInvocation', 'SessionStart', 'Stop'].includes(event) ||
  (event === 'Stop' && (input.terminationReason !== 'NO_TOOL_CALL' || input.fullyIdle === false)) ||
  !hasPendingWork(input, event)
) {
  process.stdout.write(JSON.stringify(fallback));
} else {
  const realDir = fs.realpathSync(path.dirname(fileURLToPath(import.meta.url)));
  const repoRoot = resolveRepoRoot(path.resolve(realDir, '..'));
  const hookPath = path.join(repoRoot, 'scripts', 'fons-hook.mjs');
  const { evaluateHook } = await import(pathToFileURL(hookPath).href);
  process.stdout.write(JSON.stringify(evaluateHook(input, 'global')));
}
