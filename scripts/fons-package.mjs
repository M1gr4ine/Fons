import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function readOptionalJson(file) {
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

function hookIsFons(hook) {
  return commandIsFons(hook?.command) || (Array.isArray(hook?.args) && hook.args.some(commandIsFons));
}

function hasFonsHooks(config) {
  return Object.values(config?.hooks ?? {}).some((groups) => Array.isArray(groups)
    && groups.some((group) => Array.isArray(group?.hooks) && group.hooks.some(hookIsFons)));
}

export function assertNoDirectFonsHooks(files) {
  for (const file of files) {
    if (hasFonsHooks(readOptionalJson(file))) {
      throw new Error('已发现直接配置的 Fons Hook（' + file + '）。请只保留一种注册方式。');
    }
  }
}

export function packageFiles(repoRoot, entries) {
  return entries.map((entry) => {
    if (typeof entry === 'string') {
      return { name: entry, contents: fs.readFileSync(path.join(repoRoot, entry)) };
    }
    const contents = entry.contents !== undefined
      ? Buffer.from(entry.contents)
      : fs.readFileSync(path.join(repoRoot, entry.source));
    return { name: entry.target, contents };
  });
}

export function packageVersion(files) {
  const hash = createHash('sha256');
  for (const { name, contents } of files) {
    hash.update(name).update('\0').update(createHash('sha256').update(contents).digest());
  }
  return hash.digest('hex').slice(0, 16);
}

export function publishPackage(destination, files) {
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
