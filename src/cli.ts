#!/usr/bin/env node
import { Command, InvalidArgumentError } from 'commander';

import { doctor, initProject, install } from './core/install.js';
import { addProjectPack, listProjectPacks, removeProjectPack } from './core/pack-config.js';
import type { Kind, Scope, Target } from './core/types.js';
import { splitCsv } from './core/util.js';

const TARGET_VALUES = ['claude', 'codex', 'opencode'] as const;
const KIND_VALUES = ['agent', 'skill', 'mcp', 'rule', 'config'] as const;
const SCOPE_VALUES = ['project', 'user'] as const;

function normalizeTargets(value: string | undefined): Target[] {
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

const program = new Command();
program
  .name('rac')
  .description('Install RAC project definitions into Claude/Codex/OpenCode config surfaces')
  .showHelpAfterError()
  .configureOutput({ outputError: (str, write) => write(str) })
  .exitOverride((error) => {
    if (error.code === 'commander.helpDisplayed') process.exit(0);
    if (error.code?.startsWith('commander.')) process.exit(2);
    process.exit(1);
  });

program.command('init')
  .description('Initialize .rac source tree with starter reviewer + project-gates + project-rules + wrapper-deny rule definitions')
  .option('--empty', 'create folders only without starter examples')
  .option('--scope <scope>', 'project|user (default project)')
  .action(async (opts: { empty?: boolean; scope?: string }) => {
    await initProject(process.cwd(), !!opts.empty, normalizeScope(opts.scope));
  });

program.command('install')
  .description('Install selected kinds/targets from .rac definitions')
  .option('--target <targets>', 'comma-separated: claude,codex,opencode')
  .option('--kind <kinds>', 'comma-separated: agent,skill,mcp,rule,config')
  .option('--dry-run', 'print planned changes only')
  .option('--clean', 'delete stale files tracked by manifest for selected kind/target')
  .option('--check', 'verify generated outputs/manifests are up to date without writing')
  .option('--force', 'override unmanaged files')
  .option('--refresh-packs', 'force re-clone of shared pack caches before installing')
  .option('--scope <scope>', 'project|user (default project)')
  .option('--no-merge', 'bypass surgical merge of shared config files; write generated content wholesale')
  .action(async (opts: { target?: string; kind?: string; dryRun?: boolean; clean?: boolean; check?: boolean; force?: boolean; refreshPacks?: boolean; scope?: string; noMerge?: boolean }) => {
    const result = await install({
      targets: normalizeTargets(opts.target),
      kinds: normalizeKinds(opts.kind),
      dryRun: !!opts.dryRun,
      clean: !!opts.clean,
      check: !!opts.check,
      force: !!opts.force,
      refreshPacks: !!opts.refreshPacks,
      scope: normalizeScope(opts.scope),
      noMerge: opts.noMerge ? true : undefined,
      cwd: process.cwd()
    });
    console.log(`create:\n${result.create.join('\n') || '-'}`);
    console.log(`update:\n${result.update.join('\n') || '-'}`);
    console.log(`delete:\n${result.del.join('\n') || '-'}`);
  });

program.command('doctor')
  .description('Validate definitions and print warnings')
  .option('--target <targets>', 'comma-separated: claude,codex,opencode')
  .option('--kind <kinds>', 'comma-separated: agent,skill,mcp,rule,config')
  .option('--scope <scope>', 'project|user (default project)')
  .action(async (opts: { target?: string; kind?: string; scope?: string }) => {
    const warnings = await doctor(process.cwd(), normalizeTargets(opts.target), normalizeKinds(opts.kind), normalizeScope(opts.scope));
    if (warnings.length === 0) {
      console.log('ok');
      return;
    }
    for (const warning of warnings) console.log(warning);
  });

const packProgram = program.command('pack')
  .description('Manage top-level [[packs]] entries in .rac/config.toml');

packProgram.command('add')
  .description('Add a shared pack reference to .rac/config.toml')
  .argument('<id>')
  .argument('<repo>')
  .requiredOption('--ref <ref>')
  .action(async (id: string, repo: string, opts: { ref: string }) => {
    await addProjectPack(process.cwd(), { id, repo, ref: opts.ref });
  });

packProgram.command('list')
  .description('List configured shared packs')
  .action(async () => {
    const packs = await listProjectPacks(process.cwd());
    if (packs.length === 0) {
      console.log('-');
      return;
    }
    for (const pack of packs) console.log(`${pack.id} ${pack.repo} ${pack.ref}`);
  });

packProgram.command('remove')
  .description('Remove a shared pack reference by id')
  .argument('<id>')
  .action(async (id: string) => {
    await removeProjectPack(process.cwd(), id);
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(String(error?.message || error));
  process.exit(1);
});
