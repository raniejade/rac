#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';

import { Command, InvalidArgumentError } from 'commander';

import pkg from '../package.json' with { type: 'json' };

import { detectColorMode, renderDiff, renderDoctor, renderEmpty, renderInstall, renderList, renderSuccess, renderUninstall, startSpinner } from './cli/output/index.js';
import { diff } from './core/diff.js';
import { doctor, initProject, install } from './core/install.js';
import { addProjectPack, listProjectPacks, removeProjectPack } from './core/pack-config.js';
import type { Kind, Scope, Target } from './core/types.js';
import { uninstall } from './core/uninstall.js';
import { splitCsv } from './core/util.js';

const TARGET_VALUES = ['claude', 'codex', 'opencode'] as const;
const KIND_VALUES = ['agent', 'skill', 'mcp', 'rule', 'config'] as const;
const SCOPE_VALUES = ['project', 'user'] as const;

function normalizeTargets(value: string | undefined): Target[] | undefined {
  if (value === undefined) return undefined;
  const targets = splitCsv<Target>(value, TARGET_VALUES);
  for (const target of targets) {
    if (!TARGET_VALUES.includes(target)) throw new InvalidArgumentError(`invalid target: ${target}`);
  }
  return targets;
}

function normalizeKinds(value: string | undefined): Kind[] {
  const kinds = splitCsv<Kind>(value, KIND_VALUES);
  for (const kind of kinds) {
    if (!KIND_VALUES.includes(kind)) throw new InvalidArgumentError(`invalid kind: ${kind}`);
  }
  return kinds;
}

function normalizeScope(value: string | undefined): Scope {
  if (value === undefined) return 'project';
  if (!SCOPE_VALUES.includes(value as Scope)) throw new InvalidArgumentError(`invalid scope: ${value} (expected project|user)`);
  return value as Scope;
}

export function createProgram(): Command {
  const program = new Command();
  program
    .name('rac')
    .description('Install RAC project definitions into Claude/Codex/OpenCode config surfaces')
    .showHelpAfterError()
    .configureOutput({ outputError: (str, write) => write(str) })
    .exitOverride()
    .option('-p, --plain', 'disable color/styling output')
    .version(pkg.version, '-v, --version', 'output the current version');

  program.command('init')
    .description('Initialize .rac source tree with starter reviewer + project-gates + project-rules + wrapper-deny rule definitions')
    .option('--empty', 'create folders only without starter examples')
    .option('--scope <scope>', 'project|user (default project)')
    .action(async (opts: { empty?: boolean; scope?: string }) => {
      const mode = detectColorMode({ plainFlag: !!(program.opts() as { plain?: boolean }).plain });
      await initProject(process.cwd(), !!opts.empty, normalizeScope(opts.scope));
      process.stdout.write(renderSuccess(`Initialized .rac (${normalizeScope(opts.scope)} scope)`, mode));
    });

  program.command('install')
    .description('Install selected kinds/targets from .rac definitions')
    .option('--targets <targets>', 'comma-separated: claude,codex,opencode')
    .option('--kind <kinds>', 'comma-separated: agent,skill,mcp,rule,config')
    .option('--dry-run', 'print planned changes only (shows unified diffs; use --summary for path/count only)')
    .option('--summary', 'with --dry-run: suppress per-file diffs, show path/count summary only')
    .option('--clean', 'delete stale files tracked by manifest for selected kind/target')
    .option('--check', 'verify generated outputs/manifests are up to date without writing')
    .option('--force', 'override unmanaged files')
    .option('--refresh-packs', 'force re-clone of shared pack caches before installing')
    .option('--scope <scope>', 'project|user (default project)')
    .option('--no-merge', 'bypass surgical merge of shared config files; write generated content wholesale')
    .action(async (opts: { targets?: string; kind?: string; dryRun?: boolean; summary?: boolean; clean?: boolean; check?: boolean; force?: boolean; refreshPacks?: boolean; scope?: string; noMerge?: boolean }) => {
      const cwd = process.cwd();
      const mode = detectColorMode({ plainFlag: !!(program.opts() as { plain?: boolean }).plain });
      const spinner = startSpinner('Installing…', mode);
      try {
        if (opts.dryRun) {
          // Reroute dry-run through the diff renderer for content-level diffs
          const diffResult = await diff({
            cwd,
            targets: normalizeTargets(opts.targets),
            kinds: normalizeKinds(opts.kind),
            refreshPacks: !!opts.refreshPacks,
            scope: normalizeScope(opts.scope),
            noMerge: opts.noMerge ? true : undefined,
            detectDrift: true,
          });
          spinner.stop();
          process.stdout.write(renderDiff(diffResult, {
            cwd,
            mode,
            summary: !!opts.summary,
            dryRun: true,
          }));
        } else {
          const result = await install({
            targets: normalizeTargets(opts.targets),
            kinds: normalizeKinds(opts.kind),
            dryRun: false,
            clean: !!opts.clean,
            check: !!opts.check,
            force: !!opts.force,
            refreshPacks: !!opts.refreshPacks,
            scope: normalizeScope(opts.scope),
            noMerge: opts.noMerge ? true : undefined,
            cwd,
          });
          spinner.stop();
          process.stdout.write(renderInstall(result, {
            cwd,
            mode,
            check: !!opts.check,
            dryRun: false,
          }));
        }
      } catch (err) {
        spinner.stop();
        throw err;
      }
    });

  program.command('diff')
    .description('Show content-level diffs of what would change and detect drift in managed files')
    .option('--targets <targets>', 'comma-separated: claude,codex,opencode')
    .option('--kind <kinds>', 'comma-separated: agent,skill,mcp,rule,config')
    .option('--scope <scope>', 'project|user (default project)')
    .option('--refresh-packs', 'force re-clone of shared pack caches before diffing')
    .option('--no-merge', 'bypass surgical merge of shared config files')
    .option('--summary', 'suppress per-file unified diffs; show path/count summary only')
    .option('--no-drift', 'skip drift detection section')
    .action(async (opts: { targets?: string; kind?: string; scope?: string; refreshPacks?: boolean; noMerge?: boolean; summary?: boolean; drift?: boolean }) => {
      const cwd = process.cwd();
      const mode = detectColorMode({ plainFlag: !!(program.opts() as { plain?: boolean }).plain });
      const spinner = startSpinner('Computing diff…', mode);
      try {
        const result = await diff({
          cwd,
          targets: normalizeTargets(opts.targets),
          kinds: normalizeKinds(opts.kind),
          scope: normalizeScope(opts.scope),
          refreshPacks: !!opts.refreshPacks,
          noMerge: opts.noMerge ? true : undefined,
          detectDrift: opts.drift !== false,
        });
        spinner.stop();
        process.stdout.write(renderDiff(result, { cwd, mode, summary: !!opts.summary }));
      } catch (err) {
        spinner.stop();
        throw err;
      }
    });

  program.command('uninstall')
    .description('Remove all RAC-managed files and selectors for selected scope/targets/kinds')
    .option('--targets <targets>', 'comma-separated: claude,codex,opencode')
    .option('--kind <kinds>', 'comma-separated: agent,skill,mcp,rule,config')
    .option('--dry-run', 'print planned changes only')
    .option('--scope <scope>', 'project|user (default project)')
    .option('--yes', 'skip confirmation prompt')
    .action(async (opts: { targets?: string; kind?: string; dryRun?: boolean; scope?: string; yes?: boolean }) => {
      const cwd = process.cwd();
      const mode = detectColorMode({ plainFlag: !!(program.opts() as { plain?: boolean }).plain });
      const targets = normalizeTargets(opts.targets);
      const kinds = opts.kind !== undefined ? normalizeKinds(opts.kind) : undefined;
      const scope = normalizeScope(opts.scope);

      // Compute the plan (dry-run first to show what would change)
      const plan = await uninstall({ cwd, targets, kinds, scope, dryRun: true });
      process.stdout.write(renderUninstall(plan, { cwd, mode, dryRun: !!opts.dryRun }));

      if (opts.dryRun) return;
      if (plan.changes.length === 0) return;

      if (!opts.yes) {
        let ans: string;
        if (process.stdin.isTTY) {
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          try {
            ans = (await rl.question('Proceed with uninstall? [y/N] ')).trim().toLowerCase();
          } finally {
            rl.close();
          }
        } else {
          // Non-TTY: attempt to read one line from stdin (supports piped 'y\n').
          // Returns null if stdin is empty/closed immediately.
          const line = await new Promise<string | null>((resolve) => {
            let buf = '';
            const onData = (chunk: Buffer | string) => {
              buf += chunk.toString();
              const nl = buf.indexOf('\n');
              if (nl !== -1) {
                process.stdin.off('data', onData);
                process.stdin.off('close', onClose);
                resolve(buf.slice(0, nl));
              }
            };
            const onClose = () => {
              process.stdin.off('data', onData);
              resolve(buf.trim().length > 0 ? buf.trim() : null);
            };
            process.stdin.on('data', onData);
            process.stdin.on('close', onClose);
            process.stdin.resume();
          });
          if (line === null) {
            process.stderr.write('cannot confirm in non-interactive mode; pass --yes\n');
            process.exitCode = 1;
            return;
          }
          ans = line.trim().toLowerCase();
        }
        if (ans !== 'y' && ans !== 'yes') {
          process.stdout.write('Aborted.\n');
          return;
        }
      }

      // Apply the uninstall
      const result = await uninstall({ cwd, targets, kinds, scope, dryRun: false });
      process.stdout.write(`Uninstalled ${result.changes.length} change(s).\n`);
    });

  program.command('doctor')
    .description('Validate definitions and print warnings')
    .option('--targets <targets>', 'comma-separated: claude,codex,opencode')
    .option('--kind <kinds>', 'comma-separated: agent,skill,mcp,rule,config')
    .option('--scope <scope>', 'project|user (default project)')
    .action(async (opts: { targets?: string; kind?: string; scope?: string }) => {
      const mode = detectColorMode({ plainFlag: !!(program.opts() as { plain?: boolean }).plain });
      const warnings = await doctor(process.cwd(), normalizeTargets(opts.targets), normalizeKinds(opts.kind), normalizeScope(opts.scope));
      process.stdout.write(renderDoctor(warnings, mode));
      if (warnings.some((w) => w.severity === 'error')) process.exit(1);
    });

  const packProgram = program.command('pack')
    .description('Manage top-level [[packs]] entries in .rac/config.toml');

  packProgram.command('add')
    .description('Add a shared pack reference to .rac/config.toml')
    .argument('<id>')
    .argument('<repo>')
    .requiredOption('--ref <ref>')
    .action(async (id: string, repo: string, opts: { ref: string }) => {
      const mode = detectColorMode({ plainFlag: !!(program.opts() as { plain?: boolean }).plain });
      await addProjectPack(process.cwd(), { id, repo, ref: opts.ref });
      process.stdout.write(renderSuccess(`Added pack ${id}`, mode));
    });

  packProgram.command('list')
    .description('List configured shared packs')
    .action(async () => {
      const mode = detectColorMode({ plainFlag: !!(program.opts() as { plain?: boolean }).plain });
      const packs = await listProjectPacks(process.cwd());
      if (packs.length === 0) {
        process.stdout.write(renderEmpty('No packs configured.', mode));
      } else {
        process.stdout.write(renderList(packs.map((p) => ({ left: p.id, right: `${p.repo} @ ${p.ref}` })), mode));
      }
    });

  packProgram.command('remove')
    .description('Remove a shared pack reference by id')
    .argument('<id>')
    .action(async (id: string) => {
      const mode = detectColorMode({ plainFlag: !!(program.opts() as { plain?: boolean }).plain });
      await removeProjectPack(process.cwd(), id);
      process.stdout.write(renderSuccess(`Removed pack ${id}`, mode));
    });

  return program;
}

async function main() {
  const program = createProgram();
  try {
    await program.parseAsync(process.argv);
  } catch (err: unknown) {
    const e = err as Record<string, unknown>;
    if (e?.code === 'commander.helpDisplayed' || e?.code === 'commander.version') process.exit(0);
    if (typeof e?.code === 'string' && e.code.startsWith('commander.')) process.exit(2);
    if (typeof e?.exitCode === 'number') process.exit(e.exitCode);
    if (err instanceof Error) process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}

// Only invoke main() when run as a script (not when imported as a module)
if (process.argv[1]?.endsWith('cli.js') || process.argv[1]?.endsWith('cli.ts')) {
  await main();
}
