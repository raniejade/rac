import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import type { InstallManifest } from './types.js';
import { resolveContainedPath } from './util.js';

const manifestRecordSchema = z.object({
  version: z.literal(1),
  pack: z.string(),
  target: z.enum(['claude', 'codex', 'opencode']),
  kind: z.enum(['agent', 'skill', 'mcp', 'rule', 'config']),
  id: z.string(),
  source: z.string(),
  relPath: z.string(),
  hash: z.string(),
  inventory: z.array(z.object({
    version: z.literal(1),
    format: z.enum(['file', 'json', 'toml', 'markdown']),
    selector: z.string(),
    entries: z.array(z.string()).optional()
  }))
});

const manifestSchema = z.object({
  version: z.literal(1),
  records: z.array(manifestRecordSchema)
});

async function exists(file: string): Promise<boolean> {
  try {
    await access(file, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function loadManifest(projectRoot: string, manifestRelPath: string): Promise<InstallManifest> {
  const file = resolveContainedPath(projectRoot, manifestRelPath, 'manifest path');
  if (!(await exists(file))) return { version: 1, records: [] };
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
    const manifest = manifestSchema.parse(parsed);
    for (const record of manifest.records) {
      resolveContainedPath(projectRoot, record.relPath, 'manifest record path');
    }
    return manifest;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid RAC install manifest: ${file}: ${reason}`);
  }
}

export async function saveManifest(projectRoot: string, manifestRelPath: string, manifest: InstallManifest): Promise<void> {
  const file = resolveContainedPath(projectRoot, manifestRelPath, 'manifest path');
  for (const record of manifest.records) {
    resolveContainedPath(projectRoot, record.relPath, 'manifest record path');
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

export async function deleteManifest(projectRoot: string, manifestRelPath: string): Promise<void> {
  const file = resolveContainedPath(projectRoot, manifestRelPath, 'manifest path');
  await rm(file, { force: true });
}
