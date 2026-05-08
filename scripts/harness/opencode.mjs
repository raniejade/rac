/* global process */
import path from 'node:path';

import { assert, spawnCapture } from './lib.mjs';

export async function checkOpenCodeProject(sampleRepo) {
  const env = { ...process.env, XDG_DATA_HOME: path.join(sampleRepo, '.opencode-data') };
  const list = await spawnCapture('opencode', ['mcp', 'list', '--pure'], sampleRepo, env);
  assert(list.code === 0, `OpenCode MCP load/list (project-scope) failed with code ${list.code}\nstdout:\n${list.stdout}\nstderr:\n${list.stderr}`);
}

export async function checkOpenCodeUser({ userHome, xdgConfig, cwd }) {
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_DATA_HOME: path.join(userHome, '.opencode-data')
  };
  const list = await spawnCapture('opencode', ['mcp', 'list', '--pure'], cwd, env);
  assert(list.code === 0, `OpenCode MCP load/list (user-scope) failed with code ${list.code}\nstdout:\n${list.stdout}\nstderr:\n${list.stderr}`);
}
