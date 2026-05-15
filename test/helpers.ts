import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parse as parseJsonc } from 'jsonc-parser';

import { createProgram } from '../src/cli-program.js';

const tempDirs: string[] = [];

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

/**
 * Run the CLI in-process. Fast (no spawn tax). Captures stdout/stderr
 * and intercepts commander's exitOverride throws.
 *
 * Always installs a fake stdin (non-TTY) so the uninstall confirmation path
 * never hangs waiting for real terminal input:
 *  - opts.stdin provided: fake stdin emits that data then closes (piped input)
 *  - opts.stdin omitted:  fake stdin closes immediately (line === null → error path)
 */
export async function runCliInProcess(
  cwd: string,
  args: string[],
  opts: { stdin?: string } = {}
): Promise<{ status: number; stdout: string; stderr: string }> {
  const prevCwd = process.cwd();
  const prevExitCode = process.exitCode;
  const prevStdoutWrite = process.stdout.write.bind(process.stdout);
  const prevStderrWrite = process.stderr.write.bind(process.stderr);
  const prevStdin = process.stdin;

  let stdoutBuf = '';
  let stderrBuf = '';
  process.stdout.write = ((chunk: unknown) => { stdoutBuf += String(chunk); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => { stderrBuf += String(chunk); return true; }) as typeof process.stderr.write;

  // Install a fake stdin that is non-TTY and either delivers piped data or
  // closes immediately so the stream-listener in the uninstall action never hangs.
  // We build an object that satisfies the EventEmitter interface plus the isTTY
  // and resume properties that the uninstall action checks/calls.
  const fakeStdinBase = new EventEmitter();
  const fakeStdin = Object.assign(fakeStdinBase, {
    isTTY: false as boolean | undefined,
    resume() {
      process.nextTick(() => {
        if (opts.stdin !== undefined) {
          fakeStdinBase.emit('data', Buffer.from(opts.stdin));
        }
        // Always close — the action handler resolves on 'close' if no newline found
        fakeStdinBase.emit('close');
      });
    },
  }) as unknown as NodeJS.ReadStream;
  // process.stdin is configurable (getter-only); replace temporarily with our fake
  Object.defineProperty(process, 'stdin', { configurable: true, value: fakeStdin });

  process.chdir(cwd);
  process.exitCode = undefined;

  let status = 0;
  try {
    const program = createProgram();
    await program.parseAsync(['node', 'rac', ...args]);
    status = process.exitCode ?? 0;
  } catch (err: unknown) {
    const e = err as Record<string, unknown>;
    if (e?.code === 'commander.helpDisplayed' || e?.code === 'commander.version') status = 0;
    else if (typeof e?.code === 'string' && e.code.startsWith('commander.')) status = 2;
    else if (typeof e?.exitCode === 'number') status = e.exitCode;
    else {
      stderrBuf += err instanceof Error ? `${err.message}\n` : String(err);
      status = 1;
    }
  } finally {
    process.stdout.write = prevStdoutWrite;
    process.stderr.write = prevStderrWrite;
    // Restore the original stdin getter
    Object.defineProperty(process, 'stdin', {
      configurable: true,
      get: () => prevStdin,
    });
    process.chdir(prevCwd);
    process.exitCode = prevExitCode;
  }

  return { status, stdout: stdoutBuf, stderr: stderrBuf };
}

export async function seed(root: string): Promise<void> {
  await mkdir(path.join(root, '.rac/agents'), { recursive: true });
  await mkdir(path.join(root, '.rac/skills/project-gates'), { recursive: true });
  await mkdir(path.join(root, '.rac/mcps'), { recursive: true });
  await mkdir(path.join(root, '.rac/rules'), { recursive: true });
  await writeFile(path.join(root, '.rac/config.toml'), '', 'utf8');

  await writeFile(path.join(root, '.rac/agents/reviewer.toml'), 'id = "reviewer"\ninstructions = "./reviewer.md"\n[vendor.opencode]\ntools = ["legacy"]\n', 'utf8');
  await writeFile(path.join(root, '.rac/agents/reviewer.md'), 'Review this project.\n', 'utf8');

  await writeFile(path.join(root, '.rac/skills/project-gates/SKILL.md'), '+++\ndescription = "project checks"\n[vendor.claude.frontmatter]\naudience = "claude"\n[vendor.codex.frontmatter]\naudience = "codex"\n[vendor.opencode.frontmatter]\naudience = "opencode"\n+++\nRun checks\n', 'utf8');
  await writeFile(path.join(root, '.rac/skills/project-gates/checklist.md'), '- test\n', 'utf8');

  await writeFile(path.join(root, '.rac/mcps/project-rules.toml'), 'id = "project-rules"\ncommand = "node"\nargs = ["./mcp.js"]\nstartup_timeout_ms = 1200\nenv_forward = ["PROJECT_RULES_TOKEN"]\n\n[env]\nLOG_LEVEL = "info"\n', 'utf8');

  await writeFile(path.join(root, '.rac/rules/wrappers.toml'), '[[rule]]\nid = "deny-gh-pr-merge"\ndecision = "forbidden"\njustification = "Use wrapper"\ncommand = ["gh", ["pr", "issue"], "merge"]\n\n[[rule]]\nid = "deny-git-push"\ndecision = "forbidden"\njustification = "Use wrapper"\ncommand = ["git", "push"]\nappend_wildcard = false\n', 'utf8');
}
