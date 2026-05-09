/* global process */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { assert, spawnCapture } from './lib.mjs';

export async function checkOpenCodeProject(sampleRepo) {
  const env = { ...process.env, XDG_DATA_HOME: path.join(sampleRepo, '.opencode-data') };
  const list = await spawnCapture('opencode', ['mcp', 'list', '--pure'], sampleRepo, env);
  assert(list.code === 0, `OpenCode MCP load/list (project-scope) failed with code ${list.code}\nstdout:\n${list.stdout}\nstderr:\n${list.stderr}`);

  const opencodeRaw = await readFile(path.join(sampleRepo, '.opencode', 'opencode.jsonc'), 'utf8');
  const opencodeJson = JSON.parse(opencodeRaw.replace(/^\/\/.*\n/, ''));
  assert(opencodeJson.mcp['project-rules'].environment.LOG_LEVEL === 'info', 'OpenCode project opencode.jsonc missing project-rules environment.LOG_LEVEL');
  assert(opencodeJson.mcp['project-rules'].environment.PROJECT_RULES_TOKEN === '{env:PROJECT_RULES_TOKEN}', 'OpenCode project opencode.jsonc missing project-rules environment.PROJECT_RULES_TOKEN');
}

export async function checkOpenCodeUser({ userHome, xdgConfig, cwd }) {
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_DATA_HOME: path.join(userHome, '.opencode-data')
  };
  const list = await spawnCapture('opencode', ['mcp', 'list', '--pure'], cwd, env);
  assert(list.code === 0, `OpenCode MCP load/list (user-scope) failed with code ${list.code}\nstdout:\n${list.stdout}\nstderr:\n${list.stderr}`);

  const opencodeRaw = await readFile(path.join(xdgConfig, 'opencode', 'opencode.jsonc'), 'utf8');
  const opencodeJson = JSON.parse(opencodeRaw.replace(/^\/\/.*\n/, ''));
  assert(opencodeJson.mcp['project-rules'].environment.LOG_LEVEL === 'info', 'OpenCode user opencode.jsonc missing project-rules environment.LOG_LEVEL');
  assert(opencodeJson.mcp['project-rules'].environment.PROJECT_RULES_TOKEN === '{env:PROJECT_RULES_TOKEN}', 'OpenCode user opencode.jsonc missing project-rules environment.PROJECT_RULES_TOKEN');
}
