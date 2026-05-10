export type Pack = string;
export type Target = 'claude' | 'codex' | 'opencode';
export type Kind = 'agent' | 'skill' | 'mcp' | 'rule' | 'config';
export type Scope = 'project' | 'user';

export type AgentDef = {
  pack: Pack;
  packRoot: string;
  id: string;
  name?: string;
  description?: string;
  instructions: string;
  instructionsIsTemplate?: boolean;
  tools?: string[];
  vendor?: Record<string, unknown>;
  sourcePath: string;
  sourceName: string;
};

export type SkillDef = {
  pack: Pack;
  packRoot: string;
  id: string;
  name?: string;
  description: string;
  body: string;
  bodyIsTemplate?: boolean;
  frontmatter: Record<string, unknown>;
  assets: string[];
  sourcePath: string;
  sourceName: string;
};

export type McpDef = {
  pack: Pack;
  packRoot: string;
  id: string;
  command?: string;
  args?: string[];
  url?: string;
  startup_timeout_ms?: number;
  vendor?: Record<string, unknown>;
  env?: Record<string, string>;
  env_forward?: string[];
  envVars: string[];
  sourcePath: string;
  sourceName: string;
};

export type RuleCommandItem = string | string[];
export type RuleDecision = 'allow' | 'forbidden';

export type RuleDef = {
  pack: Pack;
  packRoot: string;
  id: string;
  decision: RuleDecision;
  justification: string;
  command: RuleCommandItem[];
  append_wildcard: boolean;
  sourcePath: string;
  sourceName: string;
};

export type VendorConfigSource = 'config' | 'raw' | 'raw_json';

export type VendorConfigDef = {
  pack: Pack;
  packRoot: string;
  target: Target;
  values: Record<string, unknown>;
  selectors: string[];
  sourcePath: string;
  sourceName: string;
};

export type ManifestRecord = {
  version: 1;
  pack: Pack;
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
  format: 'file' | 'json' | 'toml' | 'markdown';
  selector: string;
  entries?: string[];
};

export type InstallManifest = {
  version: 1;
  records: ManifestRecord[];
};

export type InstallOptions = {
  targets?: Target[];
  kinds: Kind[];
  dryRun?: boolean;
  clean?: boolean;
  check?: boolean;
  force?: boolean;
  refreshPacks?: boolean;
  cwd: string;
  scope?: Scope;
  noMerge?: boolean;
};

export type InstallAction = 'create' | 'update' | 'delete';

export type InstallChange = {
  action: InstallAction;
  target: Target;
  kind: Kind;
  pack: Pack;
  id: string;
  relPath: string;
  absPath: string;
};

export type InstallResult = {
  changes: InstallChange[];
  create: string[];
  update: string[];
  del: string[];
};

export type PackSpec = {
  id: string;
  repo: string;
  ref: string;
};

export type PackRuntime = {
  id: string;
  root: string;
  sourceRepo?: string;
  sourceRef?: string;
};

export type UninstallOptions = {
  cwd: string;
  scope?: Scope;
  targets?: Target[];
  kinds?: Kind[];
  dryRun?: boolean;
  yes?: boolean;
};

export type UninstallChange =
  | { action: 'delete-file'; target: Target; kind: Kind; pack: string; id: string; relPath: string; absPath: string }
  | { action: 'prune-selector'; target: Target; kind: Kind; pack: string; id: string; relPath: string; absPath: string; selector: string }
  | { action: 'delete-manifest'; target: Target; manifestRelPath: string; absPath: string };

export type UninstallResult = {
  changes: UninstallChange[];
  deletedFiles: string[];
  prunedSelectors: Array<{ absPath: string; selector: string }>;
  deletedManifests: string[];
};

export type DiffOptions = {
  cwd: string;
  scope?: Scope;
  targets?: Target[];
  kinds: Kind[];
  refreshPacks?: boolean;
  noMerge?: boolean;
  detectDrift?: boolean; // default true
};

export type DiffEntry = {
  action: 'create' | 'update' | 'delete';
  target: Target;
  kind: Kind;
  pack: Pack;
  id: string;
  relPath: string;
  absPath: string;
  before: string | null;
  after: string | null;
  binary: boolean;
};

export type DriftEntry = {
  target: Target;
  kind: Kind;
  pack: Pack;
  id: string;
  relPath: string;
  absPath: string;
  manifestHash: string;
  currentHash: string;
  current: string | null;
};

export type DiffResult = {
  changes: DiffEntry[];
  drift: DriftEntry[];
  create: string[];
  update: string[];
  del: string[];
};
