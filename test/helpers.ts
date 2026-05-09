import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parse as parseJsonc } from 'jsonc-parser';

const tempDirs: string[] = [];
let cliBuilt = false;

export async function makeTmp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rac-'));
  tempDirs.push(dir);
  return dir;
}

export async function cleanupTmpDirs(): Promise<void> {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function readJsoncFile<T>(filePath: string): Promise<T> {
  return parseJsonc(await readFile(filePath, 'utf8')) as T;
}

export function runCli(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  if (!cliBuilt) {
    const build = spawnSync('npm', ['run', 'build'], { cwd: process.cwd(), encoding: 'utf8' });
    if (build.status !== 0) throw new Error(`failed building CLI for tests: ${build.stderr || build.stdout}`);
    cliBuilt = true;
  }
  const result = spawnSync('node', [path.join(process.cwd(), 'dist/cli.js'), ...args], { cwd, encoding: 'utf8' });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

export async function seed(root: string): Promise<void> {
  await mkdir(path.join(root, '.rac/agents'), { recursive: true });
  await mkdir(path.join(root, '.rac/skills/project-gates'), { recursive: true });
  await mkdir(path.join(root, '.rac/mcps'), { recursive: true });
  await mkdir(path.join(root, '.rac/rules'), { recursive: true });
  await writeFile(path.join(root, '.rac/config.toml'), '', 'utf8');

  await writeFile(path.join(root, '.rac/agents/reviewer.toml'), 'id = "reviewer"\ninstructions = "./reviewer.md"\n[vendor.opencode]\ntools = ["legacy"]\n', 'utf8');
  await writeFile(path.join(root, '.rac/agents/reviewer.md'), 'Review this project.\n', 'utf8');

  await writeFile(path.join(root, '.rac/skills/project-gates/SKILL.md'), '+++\ndescription = "project checks"\nassets = ["checklist.md"]\n[vendor.claude.frontmatter]\naudience = "claude"\n[vendor.codex.frontmatter]\naudience = "codex"\n[vendor.opencode.frontmatter]\naudience = "opencode"\n+++\nRun checks\n', 'utf8');
  await writeFile(path.join(root, '.rac/skills/project-gates/checklist.md'), '- test\n', 'utf8');

  await writeFile(path.join(root, '.rac/mcps/project-rules.toml'), 'id = "project-rules"\ncommand = "node"\nargs = ["./mcp.js"]\nstartup_timeout_ms = 1200\nenv_forward = ["PROJECT_RULES_TOKEN"]\n\n[env]\nLOG_LEVEL = "info"\n', 'utf8');

  await writeFile(path.join(root, '.rac/rules/wrappers.toml'), '[[rule]]\nid = "deny-gh-pr-merge"\ndecision = "forbidden"\njustification = "Use wrapper"\ncommand = ["gh", ["pr", "issue"], "merge"]\n\n[[rule]]\nid = "deny-git-push"\ndecision = "forbidden"\njustification = "Use wrapper"\ncommand = ["git", "push"]\nappend_wildcard = false\n', 'utf8');
}
