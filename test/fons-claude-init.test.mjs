import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareClaudePlugin } from '../claude/init.mjs';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI = fileURLToPath(new URL('../scripts/fons-cli.mjs', import.meta.url));

function setup(t, dirName = 'Claude home') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fons-claude-init-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'user-home');
  const claudeHome = path.join(home, dirName);
  const project = path.join(home, 'workspace');
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: claudeHome,
    HOME: home,
    USERPROFILE: home,
    FONS_ROOT: undefined,
    FONS_APP_DATA: undefined,
    FONS_HOST: '',
    FONS_SESSION: '',
    CLAUDE_PROJECT_DIR: undefined,
  };
  const marketplace = path.join(claudeHome, 'fons', 'plugin-marketplace');
  const catalogFile = path.join(marketplace, '.claude-plugin', 'marketplace.json');
  return { root, claudeHome, project, home, env, marketplace, catalogFile };
}

function listedPlugin(marketplace, catalogFile) {
  const catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
  const entry = catalog.plugins.find(({ name }) => name === 'fons');
  return { catalog, entry, bundle: path.resolve(marketplace, entry.source) };
}

test('claude init builds a valid marketplace with owner, is idempotent, and repoints on update', async (t) => {
  const ctx = setup(t);
  const first = prepareClaudePlugin({ env: ctx.env, cwd: ctx.project });
  assert.equal(first.pluginId, 'fons@fons-local');
  assert.equal(first.marketplaceRoot, ctx.marketplace);

  const initial = listedPlugin(ctx.marketplace, ctx.catalogFile);
  assert.equal(initial.catalog.name, 'fons-local');
  assert.equal(typeof initial.catalog.owner?.name, 'string');
  assert.ok(initial.catalog.owner.name.length > 0);
  assert.match(initial.entry.source, /^\.\/plugins\/fons-[a-f0-9]{16}$/);

  const manifest = JSON.parse(fs.readFileSync(path.join(initial.bundle, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'fons');
  assert.equal(typeof manifest.version, 'string');
  assert.equal(typeof manifest.author?.name, 'string');
  assert.equal(manifest.userConfig?.openAtStart?.default, 'on');
  assert.equal(manifest.hooks, undefined);
  assert.equal(fs.existsSync(path.join(initial.bundle, 'CLAUDE.md')), false);
  assert.equal(fs.existsSync(path.join(initial.bundle, 'hooks', 'fons-pane.mjs')), true);
  assert.equal(fs.existsSync(path.join(initial.bundle, 'claude', 'pane-bridge.mjs')), true);

  const hooksConfig = JSON.parse(fs.readFileSync(path.join(initial.bundle, 'hooks', 'hooks.json'), 'utf8'));
  assert.deepEqual(hooksConfig.modules, ['./fons-pane.mjs']);
  assert.deepEqual(Object.keys(hooksConfig.hooks), ['SessionStart', 'UserPromptSubmit', 'PostToolBatch', 'Stop', 'SessionEnd']);
  for (const groups of Object.values(hooksConfig.hooks)) {
    const hook = groups[0].hooks[0];
    assert.equal(hook.type, 'command');
    assert.equal(hook.command, 'node');
    assert.deepEqual(hook.args, ['${CLAUDE_PLUGIN_ROOT}/scripts/fons-hook.mjs', '--host=claude']);
    assert.equal(hook.timeout, 5);
  }

  // Idempotent second run produces the exact same package path.
  prepareClaudePlugin({ env: ctx.env, cwd: ctx.project });
  assert.equal(listedPlugin(ctx.marketplace, ctx.catalogFile).entry.source, initial.entry.source);

  // Repairing a missing owner writes to disk even when the package hash is unchanged.
  const withoutOwner = JSON.parse(fs.readFileSync(ctx.catalogFile, 'utf8'));
  delete withoutOwner.owner;
  fs.writeFileSync(ctx.catalogFile, JSON.stringify(withoutOwner, null, 2));
  prepareClaudePlugin({ env: ctx.env, cwd: ctx.project });
  assert.equal(JSON.parse(fs.readFileSync(ctx.catalogFile, 'utf8')).owner.name, 'Fons');

  // Occupied marketplace with a foreign name is rejected.
  fs.writeFileSync(ctx.catalogFile, JSON.stringify({ name: 'other-market', plugins: [] }));
  assert.throws(() => prepareClaudePlugin({ env: ctx.env, cwd: ctx.project }), /已被其他配置占用/);
  fs.rmSync(ctx.catalogFile);
  prepareClaudePlugin({ env: ctx.env, cwd: ctx.project });

  // Updated checkout publishes a new hashed directory while retaining the previous bundle.
  const checkout = path.join(ctx.root, 'updated-repo');
  for (const rel of [
    'adapters/antigravity.mjs', 'adapters/claude.mjs', 'adapters/codex.mjs', 'adapters/index.mjs', 'adapters/shared.mjs',
    'claude/hooks.json', 'claude/init.mjs', 'claude/pane.mjs', 'claude/pane-bridge.mjs',
    'scripts/fons-config.mjs', 'scripts/fons-engine.mjs', 'scripts/fons-hook.mjs', 'scripts/fons-inbox.mjs',
    'scripts/fons-package.mjs', 'scripts/fons-panel.mjs', 'scripts/fons-panel-ui.mjs',
    'scripts/fons-sessions.mjs', 'scripts/fons-store.mjs',
    'sidecars/fons-pool/index.html', 'sidecars/fons-pool/main.mjs',
  ]) {
    const dest = path.join(checkout, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, rel), dest);
  }
  const hookFile = path.join(checkout, 'claude', 'hooks.json');
  const updatedHooks = JSON.parse(fs.readFileSync(hookFile, 'utf8'));
  updatedHooks.description = 'Updated description fixture';
  fs.writeFileSync(hookFile, JSON.stringify(updatedHooks, null, 2));

  const updatedMod = await import(pathToFileURL(path.join(checkout, 'claude', 'init.mjs')).href);
  updatedMod.prepareClaudePlugin({ env: ctx.env, cwd: ctx.project });
  const afterUpdate = listedPlugin(ctx.marketplace, ctx.catalogFile);
  assert.notEqual(afterUpdate.bundle, initial.bundle);
  assert.equal(fs.existsSync(initial.bundle), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(afterUpdate.bundle, 'hooks', 'hooks.json'), 'utf8')).description, 'Updated description fixture');
});

test('claude init blocks direct fons-hook.mjs conflicts across settings files without altering user files', (t) => {
  const ctx = setup(t);
  const userSettings = path.join(ctx.claudeHome, 'settings.json');
  const userClaudeMd = path.join(ctx.claudeHome, 'CLAUDE.md');
  const projectSettings = path.join(ctx.project, '.claude', 'settings.json');
  const projectLocalSettings = path.join(ctx.project, '.claude', 'settings.local.json');
  const cleanSettings = JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo ok' }] }] },
  });

  fs.mkdirSync(ctx.claudeHome, { recursive: true });
  fs.writeFileSync(userSettings, cleanSettings);
  fs.writeFileSync(userClaudeMd, '# Keep intact\n');

  const cases = [
    { file: userSettings, content: JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node /opt/fons/scripts/fons-hook.mjs --host=claude' }] }] } }) },
    { file: projectSettings, content: JSON.stringify({ hooks: { PostToolBatch: [{ hooks: [{ type: 'command', command: 'node', args: ['/opt/fons/scripts/fons-hook.mjs', '--host=claude'] }] }] } }) },
    { file: projectLocalSettings, content: JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node', args: ['${CLAUDE_PROJECT_DIR}/scripts/fons-hook.mjs', '--host=claude'] }] }] } }) },
  ];

  for (const { file, content } of cases) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    assert.throws(() => prepareClaudePlugin({ env: ctx.env, cwd: ctx.project }), (error) => {
      assert.ok(error.message.includes(file), error.message);
      return true;
    });
    assert.equal(fs.readFileSync(file, 'utf8'), content);
    assert.equal(fs.existsSync(ctx.marketplace), false);
    if (file === userSettings) fs.writeFileSync(userSettings, cleanSettings);
    else fs.unlinkSync(file);
  }

  // After removing conflicts, nested child cwd still catches parent .claude/settings.json,
  // and CLAUDE_PROJECT_DIR conflict override is also intercepted.
  const nested = path.join(ctx.project, 'sub', 'dir');
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(path.dirname(projectSettings), { recursive: true });
  fs.writeFileSync(projectSettings, cases[1].content);
  assert.throws(() => prepareClaudePlugin({ env: ctx.env, cwd: nested }), (error) => error.message.includes(projectSettings));
  fs.unlinkSync(projectSettings);

  const overrideDir = path.join(ctx.root, 'other-project');
  const overrideSettings = path.join(overrideDir, '.claude', 'settings.local.json');
  fs.mkdirSync(path.dirname(overrideSettings), { recursive: true });
  fs.writeFileSync(overrideSettings, cases[2].content);
  assert.throws(
    () => prepareClaudePlugin({ env: { ...ctx.env, CLAUDE_PROJECT_DIR: overrideDir }, cwd: ctx.project }),
    (error) => error.message.includes(overrideSettings),
  );
  fs.unlinkSync(overrideSettings);

  // CLI rejects session/panel options on claude init and panel options on non-panel commands.
  assert.notEqual(spawnSync(process.execPath, [CLI, '--host', 'claude', 'claude', 'init'], {
    cwd: ctx.project, encoding: 'utf8', env: ctx.env,
  }).status, 0);
  assert.notEqual(spawnSync(process.execPath, [CLI, '--port', '8080', 'sessions'], {
    cwd: ctx.project, encoding: 'utf8', env: ctx.env,
  }).status, 0);

  // After removing conflicts, init succeeds and keeps existing settings.json and CLAUDE.md untouched.
  const cliResult = spawnSync(process.execPath, [CLI, 'claude', 'init'], {
    cwd: ctx.project, encoding: 'utf8', env: ctx.env,
  });
  assert.equal(cliResult.status, 0, cliResult.stderr);
  assert.match(cliResult.stdout, /claude plugin marketplace add "/);
  assert.match(cliResult.stdout, /claude plugin install fons@fons-local/);
  assert.match(cliResult.stdout, /用户设置/);
  assert.equal(fs.readFileSync(userSettings, 'utf8'), cleanSettings);
  assert.equal(fs.readFileSync(userClaudeMd, 'utf8'), '# Keep intact\n');
});

test('installed Claude exec-form hook registers end-to-end under Chinese, space, $ and % path', (t) => {
  const ctx = setup(t, 'Claude 中文空格 $cache %folder%');
  const cliResult = spawnSync(process.execPath, [CLI, 'claude', 'init'], {
    cwd: ctx.project, encoding: 'utf8', env: ctx.env,
  });
  assert.equal(cliResult.status, 0, cliResult.stderr);

  const { bundle } = listedPlugin(ctx.marketplace, ctx.catalogFile);
  const hooksConfig = JSON.parse(fs.readFileSync(path.join(bundle, 'hooks', 'hooks.json'), 'utf8'));
  const startHook = hooksConfig.hooks.SessionStart[0].hooks[0];
  assert.equal(startHook.command, 'node');

  // Emulate Claude Code exec-form substitution of ${CLAUDE_PLUGIN_ROOT} without a shell.
  const resolvedArgs = startHook.args.map((arg) => arg.replaceAll('${CLAUDE_PLUGIN_ROOT}', bundle));
  const sessionId = '44444444-4444-4444-8444-444444444404';
  const transcriptPath = path.join(ctx.claudeHome, 'projects', 'special-proj', sessionId + '.jsonl');
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.writeFileSync(transcriptPath, '');

  const payload = JSON.stringify({
    hook_event_name: 'SessionStart',
    session_id: sessionId,
    cwd: ctx.project,
    transcript_path: transcriptPath,
    source: 'startup',
  });
  const proc = spawnSync(process.execPath, resolvedArgs, {
    cwd: ctx.project,
    encoding: 'utf8',
    input: payload,
    env: { ...ctx.env, CLAUDE_PLUGIN_ROOT: bundle, CLAUDE_PROJECT_DIR: ctx.project },
  });
  assert.equal(proc.status, 0, proc.stderr);
  const output = JSON.parse(proc.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(output.hookSpecificOutput.additionalContext, /\[FONS_ACK: 编号\]/);

  const regFile = path.join(ctx.claudeHome, 'fons', 'conversations', sessionId + '.json');
  const record = JSON.parse(fs.readFileSync(regFile, 'utf8'));
  assert.equal(record.host, 'claude');
  assert.equal(record.rootDir, ctx.project);
});
