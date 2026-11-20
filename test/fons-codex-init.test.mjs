import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareCodexPlugin } from '../codex/init.mjs';

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fons-codex-package-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { env: { CODEX_HOME: path.join(root, 'Codex home') }, cwd: root };
  const marketplace = path.join(options.env.CODEX_HOME, 'fons', 'plugin-marketplace');
  const catalogFile = path.join(marketplace, '.agents', 'plugins', 'marketplace.json');
  return { root, options, marketplace, catalogFile };
}

function listedPackage(marketplace, catalogFile) {
  const catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
  return path.resolve(marketplace, catalog.plugins.find(({ name }) => name === 'fons').source.path);
}

test('codex init repoints the catalog after an update and keeps the previous package', async (t) => {
  const { root, options, marketplace, catalogFile } = setup(t);
  prepareCodexPlugin(options);
  const previous = listedPackage(marketplace, catalogFile);

  const checkout = path.join(root, 'updated source');
  fs.cpSync(previous, checkout, { recursive: true });
  const updatedInit = path.join(checkout, 'codex', 'init.mjs');
  fs.mkdirSync(path.dirname(updatedInit), { recursive: true });
  fs.copyFileSync(fileURLToPath(new URL('../codex/init.mjs', import.meta.url)), updatedInit);

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
