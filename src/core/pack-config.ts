import { readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parse } from 'smol-toml';

import { loadPackOverrides, loadProjectPackConfig, validatePackSpec } from './parsers.js';
import type { PackOverride, PackSpec } from './types.js';

function configPathFor(cwd: string): string {
  return path.join(cwd, '.rac', 'config.toml');
}

async function assertConfigExists(cwd: string): Promise<string> {
  const configPath = configPathFor(cwd);
  try {
    await stat(configPath);
  } catch {
    throw new Error(`missing required config: ${configPath}`);
  }
  return configPath;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function parsePackIdFromBlock(block: string): string | undefined {
  const parsed = parse(block) as { packs?: Array<Record<string, unknown>> };
  const id = parsed.packs?.[0]?.id;
  if (typeof id !== 'string') return undefined;
  return id;
}

function findTopLevelPackBlocks(raw: string): Array<{ start: number; end: number; id?: string }> {
  const blocks: Array<{ start: number; end: number; id?: string }> = [];
  const tableHeader = /^[ \t]*\[[^\]\r\n]+(?:\.[^\]\r\n]+)*\][ \t]*(?:#.*)?\r?$/gm;
  const tableArrayHeader = /^[ \t]*\[\[[^\]\r\n]+\]\][ \t]*(?:#.*)?\r?$/gm;
  const packHeader = /^[ \t]*\[\[[ \t]*packs[ \t]*\]\][ \t]*(?:#.*)?\r?$/gm;

  const headerStarts: number[] = [];
  for (const matcher of [tableHeader, tableArrayHeader]) {
    let match = matcher.exec(raw);
    while (match) {
      headerStarts.push(match.index);
      match = matcher.exec(raw);
    }
  }
  headerStarts.sort((a, b) => a - b);

  let match = packHeader.exec(raw);
  while (match) {
    const start = match.index;
    const nextHeader = headerStarts.find((index) => index > start);
    const end = nextHeader ?? raw.length;
    const block = raw.slice(start, end);
    let id: string | undefined;
    try {
      id = parsePackIdFromBlock(block);
    } catch {
      id = undefined;
    }
    blocks.push({ start, end, id });
    match = packHeader.exec(raw);
  }

  return blocks;
}

function removeBlockWithLocalSeparator(raw: string, start: number, end: number): string {
  const before = raw.slice(0, start);
  const after = raw.slice(end);
  const beforeLineStart = before.lastIndexOf('\n') + 1;
  const beforeLine = before.slice(beforeLineStart);
  const afterNewlineLen = after.startsWith('\r\n') ? 2 : (after.startsWith('\n') ? 1 : 0);
  const afterLineEnd = after.indexOf('\n');
  const afterLine = afterLineEnd === -1 ? after : after.slice(0, afterLineEnd).replace(/\r$/, '');

  let removeStart = start;
  let removeEnd = end;

  if (beforeLine.trim().length === 0 && before.length > 0) removeStart = beforeLineStart;
  if (afterNewlineLen > 0 && afterLine.trim().length === 0) removeEnd = end + afterNewlineLen;

  return raw.slice(0, removeStart) + raw.slice(removeEnd);
}

export async function listProjectPacks(cwd: string): Promise<PackSpec[]> {
  await assertConfigExists(cwd);
  const config = await loadProjectPackConfig(path.join(cwd, '.rac'));
  return config.packs;
}

export async function addProjectPack(cwd: string, spec: PackSpec): Promise<void> {
  const configPath = await assertConfigExists(cwd);
  validatePackSpec(spec);

  const existing = await loadProjectPackConfig(path.join(cwd, '.rac'));
  if (existing.packs.some((pack) => pack.id === spec.id)) throw new Error(`duplicate pack id: ${spec.id}`);

  let raw = await readFile(configPath, 'utf8');
  if (raw.length > 0 && !raw.endsWith('\n')) raw += '\n';
  const spacer = raw.length === 0 || raw.endsWith('\n\n') ? '' : '\n';
  raw += `${spacer}[[packs]]\nid = ${tomlString(spec.id)}\nrepo = ${tomlString(spec.repo)}\nref = ${tomlString(spec.ref)}\n`;
  await writeFile(configPath, raw, 'utf8');
}

export async function removeProjectPack(cwd: string, packId: string): Promise<void> {
  const configPath = await assertConfigExists(cwd);
  const existing = await loadProjectPackConfig(path.join(cwd, '.rac'));
  if (!existing.packs.some((pack) => pack.id === packId)) throw new Error(`pack not found: ${packId}`);

  const raw = await readFile(configPath, 'utf8');
  const blocks = findTopLevelPackBlocks(raw);
  const target = blocks.find((block) => block.id === packId);
  if (!target) throw new Error(`pack block not found: ${packId}`);

  const next = removeBlockWithLocalSeparator(raw, target.start, target.end);
  await writeFile(configPath, next, 'utf8');
}

const LOCAL_CONFIG_FILE = 'config.local.toml';

function localConfigPathFor(cwd: string): string {
  return path.join(cwd, '.rac', LOCAL_CONFIG_FILE);
}

function renderPackOverrides(overrides: PackOverride[]): string {
  if (overrides.length === 0) return '';
  return overrides
    .map((o) => `[[pack_overrides]]\nid = ${tomlString(o.id)}\npath = ${tomlString(o.path)}\n`)
    .join('\n') + '\n';
}

export async function listProjectPackOverrides(cwd: string): Promise<PackOverride[]> {
  await assertConfigExists(cwd);
  return loadPackOverrides(path.join(cwd, '.rac'));
}

export async function setProjectPackOverride(cwd: string, id: string, pathInput: string): Promise<void> {
  await assertConfigExists(cwd);

  const projectRoot = path.join(cwd, '.rac');
  const config = await loadProjectPackConfig(projectRoot);
  if (!config.packs.some((p) => p.id === id)) {
    throw new Error(`pack not found: ${id} (no matching [[packs]] entry)`);
  }

  // Validate id shape
  const PACK_ID_RE = /^[A-Za-z0-9._-]+$/;
  if (!PACK_ID_RE.test(id)) throw new Error(`invalid pack id; use ASCII path-safe letters/numbers/./_/-: ${id}`);
  if (id === 'project') throw new Error('invalid pack id; project is reserved for the local project pack');

  // Validate pathInput
  if (!pathInput) throw new Error(`invalid pack override path: must be a non-empty string`);
  if (pathInput.includes('\0')) throw new Error(`invalid pack override path: must not contain NUL bytes`);

  // Resolve and stat the path
  const resolved = path.isAbsolute(pathInput) ? pathInput : path.resolve(cwd, pathInput);
  let dirStat: Awaited<ReturnType<typeof stat>>;
  try {
    dirStat = await stat(resolved);
  } catch {
    throw new Error(`pack override path does not exist: ${id} → ${resolved}`);
  }
  if (!dirStat.isDirectory()) throw new Error(`pack override path is not a directory: ${id} → ${resolved}`);

  const innerConfig = path.join(resolved, '.rac', 'config.toml');
  try {
    await stat(innerConfig);
  } catch {
    throw new Error(`pack override path missing .rac/config.toml: ${id} → ${resolved} (expected ${innerConfig})`);
  }

  // Read existing overrides
  const existing = await loadPackOverrides(projectRoot);

  // Build new overrides list: replace existing entry with same id or append
  let replaced = false;
  const next: PackOverride[] = existing.map((o) => {
    if (o.id === id) {
      replaced = true;
      return { id, path: pathInput };
    }
    return o;
  });
  if (!replaced) next.push({ id, path: pathInput });

  await writeFile(localConfigPathFor(cwd), renderPackOverrides(next), 'utf8');
}

export async function clearProjectPackOverride(cwd: string, id: string): Promise<void> {
  await assertConfigExists(cwd);

  const localPath = localConfigPathFor(cwd);
  let existing: PackOverride[];
  try {
    existing = await loadPackOverrides(path.join(cwd, '.rac'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`override not found: ${id}`);
    throw err;
  }

  if (existing.length === 0) throw new Error(`override not found: ${id}`);
  if (!existing.some((o) => o.id === id)) throw new Error(`override not found: ${id}`);

  const next = existing.filter((o) => o.id !== id);
  if (next.length === 0) {
    await unlink(localPath);
  } else {
    await writeFile(localPath, renderPackOverrides(next), 'utf8');
  }
}
