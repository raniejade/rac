import { type ColorMode, styles } from './color.js';
import { pad, relPath as relPathFn, renderEmpty, symbol } from './render.js';

export type InstallAction = 'create' | 'update' | 'delete';

export interface InstallChangeView {
  action: InstallAction;
  /** 'claude' | 'codex' | 'opencode' — kept as string for renderer portability */
  target: string;
  /** 'agent' | 'skill' | 'mcp' | 'rule' | 'config' */
  kind: string;
  pack: string;
  id: string;
  relPath: string;
  absPath: string;
}

export interface InstallResultView {
  changes: InstallChangeView[];
  create: string[];
  update: string[];
  del: string[];
}

const TARGET_ORDER = ['claude', 'codex', 'opencode'];
const KIND_ORDER = ['agent', 'skill', 'mcp', 'rule', 'config'];

export interface ChangeListEntry {
  action: InstallAction;
  target: string;
  kind: string;
  pack: string;
  id: string;
  relPath: string;
  absPath: string;
}

/**
 * Render a grouped table of changes (target → kind). Returns lines without a trailing newline
 * after the last group. Caller is responsible for adding spacing and summary line.
 */
export function renderChangeList(changes: ChangeListEntry[], opts: { cwd: string; mode: ColorMode }): string {
  if (changes.length === 0) return '';

  const s = styles(opts.mode);

  // Group by target
  const byTarget = new Map<string, ChangeListEntry[]>();
  for (const change of changes) {
    const list = byTarget.get(change.target) ?? [];
    list.push(change);
    byTarget.set(change.target, list);
  }

  // Compute id-with-pack column width across all rows for alignment
  const idPackStrings = changes.map((c) => `${c.id} (${c.pack}:${c.id})`);
  const maxIdPack = Math.max(...idPackStrings.map((s) => s.length));
  const idPackWidth = maxIdPack + 2;

  const lines: string[] = [];

  // Emit target groups in canonical order, then alphabetically for unknowns
  const orderedTargets = [
    ...TARGET_ORDER.filter((t) => byTarget.has(t)),
    ...[...byTarget.keys()].filter((t) => !TARGET_ORDER.includes(t)).sort(),
  ];

  for (const target of orderedTargets) {
    const targetChanges = byTarget.get(target)!;

    // Sort by kind order
    targetChanges.sort((a, b) => {
      const ai = KIND_ORDER.indexOf(a.kind);
      const bi = KIND_ORDER.indexOf(b.kind);
      const aIdx = ai === -1 ? KIND_ORDER.length : ai;
      const bIdx = bi === -1 ? KIND_ORDER.length : bi;
      return aIdx - bIdx;
    });

    lines.push(s.bold(target));

    for (const change of targetChanges) {
      const sym = symbol(change.action, opts.mode);
      // pad kind to 7 chars on raw string before coloring
      const paddedKind = pad(change.kind, 7);
      // pad id-pack on raw string before coloring
      const idPack = `${change.id} (${change.pack}:${change.id})`;
      const paddedIdPack = pad(idPack, idPackWidth);
      const rel = relPathFn(change.absPath, opts.cwd);

      lines.push(`  ${paddedKind}  ${sym}  ${paddedIdPack}  ${s.gray(rel)}`);
    }
  }

  return lines.join('\n');
}

/**
 * Render an install result as a formatted string.
 * Groups changes by target then by kind, adds a summary line.
 */
export function renderInstall(
  result: InstallResultView,
  opts: { cwd: string; mode: ColorMode; check?: boolean; dryRun?: boolean },
): string {
  if (result.changes.length === 0) {
    return renderEmpty('Nothing to do.', opts.mode);
  }

  const lines: string[] = [];
  lines.push(renderChangeList(result.changes, opts));
  lines.push('');

  // Summary line
  const c = result.create.length;
  const u = result.update.length;
  const d = result.del.length;
  const distinctTargets = new Set(result.changes.map((ch) => ch.target));
  const t = distinctTargets.size;
  const f = result.changes.length;

  let summary: string;
  if (opts.check) {
    summary = `Plan: ${c} to create, ${u} to update, ${d} to delete across ${t} target(s) (${f} file(s)) (check)\n`;
  } else if (opts.dryRun) {
    summary = `Plan: ${c} to create, ${u} to update, ${d} to delete across ${t} target(s) (${f} file(s)) (dry-run)\n`;
  } else {
    summary = `Summary: ${c} created, ${u} updated, ${d} deleted across ${t} target(s) (${f} file(s))\n`;
  }

  return lines.join('\n') + '\n' + summary;
}
