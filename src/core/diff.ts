import { readFile } from 'node:fs/promises';

import { contentMatches, computeInstallPlan, exists } from './install.js';
import type { ManifestEntry } from './install.js';
import type { DiffEntry, DiffOptions, DiffResult, DriftEntry, Kind, Target } from './types.js';
import { resolveContainedPath, sha256 } from './util.js';

const TARGET_ORDER: Target[] = ['claude', 'codex', 'opencode'];
const KIND_ORDER: Kind[] = ['agent', 'skill', 'mcp', 'rule', 'config'];

function isUtf8Safe(s: string | null): boolean {
  if (s === null || s === '') return true;
  return Buffer.from(s, 'utf8').toString('utf8') === s;
}

function sortDiffEntries(entries: DiffEntry[]): DiffEntry[] {
  return [...entries].sort((a, b) => {
    const at = TARGET_ORDER.indexOf(a.target);
    const bt = TARGET_ORDER.indexOf(b.target);
    const aTargetIdx = at === -1 ? TARGET_ORDER.length : at;
    const bTargetIdx = bt === -1 ? TARGET_ORDER.length : bt;
    if (aTargetIdx !== bTargetIdx) return aTargetIdx - bTargetIdx;

    const ak = KIND_ORDER.indexOf(a.kind);
    const bk = KIND_ORDER.indexOf(b.kind);
    const aKindIdx = ak === -1 ? KIND_ORDER.length : ak;
    const bKindIdx = bk === -1 ? KIND_ORDER.length : bk;
    if (aKindIdx !== bKindIdx) return aKindIdx - bKindIdx;

    return a.relPath.localeCompare(b.relPath);
  });
}

async function collectDrift(
  manifestsByAbsPath: Map<string, ManifestEntry>,
  targetRootByTarget: Record<Target, string>,
  targets: Target[],
  kinds: Kind[]
): Promise<DriftEntry[]> {
  const drift: DriftEntry[] = [];
  // Track seen (target:relPath) combos to dedup shared merged files
  const seen = new Map<string, DriftEntry>();

  for (const { manifest } of manifestsByAbsPath.values()) {
    for (const record of manifest.records) {
      if (!targets.includes(record.target) || !kinds.includes(record.kind)) continue;

      const absPath = resolveContainedPath(
        targetRootByTarget[record.target],
        record.relPath,
        'drift check'
      );
      const seenKey = `${record.target}:${record.relPath}`;

      if (seen.has(seenKey)) {
        // Dedup: append record.id to existing entry's id field
        const existing = seen.get(seenKey)!;
        if (!existing.id.split('+').includes(record.id)) {
          existing.id = `${existing.id}+${record.id}`;
        }
        continue;
      }

      const fileExists = await exists(absPath);
      if (!fileExists) {
        const entry: DriftEntry = {
          target: record.target,
          kind: record.kind,
          pack: record.pack,
          id: record.id,
          relPath: record.relPath,
          absPath,
          manifestHash: record.hash,
          currentHash: '',
          current: null,
        };
        seen.set(seenKey, entry);
        drift.push(entry);
        continue;
      }

      const rawBuf = await readFile(absPath);
      const currentHash = sha256(rawBuf);
      const current = rawBuf.toString('utf8');

      if (currentHash !== record.hash) {
        const entry: DriftEntry = {
          target: record.target,
          kind: record.kind,
          pack: record.pack,
          id: record.id,
          relPath: record.relPath,
          absPath,
          manifestHash: record.hash,
          currentHash,
          current,
        };
        seen.set(seenKey, entry);
        drift.push(entry);
      }
    }
  }

  return drift;
}

export async function diff(options: DiffOptions): Promise<DiffResult> {
  const r = await computeInstallPlan({
    cwd: options.cwd,
    scope: options.scope,
    targets: options.targets,
    kinds: options.kinds,
    refreshPacks: options.refreshPacks,
    noMerge: options.noMerge,
    dryRun: true,
    clean: false,
    check: false,
    force: false,
  });

  const changes: DiffEntry[] = [];
  const seenAbsPath = new Set<string>();

  for (const write of r.plan) {
    if (seenAbsPath.has(write.absPath)) continue;
    seenAbsPath.add(write.absPath);

    const before = (await exists(write.absPath))
      ? await readFile(write.absPath, 'utf8').catch(() => null)
      : null;

    // If write.sourceFile is set and write.content is undefined, this is a binary asset copy
    const isBinaryAsset = write.sourceFile !== undefined && write.content === undefined;
    const after = isBinaryAsset ? null : (write.content ?? null);

    // NOTE: The action classification logic below mirrors the create/update logic in install.ts's
    // install() function. That function remains the authoritative implementation; this is a parallel
    // classification for diff purposes only.
    let action: 'create' | 'update' | 'delete';
    if (before === null) {
      action = 'create';
    } else if (!(await contentMatches(write.absPath, write.hash))) {
      action = 'update';
    } else {
      // File matches plan exactly — no diff entry needed
      continue;
    }

    const binary = isBinaryAsset || !isUtf8Safe(before) || !isUtf8Safe(after);

    changes.push({
      action,
      target: write.target,
      kind: write.kind,
      pack: write.pack,
      id: write.id,
      relPath: write.relPath,
      absPath: write.absPath,
      before,
      after,
      binary,
    });
  }

  const requestedTargets = r.targets;
  const requestedKinds = options.kinds;

  const driftEntries: DriftEntry[] =
    options.detectDrift === false
      ? []
      : await collectDrift(r.manifestsByAbsPath, r.targetRootByTarget, requestedTargets, requestedKinds);

  const sorted = sortDiffEntries(changes);

  return {
    changes: sorted,
    drift: driftEntries,
    create: sorted.filter((c) => c.action === 'create').map((c) => c.absPath),
    update: sorted.filter((c) => c.action === 'update').map((c) => c.absPath),
    del: sorted.filter((c) => c.action === 'delete').map((c) => c.absPath),
  };
}
