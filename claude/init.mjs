import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeAppData } from '../adapters/claude.mjs';
import { absolutePath, ancestorDirs, asIdentifier, effectiveHome } from '../adapters/shared.mjs';
import {
  assertNoDirectFonsHooks, packageFiles, packageVersion, publishPackage, readOptionalJson,
} from '../scripts/fons-package.mjs';
import { writeJsonAtomic } from '../scripts/fons-store.mjs';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const MARKETPLACE = 'fons-local';
const PLUGIN_ID = 'fons@' + MARKETPLACE;
const PLUGIN_MANIFEST = {
  name: 'fons',
  displayName: 'Fons · 灵感池',
  version: '0.3.4',
  description: '在 Claude Code 会话中记录、蓄水并投递补充灵感，提供原生侧栏面板与回执自动勾选。',
  author: { name: 'Fons' },
  userConfig: {
    openAtStart: {
      type: 'string',
      title: '启动时自动打开侧栏',
      description: 'on: 桌面端会话启动时自动打开 Fons 灵感池侧栏。off: 保持关闭，需要时运行 /fons 打开。',
      default: 'on',
      options: ['on', 'off'],
    },
  },
};
const PLUGIN_FILES = [
  { target: '.claude-plugin/plugin.json', contents: JSON.stringify(PLUGIN_MANIFEST, null, 2) + '\n' },
  { source: 'claude/hooks.json', target: 'hooks/hooks.json' },
  { source: 'claude/pane.mjs', target: 'hooks/fons-pane.mjs' },
  'claude/pane-bridge.mjs',
  'adapters/antigravity.mjs',
  'adapters/claude.mjs',
  'adapters/codex.mjs',
  'adapters/index.mjs',
  'adapters/shared.mjs',
  'scripts/fons-config.mjs',
  'scripts/fons-engine.mjs',
  'scripts/fons-hook.mjs',
  'scripts/fons-inbox.mjs',
  'scripts/fons-panel.mjs',
  'scripts/fons-panel-ui.mjs',
  'scripts/fons-sessions.mjs',
  'scripts/fons-store.mjs',
  'sidecars/fons-pool/index.html',
  'sidecars/fons-pool/main.mjs',
];

function addProjectSettings(files, dir) {
  files.add(path.join(dir, '.claude', 'settings.json'));
  files.add(path.join(dir, '.claude', 'settings.local.json'));
}

function checkExistingHooks({ claudeHome, cwd, env, homeDir }) {
  const files = new Set([path.join(claudeHome, 'settings.json')]);
  for (const override of [env.FONS_ROOT?.trim(), env.CLAUDE_PROJECT_DIR?.trim()]) {
    if (override) addProjectSettings(files, path.resolve(cwd, override));
  }
  for (const dir of ancestorDirs(absolutePath(cwd) ?? path.resolve(cwd), homeDir)) {
    addProjectSettings(files, dir);
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
    description: 'Fons 本地插件市场',
    owner: { name: 'Fons' },
    plugins: [],
  };
  const ownerValid = Boolean(asIdentifier(catalog.owner?.name));
  if (!ownerValid) catalog.owner = { name: 'Fons' };
  const oldPlugin = catalog.plugins.find((plugin) => plugin?.name === 'fons');
  if (ownerValid && oldPlugin?.source === sourcePath) return;

  const plugin = {
    ...oldPlugin,
    name: 'fons',
    source: sourcePath,
    description: PLUGIN_MANIFEST.description,
  };
  catalog.plugins = catalog.plugins.filter((entry) => entry?.name !== 'fons');
  catalog.plugins.push(plugin);
  writeJsonAtomic(file, catalog);
}

export function prepareClaudePlugin({ env = process.env, cwd = process.cwd(), homeDir } = {}) {
  const resolvedHome = homeDir || effectiveHome(env);
  const claudeHome = claudeAppData(env, resolvedHome, cwd);
  checkExistingHooks({ claudeHome, cwd, env, homeDir: resolvedHome });

  const marketplaceRoot = path.join(claudeHome, 'fons', 'plugin-marketplace');
  const marketplaceFile = path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json');
  const files = packageFiles(REPO_ROOT, PLUGIN_FILES);
  const sourcePath = './plugins/fons-' + packageVersion(files);
  publishPackage(path.resolve(marketplaceRoot, sourcePath), files);
  publishMarketplace(marketplaceFile, sourcePath);
  return { marketplaceRoot, pluginId: PLUGIN_ID };
}
