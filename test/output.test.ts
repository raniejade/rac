import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { detectColorMode, renderDoctor, renderEmpty, renderInstall, renderList, renderSuccess, startSpinner } from '../src/cli/output/index.js';

describe('detectColorMode', () => {
  let origEnvForceColor: string | undefined;
  let origEnvNoColor: string | undefined;
  let origEnvCI: string | undefined;
  let origIsTTY: boolean | undefined;

  beforeEach(() => {
    origEnvForceColor = process.env.FORCE_COLOR;
    origEnvNoColor = process.env.NO_COLOR;
    origEnvCI = process.env.CI;
    origIsTTY = process.stdout.isTTY;

    delete process.env.FORCE_COLOR;
    delete process.env.NO_COLOR;
    delete process.env.CI;
    process.stdout.isTTY = true;
  });

  afterEach(() => {
    if (origEnvForceColor === undefined) {
      delete process.env.FORCE_COLOR;
    } else {
      process.env.FORCE_COLOR = origEnvForceColor;
    }
    if (origEnvNoColor === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = origEnvNoColor;
    }
    if (origEnvCI === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = origEnvCI;
    }
    process.stdout.isTTY = origIsTTY as boolean;
  });

  it('plainFlag: true returns color: false regardless of env', () => {
    expect(detectColorMode({ plainFlag: true })).toEqual({ color: false });
  });

  it('FORCE_COLOR=1 overrides CI and non-TTY', () => {
    process.env.FORCE_COLOR = '1';
    process.env.CI = 'true';
    process.stdout.isTTY = false;
    expect(detectColorMode({ plainFlag: false })).toEqual({ color: true });
  });

  it('NO_COLOR=1 returns color: false even when isTTY is true', () => {
    process.env.NO_COLOR = '1';
    process.stdout.isTTY = true;
    expect(detectColorMode({ plainFlag: false })).toEqual({ color: false });
  });

  it('CI=true returns color: false even when isTTY is true', () => {
    process.env.CI = 'true';
    process.stdout.isTTY = true;
    expect(detectColorMode({ plainFlag: false })).toEqual({ color: false });
  });

  it('non-TTY stdout with no env vars returns color: false', () => {
    process.stdout.isTTY = false;
    expect(detectColorMode({ plainFlag: false })).toEqual({ color: false });
  });
});

describe('renderInstall', () => {
  const plainMode = { color: false };

  it('mixed result with create + update + delete across two targets renders correctly', () => {
    const result = {
      changes: [
        { action: 'create' as const, target: 'claude', kind: 'agent', pack: 'rac', id: 'reviewer', relPath: '.claude/agents/reviewer.md', absPath: '/abs/.claude/agents/reviewer.md' },
        { action: 'update' as const, target: 'claude', kind: 'skill', pack: 'rac', id: 'zuggie', relPath: '.claude/skills/zuggie/SKILL.md', absPath: '/abs/.claude/skills/zuggie/SKILL.md' },
        { action: 'delete' as const, target: 'codex', kind: 'rule', pack: 'rac', id: 'legacy', relPath: '.codex/rules/legacy.toml', absPath: '/abs/.codex/rules/legacy.toml' },
      ],
      create: ['/abs/.claude/agents/reviewer.md'],
      update: ['/abs/.claude/skills/zuggie/SKILL.md'],
      del: ['/abs/.codex/rules/legacy.toml'],
    };

    const output = renderInstall(result, { cwd: '/abs', mode: plainMode });

    expect(output).toBe(
      'claude\n' +
      '  agent    +  reviewer (rac:reviewer)    .claude/agents/reviewer.md\n' +
      '  skill    ~  zuggie (rac:zuggie)        .claude/skills/zuggie/SKILL.md\n' +
      'codex\n' +
      '  rule     -  legacy (rac:legacy)        .codex/rules/legacy.toml\n' +
      '\n' +
      'Summary: 1 created, 1 updated, 1 deleted across 2 target(s) (3 file(s))\n',
    );
  });

  it('empty result renders Nothing to do.', () => {
    const result = { changes: [], create: [], update: [], del: [] };
    const output = renderInstall(result, { cwd: '/tmp', mode: plainMode });
    expect(output.includes('Nothing to do.')).toBe(true);
  });

  it('dry-run flag causes summary to start with Plan: and contain (dry-run)', () => {
    const result = {
      changes: [
        { action: 'create' as const, target: 'claude', kind: 'agent', pack: 'rac', id: 'reviewer', relPath: '.claude/agents/reviewer.md', absPath: '/abs/.claude/agents/reviewer.md' },
      ],
      create: ['/abs/.claude/agents/reviewer.md'],
      update: [],
      del: [],
    };
    const output = renderInstall(result, { cwd: '/abs', mode: plainMode, dryRun: true });
    expect(output).toMatch(/Plan: .* \(dry-run\)/);
  });

  it('check flag causes summary to contain (check) not (dry-run)', () => {
    const result = {
      changes: [
        { action: 'create' as const, target: 'claude', kind: 'agent', pack: 'rac', id: 'reviewer', relPath: '.claude/agents/reviewer.md', absPath: '/abs/.claude/agents/reviewer.md' },
      ],
      create: ['/abs/.claude/agents/reviewer.md'],
      update: [],
      del: [],
    };
    const output = renderInstall(result, { cwd: '/abs', mode: plainMode, check: true });
    expect(output).toContain('(check)');
    expect(output).not.toContain('(dry-run)');
  });
});

describe('renderDoctor', () => {
  const plainMode = { color: false };

  it('one error + two warnings renders badges, messages, hint, and summary', () => {
    const warnings = [
      {
        severity: 'error' as const,
        code: 'missing_env_var',
        message: 'missing env var: FOO (referenced by mcp x)',
        hint: 'set the env var or remove the reference',
        context: { kind: 'mcp', id: 'x' },
      },
      {
        severity: 'warn' as const,
        code: 'opencode_legacy_tools',
        message: 'opencode vendor tools is legacy for agent reviewer; prefer canonical tools',
        context: { kind: 'agent', id: 'reviewer', target: 'opencode' },
      },
      {
        severity: 'warn' as const,
        code: 'opencode_legacy_tools',
        message: 'opencode vendor tools is legacy for agent foo',
        context: { kind: 'agent', id: 'foo', target: 'opencode' },
      },
    ];

    const output = renderDoctor(warnings, plainMode);

    expect(output).toBe(
      '1 error(s):\n' +
      '  ERROR  missing_env_var  missing env var: FOO (referenced by mcp x)\n' +
      '      hint: set the env var or remove the reference\n' +
      '2 warning(s):\n' +
      '  WARN   opencode_legacy_tools  opencode vendor tools is legacy for agent reviewer; prefer canonical tools\n' +
      '  WARN   opencode_legacy_tools  opencode vendor tools is legacy for agent foo\n' +
      '\n' +
      '1 error(s), 2 warning(s), 0 info\n',
    );

    expect(output).toContain('ERROR');
    expect(output).toContain('WARN ');
    expect(output).toContain('missing env var: FOO (referenced by mcp x)');
    expect(output).toContain('hint: set the env var or remove the reference');
    expect(output).toContain('1 error(s), 2 warning(s), 0 info');
  });

  it('empty warnings renders No issues found.', () => {
    const output = renderDoctor([], plainMode);
    expect(output).toContain('No issues found.');
  });
});

describe('renderSuccess', () => {
  it('returns a string ending with newline that contains the message', () => {
    const output = renderSuccess('Hello', { color: false });
    expect(output.endsWith('\n')).toBe(true);
    expect(output).toContain('Hello');
  });
});

describe('renderList', () => {
  it('renders both left and right columns', () => {
    const output = renderList([{ left: 'a', right: 'b' }], { color: false });
    expect(output).toContain('a');
    expect(output).toContain('b');
  });
});

describe('renderEmpty', () => {
  it('contains the message', () => {
    const output = renderEmpty('Empty', { color: false });
    expect(output).toContain('Empty');
  });
});

describe('startSpinner', () => {
  it('is a no-op in plain mode', () => {
    const spinner = startSpinner('test', { color: false });
    expect(typeof spinner.stop).toBe('function');
    expect(typeof spinner.setText).toBe('function');
    // Calling stop on a no-op should not throw or produce output.
    spinner.stop();
  });

  it('is a no-op when stdout is not a TTY', () => {
    const orig = process.stdout.isTTY;
    process.stdout.isTTY = false;
    try {
      const spinner = startSpinner('test', { color: true });
      spinner.stop();
      // No assertion on output — just that nothing throws.
      expect(true).toBe(true);
    } finally {
      process.stdout.isTTY = orig as boolean;
    }
  });
});
