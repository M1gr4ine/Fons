import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const realDir = fs.realpathSync(path.dirname(fileURLToPath(import.meta.url)));
const mainPath = path.resolve(realDir, '..', '..', '..', 'sidecars', 'fons-pool', 'main.mjs');
const { startSidecar } = await import(pathToFileURL(mainPath).href);
await startSidecar();
