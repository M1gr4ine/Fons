import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexAppData } from '../adapters/codex.mjs';
import { writeJsonAtomic } from '../scripts/fons-store.mjs';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const MARKETPLACE = 'fons-local';
const PLUGIN_ID = 'fons@' + MARKETPLACE;
const PLUGIN_FILES = [
  '.codex-plugin/plugin.json',
  '.mcp.json',
  'adapters/antigravity.mjs',
  'adapters/codex.mjs',
  'adapters/index.mjs',
  'assets/logo.svg',
  'assets/sidebar-icon.svg',
  'codex/fons-mcp.mjs',
  'codex/fons-mcp-ui.mjs',
  'hooks/hooks.json',
  'scripts/fons-engine.mjs',
  'scripts/fons-hook.mjs',
  'scripts/fons-inbox.mjs',
  'scripts/fons-store.mjs',
  'sidecars/fons-pool/index.html',
  'sidecars/fons-pool/main.mjs',
];

function readOptionalJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('无法读取 ' + file + '。' + error.message, { cause: error });
  }
}

function commandIsFons(command) {
  return typeof command === 'string' && /\bfons-hook\.mjs\b/i.test(command);
}

function hasFonsHooks(config) {
  return Object.values(config?.hooks ?? {}).some((groups) => Array.isArray(groups)
    && groups.some((group) => Array.isArray(group?.hooks) && group.hooks.some((hook) => commandIsFons(hook?.command))));
}

function checkExistingHooks(codexHome, cwd, rootOverride) {
  const files = new Set([path.join(codexHome, 'hooks.json')]);
  if (rootOverride) files.add(path.resolve(cwd, rootOverride, '.codex', 'hooks.json'));
  for (let dir = path.resolve(cwd); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    files.add(path.join(dir, '.codex', 'hooks.json'));
  }
  for (const file of files) {
    if (hasFonsHooks(readOptionalJson(file))) {
      throw new Error('已发现直接配置的 Fons Hook（' + file + '）。请只保留一种注册来源。');
    }
  }
}

function packageFiles() {
  return PLUGIN_FILES.map((name) => ({ name, contents: fs.readFileSync(path.join(REPO_ROOT, name)) }));
}

function packageVersion(files) {
  const hash = createHash('sha256');
  for (const { name, contents } of files) {
    hash.update(name).update('\0').update(createHash('sha256').update(contents).digest());
  }
  return hash.digest('hex').slice(0, 16);
}

function publishPackage(destination, files) {
  if (fs.existsSync(destination)) return;
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(parent, '.fons-'));
  try {
    for (const { name, contents } of files) {
      const file = path.join(temporary, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, contents);
    }
    try {
      fs.renameSync(temporary, destination);
    } catch (error) {
      if (!fs.existsSync(destination)) throw error;
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
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
  const codexHome = path.resolve(cwd, codexAppData(env));
  checkExistingHooks(codexHome, cwd, env.FONS_ROOT?.trim());

  const marketplaceRoot = path.join(codexHome, 'fons', 'plugin-marketplace');
  const marketplaceFile = path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json');
  const files = packageFiles();
  const sourcePath = './plugins/fons-' + packageVersion(files);
  publishPackage(path.resolve(marketplaceRoot, sourcePath), files);
  publishMarketplace(marketplaceFile, sourcePath);
  return { marketplaceRoot, pluginId: PLUGIN_ID };
}
