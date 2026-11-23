import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_DEBOUNCE_SEC, hasEnvDebounceOverride, hasEnvStopWaitOverride, hasLocalWorkspaceFonsPlugin,
  isWorkspaceEnabled, readFonsConfig, resolveConfiguredDebounceMs, resolveStopWaitDebounce,
  updateFonsConfig, workspaceConfigState,
} from '../scripts/fons-config.mjs';

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fons-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('config defaults, updates, validation and env override precedence work as expected', (t) => {
  const root = makeTempDir(t);
  const appData = path.join(root, 'host');
  assert.equal(DEFAULT_DEBOUNCE_SEC, 15);
  assert.deepEqual(readFonsConfig(appData), {
    debounceSec: DEFAULT_DEBOUNCE_SEC,
    stopWaitDebounce: false,
    autoAttachWorkspaces: true,
    enabledWorkspaces: [],
    disabledWorkspaces: [],
  });

  const saved = updateFonsConfig(appData, { debounceSec: 30, stopWaitDebounce: true });
  assert.equal(saved.debounceSec, 30);
  assert.equal(saved.stopWaitDebounce, true);
  assert.equal(resolveConfiguredDebounceMs({ appData, env: {} }), 30000);
  assert.equal(resolveStopWaitDebounce({ appData, env: {} }), true);
  assert.equal(hasEnvDebounceOverride({}), false);
  assert.equal(hasEnvStopWaitOverride({}), false);

  // Explicit env vars override config file values
  assert.equal(resolveConfiguredDebounceMs({ appData, env: { FONS_DEBOUNCE_SEC: '0' } }), 0);
  assert.equal(resolveStopWaitDebounce({ appData, env: { FONS_STOP_WAIT_DEBOUNCE: '0' } }), false);
  assert.equal(hasEnvDebounceOverride({ FONS_DEBOUNCE_SEC: '0' }), true);
  assert.equal(hasEnvStopWaitOverride({ FONS_STOP_WAIT_DEBOUNCE: '0' }), true);

  // Validation rejects out-of-range and malformed patches
  assert.throws(() => updateFonsConfig(appData, { debounceSec: -1 }), { code: 'FONS_INVALID_CONFIG' });
  assert.throws(() => updateFonsConfig(appData, { debounceSec: 3601 }), { code: 'FONS_INVALID_CONFIG' });
  assert.throws(() => updateFonsConfig(appData, { debounceSec: 1.5 }), { code: 'FONS_INVALID_CONFIG' });
  assert.throws(() => updateFonsConfig(appData, { stopWaitDebounce: 'yes' }), { code: 'FONS_INVALID_CONFIG' });
  assert.throws(() => updateFonsConfig(appData, { autoAttachWorkspaces: 1 }), { code: 'FONS_INVALID_CONFIG' });
  assert.throws(() => updateFonsConfig(appData, { workspaceAction: { path: 'relative', mode: 'enable' } }), { code: 'FONS_INVALID_CONFIG' });
  assert.throws(() => updateFonsConfig(appData, { workspaceAction: { path: root, mode: 'unknown' } }), { code: 'FONS_INVALID_CONFIG' });
});

test('workspace enable/disable/reset rules respect autoAttach, localPlugin, subdirectories, and sibling isolation', (t) => {
  const root = makeTempDir(t);
  const appData = path.join(root, 'host');
  const projA = path.join(root, 'proj-a');
  const projASub = path.join(projA, 'packages', 'sub');
  const projASibling = path.join(root, 'proj-a-other');
  for (const dir of [projASub, projASibling]) fs.mkdirSync(dir, { recursive: true });

  // Default: autoAttachWorkspaces=true enables all workspaces
  assert.equal(isWorkspaceEnabled({ appData, rootDir: projA }), true);

  // Disabling projA disables projA and its subdirs, without affecting sibling prefix
  updateFonsConfig(appData, { workspaceAction: { path: projA, mode: 'disable' } });
  assert.deepEqual(workspaceConfigState({ appData, rootDir: projA }), { enabled: false, explicitState: 'disabled' });
  assert.equal(isWorkspaceEnabled({ appData, rootDir: projASub }), false);
  assert.equal(isWorkspaceEnabled({ appData, rootDir: projASibling }), true);

  // Explicit enable on subdir overrides disabled parent
  updateFonsConfig(appData, { workspaceAction: { path: projASub, mode: 'enable' } });
  assert.equal(isWorkspaceEnabled({ appData, rootDir: projASub }), true);
  assert.equal(isWorkspaceEnabled({ appData, rootDir: projA }), false);

  // Reset restores default behavior
  updateFonsConfig(appData, { workspaceAction: { path: projA, mode: 'reset' } });
  updateFonsConfig(appData, { workspaceAction: { path: projASub, mode: 'reset' } });
  assert.equal(isWorkspaceEnabled({ appData, rootDir: projA }), true);

  // Turning off autoAttach disables unmounted workspaces, keeps localPlugin enabled unless explicitly disabled
  updateFonsConfig(appData, { autoAttachWorkspaces: false });
  assert.equal(isWorkspaceEnabled({ appData, rootDir: projA, localPlugin: false }), false);
  assert.equal(isWorkspaceEnabled({ appData, rootDir: projA, localPlugin: true }), true);

  // Explicitly enabling projA works in manual mode; explicitly disabling overrides localPlugin
  updateFonsConfig(appData, { workspaceAction: { path: projA, mode: 'enable' } });
  assert.equal(isWorkspaceEnabled({ appData, rootDir: projA, localPlugin: false }), true);
  updateFonsConfig(appData, { workspaceAction: { path: projA, mode: 'disable', localPlugin: true } });
  assert.equal(isWorkspaceEnabled({ appData, rootDir: projA, localPlugin: true }), false);
});

test('hasLocalWorkspaceFonsPlugin detects .agents/plugins/fons and .agents/plugins.json repo mounts', (t) => {
  const root = makeTempDir(t);
  const repoRoot = path.join(root, 'Fons');
  const plainProject = path.join(root, 'plain');
  const localMountProject = path.join(root, 'mounted');
  for (const dir of [repoRoot, plainProject, localMountProject]) fs.mkdirSync(dir, { recursive: true });

  assert.equal(hasLocalWorkspaceFonsPlugin(plainProject, repoRoot), false);

  const mountedHooks = path.join(localMountProject, '.agents', 'plugins', 'fons', 'hooks.json');
  fs.mkdirSync(path.dirname(mountedHooks), { recursive: true });
  fs.writeFileSync(mountedHooks, '{}', 'utf8');
  assert.equal(hasLocalWorkspaceFonsPlugin(localMountProject, repoRoot), true);

  // Repository self-mount via .agents/plugins.json (like F:\Fons itself)
  const manifest = path.join(repoRoot, '.agents', 'plugins.json');
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ entries: [{ path: '..', include_only: ['Fons', 'fons'] }] }), 'utf8');
  assert.equal(hasLocalWorkspaceFonsPlugin(repoRoot, repoRoot), true);

  // Disabled, excluded, or non-matching include_only entries must not false-positive
  const siblingProject = path.join(root, 'sibling');
  const siblingManifest = path.join(siblingProject, '.agents', 'plugins.json');
  fs.mkdirSync(path.dirname(siblingManifest), { recursive: true });
  fs.writeFileSync(siblingManifest, JSON.stringify({ entries: [{ path: '..', include_only: ['other'] }] }), 'utf8');
  assert.equal(hasLocalWorkspaceFonsPlugin(siblingProject, repoRoot), false);

  fs.writeFileSync(siblingManifest, JSON.stringify({ entries: [{ path: '..', exclude: ['Fons'] }] }), 'utf8');
  assert.equal(hasLocalWorkspaceFonsPlugin(siblingProject, repoRoot), false);

  fs.writeFileSync(siblingManifest, JSON.stringify({ entries: [{ path: '..', enabled: false }] }), 'utf8');
  assert.equal(hasLocalWorkspaceFonsPlugin(siblingProject, repoRoot), false);
});

test('corrupted config falls back cleanly, disabled wins over enabled, and invalid env does not clobber saved config', (t) => {
  const root = makeTempDir(t);
  const appData = path.join(root, 'host');
  const file = path.join(appData, 'fons', 'config.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{broken json', 'utf8');
  assert.equal(readFonsConfig(appData).debounceSec, DEFAULT_DEBOUNCE_SEC);

  const proj = path.join(root, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    debounceSec: 20,
    enabledWorkspaces: [proj],
    disabledWorkspaces: [proj],
  }), 'utf8');
  const normalized = readFonsConfig(appData);
  assert.equal(normalized.disabledWorkspaces.length, 1);
  assert.equal(normalized.enabledWorkspaces.length, 0);
  assert.equal(isWorkspaceEnabled({ appData, rootDir: proj }), false);

  // Invalid FONS_DEBOUNCE_SEC falls back to saved config (20s), matching hasEnvDebounceOverride=false
  assert.equal(hasEnvDebounceOverride({ FONS_DEBOUNCE_SEC: 'abc' }), false);
  assert.equal(resolveConfiguredDebounceMs({ appData, env: { FONS_DEBOUNCE_SEC: 'abc' } }), 20000);

  // No-workspace lookup returns immediately without reading config.json from disk.
  const brokenAppData = path.join(root, 'unreadable-config-host');
  fs.mkdirSync(path.join(brokenAppData, 'fons', 'config.json'), { recursive: true });
  assert.deepEqual(workspaceConfigState({ appData: brokenAppData, rootDir: null }), {
    enabled: true,
    explicitState: 'default',
  });
});
