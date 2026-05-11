import { type ColorMode, styles } from './color.js';
import { badge, renderSuccess } from './render.js';

export type WarningSeverity = 'error' | 'warn' | 'info';

export interface ConfigWarningView {
  severity: WarningSeverity;
  code: string;
  message: string;
  hint?: string;
  context?: { target?: string; kind?: string; id?: string; pack?: string };
}

/**
 * Render a list of warnings as inline lines without group headers or summary.
 * Used to embed warnings into other command output (e.g., install).
 * Returns an empty string when the list is empty.
 */
export function renderWarnings(warnings: ConfigWarningView[], mode: ColorMode): string {
  if (warnings.length === 0) return '';
  const s = styles(mode);
  const lines: string[] = [];
  for (const w of warnings) {
    lines.push(`  ${badge(w.severity, mode)}  ${s.gray(w.code)}  ${w.message}`);
    if (w.hint) {
      lines.push(`      hint: ${w.hint}`);
    }
  }
  return lines.join('\n') + '\n';
}

/**
 * Render doctor warnings as a formatted string.
 * Groups by severity (error → warn → info), then shows a summary.
 */
export function renderDoctor(warnings: ConfigWarningView[], mode: ColorMode): string {
  if (warnings.length === 0) {
    return renderSuccess('No issues found.', mode);
  }

  const s = styles(mode);

  const errors = warnings.filter((w) => w.severity === 'error');
  const warns = warnings.filter((w) => w.severity === 'warn');
  const infos = warnings.filter((w) => w.severity === 'info');

  const lines: string[] = [];

  function renderGroup(group: ConfigWarningView[], headerWord: string): void {
    if (group.length === 0) return;
    lines.push(s.bold(`${group.length} ${headerWord}:`));
    for (const w of group) {
      lines.push(`  ${badge(w.severity, mode)}  ${s.gray(w.code)}  ${w.message}`);
      if (w.hint) {
        lines.push(`      hint: ${w.hint}`);
      }
    }
  }

  renderGroup(errors, 'error(s)');
  renderGroup(warns, 'warning(s)');
  renderGroup(infos, 'info');

  lines.push('');

  const nE = errors.length;
  const nW = warns.length;
  const nI = infos.length;
  lines.push(`${nE} error(s), ${nW} warning(s), ${nI} info`);

  return lines.join('\n') + '\n';
}
