import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parse as parseToml } from 'smol-toml';
import { afterEach, describe, expect, it } from 'vitest';

import { initProject, install } from '../src/core/install.js';

import { cleanupTmpDirs, makeTmp, seed } from './helpers.js';

afterEach(cleanupTmpDirs);

describe('user-scope install', () => {
  async function withUserScope<T>(fn: (home: string, xdg: string) => Promise<T>): Promise<T> {
    const home = await makeTmp();
    const xdg = await makeTmp();
    const prevHome = process.env.RAC_HOME;
    const prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.RAC_HOME = home;
    process.env.XDG_CONFIG_HOME = xdg;
    try { return await fn(home, xdg); }
    finally {
      if (prevHome === undefined) delete process.env.RAC_HOME; else process.env.RAC_HOME = prevHome;
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevXdg;
    }
  }

  async function seedSourceAt(sourceParent: string): Promise<void> {
    return seed(sourceParent);
  }

  it('writes to home + xdg paths under --scope user', async () => {
    await withUserScope(async (home, xdg) => {
      await seedSourceAt(home);
      await install({ cwd: process.cwd(), targets: ['claude', 'codex', 'opencode'], kinds: ['agent', 'skill', 'mcp', 'rule'], scope: 'user' });

      await expect(stat(path.join(home, '.claude/agents/reviewer.md'))).resolves.toBeTruthy();
      await expect(stat(path.join(home, '.codex/agents/reviewer.toml'))).resolves.toBeTruthy();
      await expect(stat(path.join(home, '.agents/skills/project-gates/SKILL.md'))).resolves.toBeTruthy();
      await expect(stat(path.join(home, '.codex/config.toml'))).resolves.toBeTruthy();
      await expect(stat(path.join(home, '.claude.json'))).resolves.toBeTruthy();
      await expect(stat(path.join(home, '.claude/settings.json'))).resolves.toBeTruthy();
      await expect(stat(path.join(xdg, 'opencode/opencode.jsonc'))).resolves.toBeTruthy();
      await expect(stat(path.join(xdg, 'opencode/agents/reviewer.md'))).resolves.toBeTruthy();
      await expect(stat(path.join(home, '.codex/.rac-install-manifest.json'))).resolves.toBeTruthy();
      await expect(stat(path.join(xdg, 'opencode/.rac-install-manifest.json'))).resolves.toBeTruthy();
    });
  });

  it('writes user-scope config kind to home and xdg shared config files', async () => {
    await withUserScope(async (home, xdg) => {
      await seedSourceAt(home);
      await writeFile(
        path.join(home, '.rac/config.toml'),
        '[vendor.codex.config]\nmodel = "gpt-5.5"\n[vendor.claude.config.ui]\ntheme = "dark"\n[vendor.opencode.config]\nplugin = ["opencode-plugin-foo"]\n',
        'utf8'
      );
      await mkdir(path.join(home, '.codex'), { recursive: true });
      await mkdir(path.join(home, '.claude'), { recursive: true });
      await mkdir(path.join(xdg, 'opencode'), { recursive: true });
      await writeFile(path.join(home, '.codex/config.toml'), 'approval_policy = "on-request"\n', 'utf8');
      await writeFile(path.join(home, '.claude/settings.json'), JSON.stringify({ external: true }, null, 2) + '\n', 'utf8');
      await writeFile(path.join(xdg, 'opencode/opencode.jsonc'), '{"external":true}\n', 'utf8');

      await install({ cwd: process.cwd(), targets: ['claude', 'codex', 'opencode'], kinds: ['config'], scope: 'user' });

      const codex = parseToml(await readFile(path.join(home, '.codex/config.toml'), 'utf8')) as { approval_policy?: string; model?: string };
      expect(codex.approval_policy).toBe('on-request');
      expect(codex.model).toBe('gpt-5.5');

      const claude = JSON.parse(await readFile(path.join(home, '.claude/settings.json'), 'utf8')) as { external?: boolean; ui?: { theme?: string } };
      expect(claude.external).toBe(true);
      expect(claude.ui?.theme).toBe('dark');

      const opencode = JSON.parse((await readFile(path.join(xdg, 'opencode/opencode.jsonc'), 'utf8')).replace(/^\/\/.*\n/, '')) as { external?: boolean; plugin?: string[] };
      expect(opencode.external).toBe(true);
      expect(opencode.plugin).toEqual(['opencode-plugin-foo']);
    });
  });

  it('codex config.toml surgical merge preserves user-owned keys', async () => {
    await withUserScope(async (home) => {
      await seedSourceAt(home);
      await mkdir(path.join(home, '.codex'), { recursive: true });
      await writeFile(
        path.join(home, '.codex/config.toml'),
        'approval_policy = "on-request"\n\n[projects."/Users/me/foo"]\ntrust_level = "trusted"\n\n[mcp_servers.user_owned]\ncommand = "user"\nargs = []\n',
        'utf8'
      );

      await install({ cwd: process.cwd(), targets: ['codex'], kinds: ['mcp'], scope: 'user' });

      const merged = await readFile(path.join(home, '.codex/config.toml'), 'utf8');
      const parsed = parseToml(merged) as { approval_policy?: string; projects?: Record<string, unknown>; mcp_servers?: Record<string, unknown> };
      expect(parsed.approval_policy).toBe('on-request');
      expect(parsed.projects?.['/Users/me/foo']).toBeTruthy();
      expect(parsed.mcp_servers?.user_owned).toBeTruthy();
      expect(parsed.mcp_servers?.['project-rules']).toBeTruthy();
    });
  });

  it('claude.json surgical merge preserves user top-level keys', async () => {
    await withUserScope(async (home) => {
      await seedSourceAt(home);
      await writeFile(path.join(home, '.claude.json'), JSON.stringify({ theme: 'dark', mcpServers: { user_one: { command: 'user' } } }, null, 2) + '\n', 'utf8');

      await install({ cwd: process.cwd(), targets: ['claude'], kinds: ['mcp'], scope: 'user' });

      const merged = JSON.parse(await readFile(path.join(home, '.claude.json'), 'utf8')) as { theme?: string; mcpServers?: Record<string, unknown> };
      expect(merged.theme).toBe('dark');
      expect(merged.mcpServers?.user_one).toBeTruthy();
      expect(merged.mcpServers?.['project-rules']).toBeTruthy();
    });
  });

  it('claude settings.json deny[] merge preserves user entries and removes rac entries on rule removal', async () => {
    await withUserScope(async (home) => {
      await seedSourceAt(home);
      await mkdir(path.join(home, '.claude'), { recursive: true });
      await writeFile(
        path.join(home, '.claude/settings.json'),
        JSON.stringify({ theme: 'dark', permissions: { deny: ['Bash(rm -rf /)'] } }, null, 2) + '\n',
        'utf8'
      );

      await install({ cwd: process.cwd(), targets: ['claude'], kinds: ['rule'], scope: 'user' });
      const merged = JSON.parse(await readFile(path.join(home, '.claude/settings.json'), 'utf8')) as { theme?: string; permissions?: { deny?: string[] } };
      expect(merged.theme).toBe('dark');
      expect(merged.permissions?.deny).toContain('Bash(rm -rf /)');
      expect(merged.permissions?.deny?.some((entry) => entry.startsWith('Bash(git push'))).toBe(true);

      await rm(path.join(home, '.rac/rules/wrappers.toml'));
      await install({ cwd: process.cwd(), targets: ['claude'], kinds: ['rule'], scope: 'user', clean: true });
      const after = JSON.parse(await readFile(path.join(home, '.claude/settings.json'), 'utf8')) as { theme?: string; permissions?: { deny?: string[] } };
      expect(after.theme).toBe('dark');
      expect(after.permissions?.deny ?? []).toEqual(['Bash(rm -rf /)']);
    });
  });

  it('removing an mcp definition with --clean drops only rac-owned entries', async () => {
    await withUserScope(async (home) => {
      await seedSourceAt(home);
      await writeFile(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { user_one: { command: 'user' } } }, null, 2) + '\n', 'utf8');
      await install({ cwd: process.cwd(), targets: ['claude'], kinds: ['mcp'], scope: 'user' });

      await rm(path.join(home, '.rac/mcps/project-rules.toml'));
      await install({ cwd: process.cwd(), targets: ['claude'], kinds: ['mcp'], scope: 'user', clean: true });

      const after = JSON.parse(await readFile(path.join(home, '.claude.json'), 'utf8')) as { mcpServers?: Record<string, unknown> };
      expect(after.mcpServers?.user_one).toBeTruthy();
      expect(after.mcpServers?.['project-rules']).toBeUndefined();
    });
  });

  it('project + user installs do not interfere with each other', async () => {
    const project = await makeTmp();
    await seedSourceAt(project);
    await install({ cwd: project, targets: ['codex'], kinds: ['mcp'] });

    await withUserScope(async (home) => {
      await seedSourceAt(home);
      await install({ cwd: process.cwd(), targets: ['codex'], kinds: ['mcp'], scope: 'user' });

      await expect(stat(path.join(project, '.codex/config.toml'))).resolves.toBeTruthy();
      await expect(stat(path.join(home, '.codex/config.toml'))).resolves.toBeTruthy();

      const projectToml = await readFile(path.join(project, '.codex/config.toml'), 'utf8');
      const userToml = await readFile(path.join(home, '.codex/config.toml'), 'utf8');
      expect(projectToml).toContain('project-rules');
      expect(userToml).toContain('project-rules');
    });
  });

  it('--no-merge flag refuses to clobber unmanaged files unless --force', async () => {
    const root = await makeTmp();
    await seed(root);
    await mkdir(path.join(root, '.codex'), { recursive: true });
    await writeFile(path.join(root, '.codex/config.toml'), 'approval_policy = "on-request"\n', 'utf8');

    await expect(install({ cwd: root, targets: ['codex'], kinds: ['mcp'], noMerge: true })).rejects.toThrow('refusing overwrite unmanaged file');
    await expect(install({ cwd: root, targets: ['codex'], kinds: ['mcp'], noMerge: true, force: true })).resolves.toBeTruthy();
    const after = await readFile(path.join(root, '.codex/config.toml'), 'utf8');
    expect(after).not.toContain('approval_policy');
    expect(after).toContain('project-rules');
  });

  it('[install] merge = false config setting bypasses merge by default', async () => {
    const root = await makeTmp();
    await seed(root);
    await writeFile(path.join(root, '.rac/config.toml'), '[install]\nmerge = false\n', 'utf8');
    await mkdir(path.join(root, '.codex'), { recursive: true });
    await writeFile(path.join(root, '.codex/config.toml'), 'approval_policy = "on-request"\n', 'utf8');

    await expect(install({ cwd: root, targets: ['codex'], kinds: ['mcp'] })).rejects.toThrow('refusing overwrite unmanaged file');
  });

  it('init --scope user creates ~/.rac/ scaffolding', async () => {
    await withUserScope(async (home) => {
      await initProject(process.cwd(), false, 'user');
      await expect(stat(path.join(home, '.rac/config.toml'))).resolves.toBeTruthy();
      await expect(stat(path.join(home, '.rac/agents/reviewer.toml'))).resolves.toBeTruthy();
      await expect(stat(path.join(home, '.rac/skills/project-gates/SKILL.md'))).resolves.toBeTruthy();
      await expect(initProject(process.cwd(), false, 'user')).rejects.toThrow('refusing to overwrite existing init examples');
    });
  });
});
