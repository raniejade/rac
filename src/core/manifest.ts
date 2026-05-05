import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { InstallManifest } from './types.js';

export async function loadManifest(file: string): Promise<InstallManifest> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as InstallManifest;
    if (parsed.version !== 1 || !Array.isArray(parsed.records)) {
      throw new Error('invalid manifest schema');
    }
    return parsed;
  } catch {
    return { version: 1, records: [] };
  }
}

export async function saveManifest(file: string, manifest: InstallManifest): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

export async function deleteManifest(file: string): Promise<void> {
  await rm(file, { force: true });
}
