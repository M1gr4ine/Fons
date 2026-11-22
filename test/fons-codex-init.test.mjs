import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareCodexPlugin } from '../codex/init.mjs';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI = fileURLToPath(new URL('../scripts/fons-cli.mjs', import.meta.url));

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fons-codex-package-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'user-home');
  const project = path.join(home, 'workspace');
  const codexHome = path.join(home, 'Codex home');
  fs.mkdirSync(project, { recursive: true });
  const options = {
    env: { CODEX_HOME: codexHome, HOME: home, USERPROFILE: home },
    cwd: project,
  };
  const marketplace = path.join(codexHome, 'fons', 'plugin-marketplace');
  const catalogFile = path.join(marketplace, '.agents', 'plugins', 'marketplace.json');
  return { root, home, project, codexHome, options, marketplace, catalogFile };
}

function runCli(ctx, args, overrides = {}) {
  const env = {
    ...process.env,
    FONS_ROOT: ctx.project,
    FONS_APP_DATA: path.join(ctx.root, 'host'),
    HOME: ctx.home,
    USERPROFILE: ctx.home,
    CODEX_HOME: undefined,
    FONS_HOST: '',
    FONS_SESSION: '',
    ...overrides,
  };
  return spawnSync(process.execPath, [CLI, ...args], { cwd: ctx.project, encoding: 'utf8', env });
}

function listedPackage(marketplace, catalogFile) {
  const catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
  return path.resolve(marketplace, catalog.plugins.find(({ name }) => name === 'fons').source.path);
}

test('codex init repoints the catalog after an update and keeps the previous package', async (t) => {
  const { root, options, marketplace, catalogFile } = setup(t);
  prepareCodexPlugin(options);
  const previous = listedPackage(marketplace, catalogFile);
  assert.equal(fs.existsSync(path.join(previous, 'scripts', 'fons-package.mjs')), false);

  const checkout = path.join(root, 'updated source');
  fs.cpSync(previous, checkout, { recursive: true });
  const updatedInit = path.join(checkout, 'codex', 'init.mjs');
  fs.mkdirSync(path.dirname(updatedInit), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'codex', 'init.mjs'), updatedInit);
  fs.copyFileSync(path.join(REPO_ROOT, 'scripts', 'fons-package.mjs'), path.join(checkout, 'scripts', 'fons-package.mjs'));

  const asset = path.join('assets', 'logo.svg');
  const previousAsset = fs.readFileSync(path.join(previous, asset), 'utf8');
  const updatedAsset = previousAsset + '\n<!-- updated fixture -->\n';
  fs.writeFileSync(path.join(checkout, asset), updatedAsset);

  const updated = await import(pathToFileURL(updatedInit).href);
  updated.prepareCodexPlugin(options);
  const current = listedPackage(marketplace, catalogFile);
  assert.notEqual(current, previous);
  assert.equal(fs.readFileSync(path.join(current, asset), 'utf8'), updatedAsset);
  assert.equal(fs.readFileSync(path.join(previous, asset), 'utf8'), previousAsset);
});

test('codex init packages a discoverable MCP app whose resource resolves in the published bundle', (t) => {
  const { options, marketplace, catalogFile } = setup(t);
  prepareCodexPlugin(options);
  const bundle = listedPackage(marketplace, catalogFile);
  const manifest = JSON.parse(fs.readFileSync(path.join(bundle, '.codex-plugin/plugin.json'), 'utf8'));
  assert.match(manifest.interface.defaultPrompt[0], /打开.*灵感池/);
  assert.equal(fs.statSync(path.resolve(bundle, manifest.interface.composerIcon)).isFile(), true);

  const config = JSON.parse(fs.readFileSync(path.resolve(bundle, manifest.mcpServers), 'utf8'));
  const server = config.mcpServers.fons;
  assert.equal(server.command, 'node');
  assert.deepEqual(server.env_vars, ['CODEX_HOME']);
  const messages = [
    { id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
    { id: 2, method: 'tools/list' },
    { id: 3, method: 'resources/read', params: { uri: 'ui://fons/pool.html' } },
  ];
  const processResult = spawnSync(process.execPath, server.args, {
    cwd: path.resolve(bundle, server.cwd), encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, CODEX_HOME: options.env.CODEX_HOME },
    input: messages.map((message) => JSON.stringify({ jsonrpc: '2.0', ...message })).join('\n') + '\n',
  });
  assert.equal(processResult.status, 0, processResult.error?.message || processResult.stderr);
  const [, tools, resource] = processResult.stdout.trim().split('\n').map(JSON.parse);
  const open = tools.result.tools.find((tool) => tool.name === 'open_fons_pool');
  assert.equal(open._meta.ui.resourceUri, 'ui://fons/pool.html');
  const [content] = resource.result.contents;
  assert.equal(content.mimeType, 'text/html;profile=mcp-app');
  assert.match(content.text, /ui\/notifications\/initialized/);
  assert.match(content.text, /data-testid="fons-quick-add"/);
});

test('codex init stages only the Codex plugin and preserves existing hooks and AGENTS', (t) => {
  const ctx = setup(t);
  const codexHome = path.join(ctx.home, 'Codex 测试 home');
  fs.mkdirSync(codexHome, { recursive: true });
  const hooksPath = path.join(codexHome, 'hooks.json');
  const agentsPath = path.join(codexHome, 'AGENTS.md');
  const oldHooks = '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"existing-hook"}]}]}}';
  fs.writeFileSync(hooksPath, oldHooks);
  fs.writeFileSync(agentsPath, 'Existing user rules\n');

  const initial = runCli(ctx, ['codex', 'init'], { CODEX_HOME: codexHome });
  assert.equal(initial.status, 0, initial.stderr);
  assert.match(initial.stdout, /codex plugin add fons@fons-local/);
  const marketplaceRoot = path.join(codexHome, 'fons', 'plugin-marketplace');
  const marketplacePath = path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json');
  const catalog = JSON.parse(fs.readFileSync(marketplacePath, 'utf8'));
  const pluginRoot = path.resolve(marketplaceRoot, catalog.plugins[0].source.path);
  assert.equal(fs.existsSync(path.join(pluginRoot, 'plugin.json')), false);

  const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
  const config = JSON.parse(fs.readFileSync(path.join(pluginRoot, manifest.hooks), 'utf8'));
  assert.deepEqual(Object.keys(config.hooks), ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop']);
  assert.equal(fs.readFileSync(hooksPath, 'utf8'), oldHooks);
  assert.equal(fs.readFileSync(agentsPath, 'utf8'), 'Existing user rules\n');
  assert.equal(runCli(ctx, ['codex', 'init'], { CODEX_HOME: codexHome }).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(marketplacePath, 'utf8')).plugins[0].source.path, catalog.plugins[0].source.path);
});

test('codex init detects direct Fons hooks in the active project and Codex home, stopping ancestor scans at homeDir', (t) => {
  const ctx = setup(t);
  const codexHome = path.join(ctx.home, 'custom Codex home');
  const projectConfig = path.join(ctx.project, '.codex');
  const directHooks = '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"node \\"C:/Fons/scripts/fons-hook.mjs\\" --host=codex"}]}]}}';
  for (const dir of [projectConfig, codexHome]) {
    fs.mkdirSync(dir, { recursive: true });
    const filename = path.join(dir, 'hooks.json');
    fs.writeFileSync(filename, directHooks);
    const result = runCli(ctx, ['codex', 'init'], { CODEX_HOME: codexHome });
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(filename), result.stderr);
    assert.equal(fs.readFileSync(filename, 'utf8'), directHooks);
    assert.equal(fs.existsSync(path.join(codexHome, 'fons', 'plugin-marketplace')), false);
    fs.unlinkSync(filename);
  }

  // Ancestor walk stops at homeDir so an isolated CODEX_HOME ignores a direct hook in homeDir/.codex/hooks.json,
  // while default CODEX_HOME (via HOME/USERPROFILE) still detects it.
  const homeHooks = path.join(ctx.home, '.codex', 'hooks.json');
  const nestedProject = path.join(ctx.project, 'nested', 'demo');
  fs.mkdirSync(path.dirname(homeHooks), { recursive: true });
  fs.mkdirSync(nestedProject, { recursive: true });
  fs.writeFileSync(homeHooks, directHooks);

  const isolated = prepareCodexPlugin({
    env: { CODEX_HOME: codexHome, HOME: ctx.home, USERPROFILE: ctx.home },
    cwd: nestedProject,
  });
  assert.equal(isolated.pluginId, 'fons@fons-local');

  assert.throws(
    () => prepareCodexPlugin({ env: { HOME: ctx.home, USERPROFILE: ctx.home }, cwd: nestedProject }),
    (error) => error.message.includes(homeHooks),
  );
});

test('installed Codex command uses its package root over cwd', (t) => {
  const ctx = setup(t);
  fs.mkdirSync(path.join(ctx.project, '.git'));
  const codexHome = path.join(ctx.home, 'Codex 中文空格 $cache %folder%');
  const env = { ...process.env, CODEX_HOME: codexHome, FONS_APP_DATA: undefined, HOME: ctx.home, USERPROFILE: ctx.home };
  const setupResult = runCli(ctx, ['codex', 'init'], { CODEX_HOME: codexHome, FONS_APP_DATA: undefined });
  assert.equal(setupResult.status, 0, setupResult.stderr);
  const marketplaceRoot = path.join(codexHome, 'fons', 'plugin-marketplace');
  const catalog = JSON.parse(fs.readFileSync(path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
  const pluginRoot = path.resolve(marketplaceRoot, catalog.plugins[0].source.path);
  const hooksConfig = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'hooks', 'hooks.json'), 'utf8'));
  const command = hooksConfig.hooks.SessionStart[0].hooks[0].command;
  const options = { env: { ...env, PLUGIN_ROOT: pluginRoot }, cwd: ctx.project, encoding: 'utf8' };
  const testId = '12345678-1234-7234-8234-123456789aaa';
  const input = JSON.stringify({
    hook_event_name: 'SessionStart',
    session_id: testId,
    cwd: ctx.project,
    transcript_path: path.join(ctx.project, 'rollout.jsonl'),
    source: 'startup',
  });
  const shells = process.platform === 'win32' ? [
    { executable: 'cmd.exe', args: ['/D', '/S', '/C', '"' + command + '"'], windowsVerbatimArguments: true },
    { executable: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', command] },
  ] : [{ executable: 'sh', args: ['-c', command] }];

  const registrationPath = path.join(codexHome, 'fons', 'conversations', testId + '.json');
  for (const { executable, args, windowsVerbatimArguments } of shells) {
    const result = spawnSync(executable, args, { ...options, input, windowsVerbatimArguments });
    assert.equal(result.status, 0, executable + ': ' + result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {});
    const record = JSON.parse(fs.readFileSync(registrationPath, 'utf8'));
    assert.equal(record.host, 'codex');
    assert.equal(record.rootDir, ctx.project);
    fs.unlinkSync(registrationPath);
  }
});
