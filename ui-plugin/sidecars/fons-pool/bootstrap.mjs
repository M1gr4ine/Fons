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

const realDir = fs.realpathSync(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = resolveRepoRoot(path.resolve(realDir, '..', '..'));
const mainPath = path.join(repoRoot, 'sidecars', 'fons-pool', 'main.mjs');
const { startSidecar } = await import(pathToFileURL(mainPath).href);
await startSidecar();
