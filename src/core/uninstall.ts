import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { pickMergeStrategy } from '../adapters/merge-strategies.js';
import { vendorManifestRelPath } from '../adapters/target-adapters.js';

import { ALL_KINDS, ALL_TARGETS, resolveScopeRoots, targetRootFor } from './install.js';
import { deleteManifest, loadManifest, saveManifest } from './manifest.js';
import type { Kind, ManifestRecord, Scope, Target, UninstallChange, UninstallOptions, UninstallResult } from './types.js';
import { resolveContainedPath } from './util.js';

// Known shared files that must always take the surgical-prune path when they
// contain a '$' selector (defensive guard from the spec).
const KNOWN_SHARED_FILES = new Set([
  '.mcp.json',
  '.claude.json',
  '.claude/settings.json',
  '.codex/config.toml',
  '.opencode/opencode.jsonc',
  'opencode/opencode.jsonc'
]);

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function sortChanges(changes: UninstallChange[]): UninstallChange[] {
  return [...changes].sort((a, b) => {
    if (a.action !== b.action) return a.action.localeCompare(b.action);
    const absA = 'absPath' in a ? a.absPath : '';
    const absB = 'absPath' in b ? b.absPath : '';
    if (absA !== absB) return absA.localeCompare(absB);
    const selA = a.action === 'prune-selector' ? a.selector : '';
    const selB = b.action === 'prune-selector' ? b.selector : '';
    return selA.localeCompare(selB);
  });
}

export async function uninstall(options: UninstallOptions): Promise<UninstallResult> {
  const scope: Scope = options.scope ?? 'project';
  const targets: Target[] = options.targets ?? ALL_TARGETS;
  const kinds: Kind[] = options.kinds ?? ALL_KINDS;

  const { targetRootHome } = resolveScopeRoots({ cwd: options.cwd, scope, kinds: [] });

  const targetRootByTarget: Record<Target, string> = {
    claude: targetRootFor('claude', scope, targetRootHome),
    codex: targetRootFor('codex', scope, targetRootHome),
    opencode: targetRootFor('opencode', scope, targetRootHome)
  };

  // Step 2: Load ALL manifests on disk (regardless of options.targets/kinds),
  // deduplicating by absolute path so we don't load the same file twice.
  type ManifestEntry = {
    root: string;
    manifestRelPath: string;
    absPath: string;
    manifest: Awaited<ReturnType<typeof loadManifest>>;
  };
  const manifestsByAbsPath = new Map<string, ManifestEntry>();

  for (const target of ALL_TARGETS) {
    for (const kind of ALL_KINDS) {
      const manifestRelPath = vendorManifestRelPath(target, kind, scope);
      const root = targetRootByTarget[target];
      const absPath = resolveContainedPath(root, manifestRelPath, 'manifest path');
      if (manifestsByAbsPath.has(absPath)) continue;
      const manifest = await loadManifest(root, manifestRelPath);
      manifestsByAbsPath.set(absPath, { root, manifestRelPath, absPath, manifest });
    }
  }

  // Step 4: Collect selected records and group by relPath.
  // "Selected" means the record's target and kind are in the options filters.
  const selectedByRelPath = new Map<string, ManifestRecord[]>();
  for (const { manifest } of manifestsByAbsPath.values()) {
    for (const record of manifest.records) {
      if (!targets.includes(record.target) || !kinds.includes(record.kind)) continue;
      const existing = selectedByRelPath.get(record.relPath) ?? [];
      existing.push(record);
      selectedByRelPath.set(record.relPath, existing);
    }
  }

  // Step 5: For each relPath group, decide the action.
  const changes: UninstallChange[] = [];
  const fileDeletes = new Set<string>(); // absolute paths to delete
  // Queue of surgical merge rewrites: absPath -> new content
  const fileRewrites = new Map<string, string>();

  for (const [relPath, records] of selectedByRelPath.entries()) {
    // We only process records that belong to targets in our filter.
    // All records in this group already pass the targets+kinds filter.
    const target = records[0].target;
    const root = targetRootByTarget[target];
    const absPath = resolveContainedPath(root, relPath, 'uninstall relPath');

    // Defensive guard FIRST: if relPath is a known shared file AND any record
    // has selector '$', force the surgical-merge path.
    const hasWholeSelectorInSharedFile =
      KNOWN_SHARED_FILES.has(relPath) &&
      records.some((r) => r.inventory.some((inv) => inv.selector === '$'));

    if (hasWholeSelectorInSharedFile) {
      // Force surgical prune path, emit one prune-selector change per inventory selector.
      const strategy = pickMergeStrategy(target, relPath);
      if (strategy) {
        let existing: string | undefined;
        if (await exists(absPath)) existing = await readFile(absPath, 'utf8');
        const result = strategy.merge({
          existing,
          generated: '',
          ownedRecords: records,
          nextRecords: [],
          selectedKinds: new Set(kinds),
          phase: 'clean'
        });
        fileRewrites.set(absPath, result.content);
        for (const record of records) {
          for (const inv of record.inventory) {
            changes.push({
              action: 'prune-selector',
              target: record.target,
              kind: record.kind,
              pack: record.pack,
              id: record.id,
              relPath,
              absPath,
              selector: inv.selector
            });
          }
        }
      } else {
        // No strategy: this is a programming error — refusing to silently delete a shared file
        throw new Error(`uninstall: known shared file ${relPath} has no merge strategy; refusing to delete`);
      }
      continue;
    }

    // Whole-file delete: every record has exactly 1 inventory entry with selector '$'
    // AND the relPath is NOT a known shared file.
    const isWholeFileDeletion =
      !KNOWN_SHARED_FILES.has(relPath) &&
      records.every((r) => r.inventory.length === 1 && r.inventory[0].selector === '$');

    if (isWholeFileDeletion) {
      for (const record of records) {
        changes.push({ action: 'delete-file', target: record.target, kind: record.kind, pack: record.pack, id: record.id, relPath, absPath });
      }
      fileDeletes.add(absPath);
      continue;
    }

    // Surgical prune: use pickMergeStrategy.
    const strategy = pickMergeStrategy(target, relPath);
    if (strategy) {
      let existing: string | undefined;
      if (await exists(absPath)) existing = await readFile(absPath, 'utf8');
      const result = strategy.merge({
        existing,
        generated: '',
        ownedRecords: records,
        nextRecords: [],
        selectedKinds: new Set(kinds),
        phase: 'clean'
      });
      fileRewrites.set(absPath, result.content);
      for (const record of records) {
        for (const inv of record.inventory) {
          changes.push({
            action: 'prune-selector',
            target: record.target,
            kind: record.kind,
            pack: record.pack,
            id: record.id,
            relPath,
            absPath,
            selector: inv.selector
          });
        }
      }
    } else {
      // No strategy and non-$ selector: treat as whole-file delete (extremely unlikely).
      for (const record of records) {
        changes.push({ action: 'delete-file', target: record.target, kind: record.kind, pack: record.pack, id: record.id, relPath, absPath });
      }
      fileDeletes.add(absPath);
    }
  }

  // Step 6: For each manifest, compute keep records. If keep is empty and manifest
  // had records, emit delete-manifest.
  const manifestKeep = new Map<string, { root: string; manifestRelPath: string; keep: ManifestRecord[] }>();
  for (const [absPath, { root, manifestRelPath, manifest }] of manifestsByAbsPath.entries()) {
    const keep = manifest.records.filter((r) => !targets.includes(r.target) || !kinds.includes(r.kind));
    manifestKeep.set(absPath, { root, manifestRelPath, keep });
    if (keep.length === 0 && manifest.records.length > 0) {
      // Determine a representative target for this manifest
      const representativeRecord = manifest.records[0];
      changes.push({
        action: 'delete-manifest',
        target: representativeRecord.target,
        manifestRelPath,
        absPath
      });
    }
  }

  // Sort changes deterministically.
  const sortedChanges = sortChanges(changes);

  // Step 7: Apply (unless dry-run).
  if (!options.dryRun) {
    // Files before manifests so a crash mid-way leaves manifests pointing at already-modified state.
    for (const absPath of fileDeletes) {
      await rm(absPath, { force: true });
    }
    for (const [absPath, content] of fileRewrites.entries()) {
      await mkdir(path.dirname(absPath), { recursive: true });
      await writeFile(absPath, content, 'utf8');
    }
    for (const [, { root, manifestRelPath, keep }] of manifestKeep.entries()) {
      if (keep.length > 0) {
        await saveManifest(root, manifestRelPath, { version: 1, records: keep });
      } else {
        await deleteManifest(root, manifestRelPath);
      }
    }
  }

  // Build result arrays.
  const deletedFiles = [...new Set(
    sortedChanges
      .filter((c): c is Extract<UninstallChange, { action: 'delete-file' }> => c.action === 'delete-file')
      .map((c) => c.absPath)
  )];
  const prunedSelectors = sortedChanges
    .filter((c): c is Extract<UninstallChange, { action: 'prune-selector' }> => c.action === 'prune-selector')
    .map((c) => ({ absPath: c.absPath, selector: c.selector }));
  const deletedManifests = sortedChanges
    .filter((c): c is Extract<UninstallChange, { action: 'delete-manifest' }> => c.action === 'delete-manifest')
    .map((c) => c.absPath);

  return {
    changes: sortedChanges,
    deletedFiles,
    prunedSelectors,
    deletedManifests
  };
}
