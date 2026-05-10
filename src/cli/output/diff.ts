import { createTwoFilesPatch } from 'diff';

import { type ColorMode, styles } from './color.js';
import { type ChangeListEntry, renderChangeList } from './install.js';
import { relPath as relPathFn, renderEmpty } from './render.js';

export interface DiffEntryView {
  action: 'create' | 'update' | 'delete';
  target: string;
  kind: string;
  pack: string;
  id: string;
  relPath: string;
  absPath: string;
  before: string | null;
  after: string | null;
  binary: boolean;
}

export interface DriftEntryView {
  target: string;
  kind: string;
  pack: string;
  id: string;
  relPath: string;
  absPath: string;
  manifestHash: string;
  currentHash: string;
  current: string | null;
}

export interface DiffResultView {
  changes: DiffEntryView[];
  drift: DriftEntryView[];
  create: string[];
  update: string[];
  del: string[];
}

function colorDiffBody(rawPatch: string, s: ReturnType<typeof styles>): string {
  // Strip the first two lines jsdiff prepends (Index: ... and =======...)
  const allLines = rawPatch.split('\n');
  let startIdx = 0;
  for (let i = 0; i < allLines.length; i++) {
    if (allLines[i].startsWith('Index:') || allLines[i].startsWith('=====')) {
      startIdx = i + 1;
    } else {
      break;
    }
  }
  const patchLines = allLines.slice(startIdx);

  return patchLines
    .map((line) => {
      if (line.startsWith('@@')) return s.cyan(line);
      if (line.startsWith('---') || line.startsWith('+++')) return s.gray(line);
      if (line.startsWith('+')) return s.green(line);
      if (line.startsWith('-')) return s.red(line);
      return line;
    })
    .join('\n');
}

function indentBlock(text: string, indent: string): string {
  return text
    .split('\n')
    .map((line) => (line.length > 0 ? indent + line : line))
    .join('\n');
}

function renderDiffBody(entry: DiffEntryView, s: ReturnType<typeof styles>, summary: boolean): string {
  if (summary) return '';
  if (entry.binary) {
    return '    (binary, content omitted)\n';
  }

  if (entry.action === 'create') {
    const after = entry.after ?? '';
    const lines = after.split('\n');
    // Remove trailing empty line from split if content ends with \n
    const displayLines = after.endsWith('\n') ? lines.slice(0, -1) : lines;
    const header = s.gray(`+++ ${entry.relPath} (planned, ${displayLines.length} lines)`);
    const body = displayLines.map((line) => s.green(`+ ${line}`)).join('\n');
    return `    ${header}\n${body ? body.split('\n').map((l) => `    ${l}`).join('\n') + '\n' : ''}`;
  }

  if (entry.action === 'delete') {
    const before = entry.before ?? '';
    const lines = before.split('\n');
    const displayLines = before.endsWith('\n') ? lines.slice(0, -1) : lines;
    const header = s.gray(`--- ${entry.relPath} (installed)`);
    const body = displayLines.map((line) => s.red(`- ${line}`)).join('\n');
    return `    ${header}\n${body ? body.split('\n').map((l) => `    ${l}`).join('\n') + '\n' : ''}`;
  }

  // update
  const before = entry.before ?? '';
  const after = entry.after ?? '';
  const patch = createTwoFilesPatch(
    `${entry.relPath} (installed)`,
    `${entry.relPath} (planned)`,
    before,
    after,
    '',
    '',
    { context: 3 }
  );
  const colored = colorDiffBody(patch, s);
  return indentBlock(colored, '    ').trimEnd() + '\n';
}

export function renderDiff(
  result: DiffResultView,
  opts: { cwd: string; mode: ColorMode; summary?: boolean; dryRun?: boolean }
): string {
  const s = styles(opts.mode);

  if (result.changes.length === 0 && result.drift.length === 0) {
    return renderEmpty('Nothing to do.', opts.mode);
  }

  const lines: string[] = [];

  if (result.changes.length > 0) {
    if (opts.summary) {
      // Summary mode: just the grouped change list (no diff bodies)
      lines.push(renderChangeList(result.changes as ChangeListEntry[], opts));
    } else {
      // Full mode: grouped change list with diff bodies per entry
      // Group by target then kind, with diff body after each line
      const TARGET_ORDER = ['claude', 'codex', 'opencode'];
      const KIND_ORDER = ['agent', 'skill', 'mcp', 'rule', 'config'];

      const byTarget = new Map<string, DiffEntryView[]>();
      for (const change of result.changes) {
        const list = byTarget.get(change.target) ?? [];
        list.push(change);
        byTarget.set(change.target, list);
      }

      const idPackStrings = result.changes.map((c) => `${c.id} (${c.pack}:${c.id})`);
      const maxIdPack = Math.max(...idPackStrings.map((str) => str.length));
      const idPackWidth = maxIdPack + 2;

      const orderedTargets = [
        ...TARGET_ORDER.filter((t) => byTarget.has(t)),
        ...[...byTarget.keys()].filter((t) => !TARGET_ORDER.includes(t)).sort(),
      ];

      const actionSymbol = (action: string): string => {
        if (action === 'create') return s.green('+');
        if (action === 'update') return s.yellow('~');
        if (action === 'delete') return s.red('-');
        return action;
      };

      const pad = (str: string, width: number): string => {
        if (str.length >= width) return str;
        return str + ' '.repeat(width - str.length);
      };

      for (const target of orderedTargets) {
        const targetChanges = byTarget.get(target)!;

        targetChanges.sort((a, b) => {
          const ai = KIND_ORDER.indexOf(a.kind);
          const bi = KIND_ORDER.indexOf(b.kind);
          const aIdx = ai === -1 ? KIND_ORDER.length : ai;
          const bIdx = bi === -1 ? KIND_ORDER.length : bi;
          if (aIdx !== bIdx) return aIdx - bIdx;
          return a.relPath.localeCompare(b.relPath);
        });

        lines.push(s.bold(target));

        for (const change of targetChanges) {
          const sym = actionSymbol(change.action);
          const paddedKind = pad(change.kind, 7);
          const idPack = `${change.id} (${change.pack}:${change.id})`;
          const paddedIdPack = pad(idPack, idPackWidth);
          const rel = relPathFn(change.absPath, opts.cwd);
          lines.push(`  ${paddedKind}  ${sym}  ${paddedIdPack}  ${s.gray(rel)}`);

          const body = renderDiffBody(change, s, false);
          if (body) {
            lines.push(body.trimEnd());
          }
        }
      }
    }
  }

  lines.push('');

  // Drift section
  if (result.drift.length > 0) {
    lines.push(s.yellow('Drift detected:'));
    for (const entry of result.drift) {
      lines.push(`  ${s.bold(entry.target)}  ${entry.relPath}  ${s.red('hand-edited since last install')}`);
      if (!opts.summary) {
        lines.push(`  ${s.gray(`--- ${entry.relPath} (manifest hash: ${entry.manifestHash.slice(0, 8)})`)}`);
        lines.push(`  ${s.gray(`+++ ${entry.relPath} (current hash: ${entry.currentHash.slice(0, 8)})`)}`);
        if (entry.current === null) {
          lines.push(`  ${s.red('(file deleted)')}`);
        } else {
          const contentLines = entry.current.split('\n');
          const displayLines = entry.current.endsWith('\n') ? contentLines.slice(0, -1) : contentLines;
          for (const line of displayLines) {
            lines.push(`  ${s.green(`+ ${line}`)}`);
          }
        }
      }
    }
    lines.push('');
  }

  // Summary line
  const c = result.create.length;
  const u = result.update.length;
  const d = result.del.length;
  const distinctTargets = new Set(result.changes.map((ch) => ch.target));
  const t = distinctTargets.size;
  const f = result.changes.length;

  const label = opts.dryRun ? '(dry-run)' : '(diff)';
  let summary = `Plan: ${c} to create, ${u} to update, ${d} to delete across ${t} target(s) (${f} file(s)) ${label}\n`;
  if (result.drift.length > 0) {
    summary += `${result.drift.length} file(s) with drift\n`;
  }

  return lines.join('\n') + summary;
}
