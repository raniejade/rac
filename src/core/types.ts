export type Scope = 'project' | 'user';
export type Target = 'claude' | 'codex' | 'opencode';
export type Kind = 'agent' | 'skill' | 'mcp';

export type AgentDef = {
  id: string;
  name?: string;
  description?: string;
  instructions: string;
  tools?: string[];
  vendor?: Record<string, unknown>;
  sourcePath: string;
  sourceName: string;
};

export type SkillDef = {
  id: string;
  name?: string;
  description: string;
  body: string;
  frontmatter: Record<string, unknown>;
  assets: string[];
  sourcePath: string;
  sourceName: string;
};

export type McpDef = {
  id: string;
  command?: string;
  args?: string[];
  type?: string;
  url?: string;
  startup_timeout_ms?: number;
  envVars: string[];
  sourcePath: string;
  sourceName: string;
};

export type ManifestRecord = {
  version: 1;
  target: Target;
  kind: Kind;
  id: string;
  source: string;
  relPath: string;
  hash: string;
  inventory: ManagedInventoryEntry[];
};

export type ManagedInventoryEntry = {
  version: 1;
  relPath: string;
  format: 'file' | 'json' | 'toml' | 'markdown';
  selector: string;
};

export type InstallManifest = {
  version: 1;
  records: ManifestRecord[];
};

export type InstallOptions = {
  scope: Scope;
  targets: Target[];
  kinds: Kind[];
  dryRun?: boolean;
  clean?: boolean;
  force?: boolean;
  cwd: string;
};

export type InstallResult = {
  create: string[];
  update: string[];
  del: string[];
};
