import type { UninstallResult } from '../../core/types.js';

import { type ColorMode, styles } from './color.js';
import { pad, relPath as relPathFn, renderEmpty } from './render.js';

const TARGET_ORDER = ['claude', 'codex', 'opencode'];
const KIND_ORDER = ['agent', 'skill', 'mcp', 'rule', 'config'];

type UninstallRowKind = 'delete-file' | 'delete-manifest' | 'prune-selector';

interface UninstallRow {
  rowKind: UninstallRowKind;
  target: string;
  kind: string;
  pack?: string;
  id?: string;
  relPath: string;
  absPath: string;
  selector?: string;
}

/**
 * Render an uninstall result as a formatted string.
 * Groups changes by target then by kind.
 * - delete-file: `-` (red)
 * - delete-manifest: `-` (red)
 * - prune-selector: `~` (yellow), one row per selector
 */
export function renderUninstall(
  result: UninstallResult,
  opts: { cwd: string; mode: ColorMode; dryRun?: boolean },
): string {
  if (result.changes.length === 0) {
    return renderEmpty('Nothing to uninstall.', opts.mode);
  }

  const s = styles(opts.mode);

  // Build flat rows from changes
  const rows: UninstallRow[] = [];
  for (const change of result.changes) {
    if (change.action === 'delete-file') {
      rows.push({
        rowKind: 'delete-file',
        target: change.target,
        kind: change.kind,
        pack: change.pack,
        id: change.id,
        relPath: change.relPath,
        absPath: change.absPath,
      });
    } else if (change.action === 'prune-selector') {
      rows.push({
        rowKind: 'prune-selector',
        target: change.target,
        kind: change.kind,
        pack: change.pack,
        id: change.id,
        relPath: change.relPath,
        absPath: change.absPath,
        selector: change.selector,
      });
    } else if (change.action === 'delete-manifest') {
      rows.push({
        rowKind: 'delete-manifest',
        target: change.target,
        kind: '',
        relPath: change.manifestRelPath,
        absPath: change.absPath,
      });
    }
  }

  // Group by target
  const byTarget = new Map<string, UninstallRow[]>();
  for (const row of rows) {
    const list = byTarget.get(row.target) ?? [];
    list.push(row);
    byTarget.set(row.target, list);
  }

  // Compute id column width for alignment (only for rows that have id/pack)
  const idPackStrings = rows
    .filter((r) => r.id !== undefined && r.pack !== undefined)
    .map((r) => `${r.id} (${r.pack}:${r.id})`);
  const maxIdPack = idPackStrings.length > 0 ? Math.max(...idPackStrings.map((s) => s.length)) : 0;
  const idPackWidth = maxIdPack + 2;

  const lines: string[] = [];

  // Emit target groups in canonical order, then alphabetically for unknowns
  const orderedTargets = [
    ...TARGET_ORDER.filter((t) => byTarget.has(t)),
    ...[...byTarget.keys()].filter((t) => !TARGET_ORDER.includes(t)).sort(),
  ];

  for (const target of orderedTargets) {
    const targetRows = byTarget.get(target)!;

    // Sort by kind order, then by rowKind, then by relPath, then by selector
    targetRows.sort((a, b) => {
      const ai = KIND_ORDER.indexOf(a.kind);
      const bi = KIND_ORDER.indexOf(b.kind);
      const aIdx = ai === -1 ? KIND_ORDER.length : ai;
      const bIdx = bi === -1 ? KIND_ORDER.length : bi;
      if (aIdx !== bIdx) return aIdx - bIdx;
      if (a.relPath !== b.relPath) return a.relPath.localeCompare(b.relPath);
      if ((a.selector ?? '') !== (b.selector ?? '')) return (a.selector ?? '').localeCompare(b.selector ?? '');
      return 0;
    });

    lines.push(s.bold(target));

    for (const row of targetRows) {
      if (row.rowKind === 'delete-manifest') {
        const sym = s.red('-');
        const rel = relPathFn(row.absPath, opts.cwd);
        lines.push(`  ${'manifest'.padEnd(8)}  ${sym}  ${s.gray(rel)}`);
        continue;
      }

      const sym = row.rowKind === 'prune-selector' ? s.yellow('~') : s.red('-');
      const paddedKind = pad(row.kind, 7);
      const idPack = row.id !== undefined && row.pack !== undefined ? `${row.id} (${row.pack}:${row.id})` : '';
      const paddedIdPack = pad(idPack, idPackWidth);
      const rel = relPathFn(row.absPath, opts.cwd);

      if (row.rowKind === 'prune-selector') {
        lines.push(`  ${paddedKind}  ${sym}  ${paddedIdPack}  ${s.gray(rel)}  ${row.selector}`);
      } else {
        lines.push(`  ${paddedKind}  ${sym}  ${paddedIdPack}  ${s.gray(rel)}`);
      }
    }
  }

  lines.push('');

  // Summary
  const deleteFileCount = result.deletedFiles.length;
  const pruneSelectorCount = result.prunedSelectors.length;
  const deleteManifestCount = result.deletedManifests.length;
  const distinctTargets = new Set(
    result.changes
      .filter((c) => c.action !== 'delete-manifest')
      .map((c) => ('target' in c ? c.target : undefined))
      .filter(Boolean),
  );
  const t = distinctTargets.size;

  let summary: string;
  if (opts.dryRun) {
    summary = `Plan: ${deleteFileCount} file(s) to delete, ${pruneSelectorCount} selector(s) to prune, ${deleteManifestCount} manifest(s) to delete across ${t} target(s) (dry-run)\n`;
  } else {
    summary = `Summary: ${deleteFileCount} file(s) deleted, ${pruneSelectorCount} selector(s) pruned, ${deleteManifestCount} manifest(s) deleted across ${t} target(s)\n`;
  }

  return lines.join('\n') + '\n' + summary;
}
