import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexAppData } from '../adapters/codex.mjs';
import {
  assertNoDirectFonsHooks, packageFiles, packageVersion, publishPackage, readOptionalJson,
} from '../scripts/fons-package.mjs';
import { writeJsonAtomic } from '../scripts/fons-store.mjs';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const MARKETPLACE = 'fons-local';
const PLUGIN_ID = 'fons@' + MARKETPLACE;
const PLUGIN_FILES = [
  '.codex-plugin/plugin.json',
  '.mcp.json',
  'adapters/antigravity.mjs',
  'adapters/claude.mjs',
  'adapters/codex.mjs',
  'adapters/index.mjs',
  'adapters/shared.mjs',
  'assets/logo.svg',
  'assets/sidebar-icon.svg',
  'codex/fons-mcp.mjs',
  'codex/fons-mcp-ui.mjs',
  'hooks/hooks.json',
  'scripts/fons-config.mjs',
  'scripts/fons-engine.mjs',
  'scripts/fons-hook.mjs',
  'scripts/fons-inbox.mjs',
  'scripts/fons-package.mjs',
  'scripts/fons-store.mjs',
  'sidecars/fons-pool/index.html',
  'sidecars/fons-pool/main.mjs',
];

function checkExistingHooks(codexHome, cwd, rootOverride) {
  const files = new Set([path.join(codexHome, 'hooks.json')]);
  if (rootOverride) files.add(path.resolve(cwd, rootOverride, '.codex', 'hooks.json'));
  for (let dir = path.resolve(cwd); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    files.add(path.join(dir, '.codex', 'hooks.json'));
  }
  assertNoDirectFonsHooks(files);
}

function publishMarketplace(file, sourcePath) {
  const previous = readOptionalJson(file);
  if (previous && (previous.name !== MARKETPLACE || !Array.isArray(previous.plugins))) {
    throw new Error('插件市场文件已被其他配置占用（' + file + '）。');
  }
  const catalog = previous ?? {
    name: MARKETPLACE,
    interface: { displayName: 'Fons 本地插件' },
    plugins: [],
  };
  const oldPlugin = catalog.plugins.find((plugin) => plugin?.name === 'fons');
  if (oldPlugin?.source?.path === sourcePath) return;

  const plugin = {
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    category: 'Productivity',
    ...oldPlugin,
    name: 'fons',
    source: { source: 'local', path: sourcePath },
  };
  catalog.plugins = catalog.plugins.filter((entry) => entry?.name !== 'fons');
  catalog.plugins.push(plugin);

  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, catalog);
}

export function prepareCodexPlugin({ env = process.env, cwd = process.cwd() } = {}) {
  const codexHome = codexAppData(env, undefined, cwd);
  checkExistingHooks(codexHome, cwd, env.FONS_ROOT?.trim());

  const marketplaceRoot = path.join(codexHome, 'fons', 'plugin-marketplace');
  const marketplaceFile = path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json');
  const files = packageFiles(REPO_ROOT, PLUGIN_FILES);
  const sourcePath = './plugins/fons-' + packageVersion(files);
  publishPackage(path.resolve(marketplaceRoot, sourcePath), files);
  publishMarketplace(marketplaceFile, sourcePath);
  return { marketplaceRoot, pluginId: PLUGIN_ID };
}
