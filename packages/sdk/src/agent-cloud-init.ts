/**
 * Cloud-init `user_data` builder for a scaler-provisioned KiCI agent.
 *
 * Renders a `#cloud-config` that installs + starts the agent with the claimed
 * ephemeral credentials, plus teardown layer L2 — an in-instance max-lifetime
 * self-poweroff. The agent token is written ONLY into a root-only `0600` env
 * file; it never appears in a comment, a process argument, or any other file.
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

/**
 * @deprecated Pass a claim code (ClaimCodeCredentials) so the token never
 * transits cloud-init. Removed at v1.0.0.
 */
export interface CloudInitCredentials {
  agentToken: string;
  agentId: string;
  orchestratorUrl: string;
  labels: string[];
}

/** Preferred: the agent self-claims from a single-use code; the token is minted in-instance. */
export interface ClaimCodeCredentials {
  claimCode: string;
  agentId: string;
  orchestratorUrl: string;
  labels: string[];
}

/** Either credential shape accepted by `buildAgentCloudInit`. */
export type AgentCloudInitCredentials = CloudInitCredentials | ClaimCodeCredentials;

/** How the agent binary is delivered onto the instance. */
export type AgentDeliveryMode = 'container' | 'payload';

/** How the rendered `user_data` string is encoded before it is returned. */
export type UserDataEncoding = 'raw' | 'base64';

/** A cloud-init `write_files` entry the caller adds. */
export interface CloudInitWriteFile {
  path: string;
  content: string;
  permissions?: string;
  owner?: string;
}

export interface AgentCloudInitOptions {
  /** Hard lifetime cap (minutes) after which the instance powers itself off (L2). */
  maxLifetimeMinutes: number;
  /** 'container' (docker run the published agent image) | 'payload' (fetch from orchestrator). */
  deliveryMode?: AgentDeliveryMode;
  /** Container image ref (container mode). */
  agentImage?: string;
  /** Escape hatch: fully override the agent-start command (ignores deliveryMode/agentImage). */
  startCommand?: string;
  /** apt/yum packages → cloud-init `packages:` (unioned with the base). */
  packages?: string[];
  /** Extra `write_files` entries (the reserved env-file path is rejected). */
  writeFiles?: CloudInitWriteFile[];
  /** runcmd lines injected BEFORE the agent starts. */
  runcmdBefore?: string[];
  /** runcmd lines injected AFTER the agent starts. */
  runcmdAfter?: string[];
  /** Extra env appended to the agent env file (keys validated, newline values rejected). */
  agentEnv?: Record<string, string>;
  /** Raw cloud-config YAML to merge everything into (users, ssh, apt, mounts, bootcmd, …). */
  baseCloudConfig?: string;
  /**
   * Encoding of the returned `user_data` string. `'raw'` (the default) returns
   * the plain `#cloud-config` text — what Hetzner `user_data` expects. `'base64'`
   * returns the same text base64-encoded, the form AWS EC2 `UserData` and Azure
   * `customData` expect.
   */
  userDataEncoding?: UserDataEncoding;
}

const AGENT_ENV_FILE = '/etc/kici-agent.env';
const DEFAULT_AGENT_IMAGE = 'quay.io/kici-dev/kici-agent:latest';

interface WriteFileEntry {
  path: string;
  content: string;
  permissions?: string;
  owner?: string;
}

interface CloudConfigModel {
  packages?: string[];
  write_files?: WriteFileEntry[];
  runcmd?: string[];
  [key: string]: unknown;
}

/**
 * The credential-specific env lines. The claim-code form emits a single-use
 * code the agent exchanges for its own token in-instance; the token form emits
 * the token directly (the ONLY place the token appears).
 */
function credentialEnvLines(creds: AgentCloudInitCredentials): string[] {
  if ('claimCode' in creds) {
    return [
      `KICI_ORCHESTRATOR_URL=${creds.orchestratorUrl}`,
      `KICI_SCALER_CLAIM_CODE=${creds.claimCode}`,
      `KICI_AGENT_ID=${creds.agentId}`,
      `KICI_LABELS=${creds.labels.join(',')}`,
    ];
  }
  return [
    `KICI_ORCHESTRATOR_URL=${creds.orchestratorUrl}`,
    `KICI_AGENT_TOKEN=${creds.agentToken}`,
    `KICI_AGENT_ID=${creds.agentId}`,
    `KICI_LABELS=${creds.labels.join(',')}`,
  ];
}

/** Render the agent env-file content (the ONLY place the token appears, in the token form). */
function renderEnvFileContent(
  creds: AgentCloudInitCredentials,
  agentEnv: Record<string, string> | undefined,
): string {
  const lines = [
    ...credentialEnvLines(creds),
    'KICI_SCALER_MANAGED=1',
    ...Object.entries(agentEnv ?? {}).map(([k, v]) => `${k}=${v}`),
  ];
  return `${lines.join('\n')}\n`;
}

/** Dedupe a list preserving first-seen order. */
function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

/** POSIX env-name shape: a letter or underscore, then letters/digits/underscores. */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Reject agentEnv keys that are not POSIX env names and values carrying a newline. */
function validateAgentEnv(agentEnv: Record<string, string> | undefined): void {
  for (const [key, value] of Object.entries(agentEnv ?? {})) {
    if (!ENV_NAME_RE.test(key)) {
      throw new Error(
        `buildAgentCloudInit: invalid agentEnv key "${key}" (must be a POSIX env name)`,
      );
    }
    if (value.includes('\n')) {
      throw new Error(
        `buildAgentCloudInit: agentEnv value for "${key}" must not contain a newline`,
      );
    }
  }
}

/** Reject any caller/base write_files entry targeting the reserved env-file path. */
function assertNoReservedWrite(writeFiles: WriteFileEntry[] | undefined, where: string): void {
  for (const wf of writeFiles ?? []) {
    if (wf.path === AGENT_ENV_FILE) {
      throw new Error(
        `buildAgentCloudInit: ${where} may not write the reserved path ${AGENT_ENV_FILE}`,
      );
    }
  }
}

/** Parse + shape-check a caller-supplied base cloud-config. */
function parseBase(baseCloudConfig: string): CloudConfigModel {
  let parsed: unknown;
  try {
    parsed = parseYaml(baseCloudConfig);
  } catch (err) {
    throw new Error(
      `buildAgentCloudInit: baseCloudConfig is not valid YAML: ${(err as Error).message}`,
    );
  }
  if (parsed == null) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('buildAgentCloudInit: baseCloudConfig must be a cloud-config mapping');
  }
  const base = parsed as CloudConfigModel;
  for (const key of ['packages', 'runcmd', 'write_files'] as const) {
    if (base[key] !== undefined && !Array.isArray(base[key])) {
      throw new Error(`buildAgentCloudInit: baseCloudConfig.${key} must be a list`);
    }
  }
  return base;
}

/** Render the command that starts the agent for the chosen delivery mode. */
function renderStartCommand(opts: AgentCloudInitOptions): string {
  if (opts.startCommand) return opts.startCommand;
  if (opts.deliveryMode === 'payload') return '/usr/local/bin/kici-agent-bootstrap';
  const image = opts.agentImage ?? DEFAULT_AGENT_IMAGE;
  return `docker run -d --restart=no --name kici-agent --network host --env-file ${AGENT_ENV_FILE} ${image}`;
}

/**
 * Build the cloud-config `user_data` string. In the token form the agent token
 * appears only in the reserved env-file write entry (`0600`, root-only); the
 * claim-code form keeps the token off the provisioning channel entirely.
 */
export function buildAgentCloudInit(
  creds: AgentCloudInitCredentials,
  options: AgentCloudInitOptions,
): string {
  validateAgentEnv(options.agentEnv);
  assertNoReservedWrite(options.writeFiles, 'writeFiles');
  const cap = Math.max(1, Math.floor(options.maxLifetimeMinutes));
  const base = options.baseCloudConfig ? parseBase(options.baseCloudConfig) : {};
  assertNoReservedWrite(base.write_files as WriteFileEntry[] | undefined, 'baseCloudConfig');
  const baseWriteFiles = (base.write_files as WriteFileEntry[] | undefined) ?? [];
  const baseRuncmd = (base.runcmd as string[] | undefined) ?? [];
  const basePackages = (base.packages as string[] | undefined) ?? [];

  const envFile: WriteFileEntry = {
    path: AGENT_ENV_FILE,
    permissions: '0600',
    owner: 'root:root',
    content: renderEnvFileContent(creds, options.agentEnv),
  };
  const pkgs = dedupe([...basePackages, ...(options.packages ?? [])]);
  const model: CloudConfigModel = {
    ...base,
    write_files: [...baseWriteFiles, envFile, ...(options.writeFiles ?? [])],
    runcmd: [
      ...baseRuncmd,
      ...(options.runcmdBefore ?? []),
      `systemd-run --on-active=${cap}m --timer-property=AccuracySec=1s /sbin/poweroff`,
      renderStartCommand(options),
      ...(options.runcmdAfter ?? []),
    ],
  };
  if (pkgs.length > 0) model.packages = pkgs;
  else delete model.packages;
  // lineWidth: 0 disables YAML line-folding so long runcmd shell commands stay
  // on a single line (a folded command is legal YAML but fragile to read/edit).
  const cloudConfig = `#cloud-config\n${stringifyYaml(model, { lineWidth: 0 })}`;
  if (options.userDataEncoding === 'base64') {
    return Buffer.from(cloudConfig, 'utf8').toString('base64');
  }
  return cloudConfig;
}
