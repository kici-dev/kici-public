/**
 * Join client for zero-knowledge cluster bootstrap.
 *
 * Provides the joiner-side logic for `kici-admin join`:
 * 1. Connect to Platform relay (WS) or direct peer (HTTP POST)
 * 2. Send join.request with the join token
 * 3. Receive join.response with encrypted config bundle
 * 4. Decrypt bundle using token-derived AES-256-GCM key
 * 5. Write the decrypted config as an env file the orchestrator boots from
 *
 * The token carries routing info (cleartext for Platform relay) and a secret
 * (used for HKDF key derivation). Only the joiner and the token creator
 * can derive the encryption key -- the Platform relay sees only ciphertext.
 */

import { createLogger, toErrorMessage } from '@kici-dev/shared';
import { WS_MAX_PAYLOAD_BYTES, type JoinRequest, type JoinResponse } from '@kici-dev/engine';
import { stringify as yamlStringify } from 'yaml';

import { writeFileSecurely } from '../helpers/secure-write.js';
import { parseToken, deriveKeys, decryptBundle } from './join-token.js';
import type { ConfigBundle } from './join-handler.js';

const logger = createLogger({ prefix: 'join-client' });

interface JoinClientOptions {
  token: string;
  /** Platform WebSocket URL for relay mode (e.g., wss://api.kici.dev/ws) */
  platformUrl?: string;
  /** Peer HTTP URL for direct mode (e.g., https://orch-1:8080) */
  peerUrl?: string;
  /** API key for Platform authentication (required for --platform mode) */
  apiKey?: string;
  /**
   * Path to write the resulting local config YAML.
   *
   * @deprecated The orchestrator boots from its environment, so nothing reads
   * this file. Leave it unset and use {@link JoinClientOptions.envFilePath}.
   */
  configPath?: string;
  /** Path to write the env file `orchestrator install --env-file` consumes. */
  envFilePath?: string;
}

/** Default path the join writes its env file to. */
export const DEFAULT_JOIN_ENV_FILE = './kici-orchestrator.env';

/** Mode for both join artifacts: they carry the cluster's master secret key. */
const SECRET_FILE_MODE = 0o600;

/**
 * Local config structure written by the deprecated `--config` path.
 *
 * @deprecated `loadLocalConfig()` strips `storage` and `secrets`, and the boot
 * path never reads the file at all.
 */
interface JoinLocalConfig {
  database: { url: string };
  storage?: ConfigBundle['storage'];
  secrets?: { key: string };
}

/**
 * Decrypt a base64-encoded encrypted config bundle using a derived encryption key.
 */
export function decryptAndParseBundle(encryptedB64: string, encryptionKey: Buffer): ConfigBundle {
  const bundleData = Buffer.from(encryptedB64, 'base64');
  return decryptBundle(bundleData, encryptionKey) as ConfigBundle;
}

/**
 * Build a JoinLocalConfig from a decrypted ConfigBundle.
 * Maps bundle fields to the structure expected by loadLocalConfig().
 *
 * @deprecated Feeds the deprecated `--config` artifact. Use
 * {@link buildEnvFile}.
 */
export function buildLocalConfig(bundle: ConfigBundle): JoinLocalConfig {
  const config: JoinLocalConfig = {
    database: { url: bundle.databaseUrl },
  };

  if (bundle.storage) {
    config.storage = bundle.storage;
  }

  if (bundle.secretKey) {
    config.secrets = { key: bundle.secretKey };
  }

  return config;
}

/**
 * Startup environment variable each `ConfigBundle.storage` field is delivered
 * through.
 *
 * The `satisfies` clause makes a bundle storage field with no entry here a
 * compile error, so the projection cannot silently drop one — which is the
 * whole defect this artifact exists to avoid. The companion test pins the
 * other half: every field `sharedConfigSchema.storage` accepts, and every
 * variable named here, resolves in the startup env definition.
 */
export const STORAGE_ENV_VARS = {
  type: 'KICI_STORAGE_TYPE',
  bucket: 'KICI_STORAGE_BUCKET',
  prefix: 'KICI_STORAGE_PREFIX',
  region: 'KICI_STORAGE_REGION',
  endpoint: 'KICI_STORAGE_ENDPOINT',
  externalEndpoint: 'KICI_STORAGE_EXTERNAL_ENDPOINT',
  forcePathStyle: 'KICI_STORAGE_FORCE_PATH_STYLE',
  logBucket: 'KICI_STORAGE_LOG_BUCKET',
} as const satisfies Record<keyof NonNullable<ConfigBundle['storage']>, string>;

/** Header explaining the artifact and naming what the bundle cannot carry. */
const ENV_FILE_HEADER = [
  '# KiCI orchestrator configuration written by `kici-admin join`.',
  '#',
  '# Install the service from this file:',
  '#   kici-admin orchestrator install --env-file <this file>',
  '#',
  '# The join bundle carries the cluster database, its object storage and the',
  '# secrets encryption key. Set the rest yourself.',
  '#',
  '# Set the mode BEFORE you install -- add the line below, or pass',
  '# `--mode <mode>` to `orchestrator install`. The installer bakes the service',
  "# unit's entry point from it, and an independent orchestrator started from a",
  '# unit built for platform/hybrid refuses to boot.',
  '#   KICI_MODE=hybrid                          # platform | hybrid | observed | independent',
  '#',
  '# These are read at start, so they can be filled in any time before that:',
  '#   KICI_PLATFORM_URL=wss://api.kici.dev/ws   # platform/hybrid/observed only',
  '#   KICI_PLATFORM_TOKEN=                      # registration token (kici_ok_...)',
  '#   KICI_BOOTSTRAP_ADMIN_TOKEN=               # openssl rand -hex 32',
  '#',
];

/**
 * Project a decrypted `ConfigBundle` onto the environment variables the
 * orchestrator boot path reads.
 *
 * A value carrying a newline would silently truncate the file, so it is
 * rejected by name rather than written.
 */
export function buildEnvFile(bundle: ConfigBundle): string {
  const lines = [...ENV_FILE_HEADER];

  const push = (name: string, value: string): void => {
    if (/[\r\n]/.test(value)) {
      throw new Error(`Join bundle value for ${name} contains a line break and cannot be written`);
    }
    lines.push(`${name}=${value}`);
  };

  push('KICI_DATABASE_URL', bundle.databaseUrl);
  if (bundle.secretKey !== undefined) {
    push('KICI_SECRET_KEY', bundle.secretKey);
  }
  for (const [field, envVar] of Object.entries(STORAGE_ENV_VARS)) {
    const value = bundle.storage?.[field as keyof typeof STORAGE_ENV_VARS];
    if (value === undefined) continue;
    push(envVar, String(value));
  }

  return lines.join('\n') + '\n';
}

/**
 * Write a file that carries the cluster's secret key at owner-only permissions.
 *
 * Staged through a sibling temporary at that mode: a plain write over a file
 * that already sits at 0644 would leave the key world-readable until the chmod
 * behind it ran.
 */
async function writeSecretFile(path: string, content: string): Promise<void> {
  await writeFileSecurely(path, content, SECRET_FILE_MODE);
}

/**
 * Write the env file the orchestrator boots from.
 */
export async function writeEnvFile(path: string, bundle: ConfigBundle): Promise<void> {
  await writeSecretFile(path, buildEnvFile(bundle));
}

/**
 * Write a local config object to a YAML file.
 *
 * @deprecated The orchestrator boot path is environment-only, so nothing reads
 * this file. Use {@link writeEnvFile}.
 */
export async function writeConfigFile(
  path: string,
  config: Record<string, unknown>,
): Promise<void> {
  await writeSecretFile(path, yamlStringify(config));
}

export class JoinClient {
  constructor(private readonly options: JoinClientOptions) {
    if (!options.platformUrl && !options.peerUrl) {
      throw new Error('Either --platform or --peer must be specified');
    }
    if (options.platformUrl && options.peerUrl) {
      throw new Error('--platform and --peer are mutually exclusive');
    }
  }

  /**
   * Execute the join flow:
   * 1. Send join.request with token to Platform relay or direct peer
   * 2. Receive join.response with encrypted config bundle
   * 3. Decrypt bundle using token-derived key
   * 4. Write the env file the orchestrator boots from (and, when `--config`
   *    names one, the deprecated local YAML)
   */
  async join(): Promise<void> {
    const request: JoinRequest = { type: 'join.request', token: this.options.token };

    logger.info('Sending join request...');
    const response = this.options.platformUrl
      ? await this.joinViaPlatform(request)
      : await this.joinViaPeer(request);

    if (!response.success) {
      throw new Error(`Join rejected: ${response.error ?? 'unknown error'}`);
    }

    if (!response.encryptedBundle) {
      throw new Error('Join response missing encrypted bundle');
    }

    // Decrypt the bundle
    const parsed = parseToken(this.options.token);
    const keys = deriveKeys(Buffer.from(parsed.secretHex, 'hex'));
    const bundle = decryptAndParseBundle(response.encryptedBundle, keys.encryptionKey);

    logger.info('Join successful, writing config...', { clusterId: bundle.clusterId });

    // The deprecated `--config` artifact is written only when the operator
    // names one; the env file is the default and is written otherwise.
    if (this.options.configPath) {
      const localConfig = buildLocalConfig(bundle);
      await writeConfigFile(
        this.options.configPath,
        localConfig as unknown as Record<string, unknown>,
      );
      logger.warn(
        `--config is deprecated: the orchestrator boots from its environment and never reads ${this.options.configPath}. Use --env-file.`,
      );
      logger.info(`Config written to ${this.options.configPath}`);
    }

    if (this.options.envFilePath || !this.options.configPath) {
      const envFilePath = this.options.envFilePath ?? DEFAULT_JOIN_ENV_FILE;
      await writeEnvFile(envFilePath, bundle);
      logger.info(`Env file written to ${envFilePath}`);
      logger.info(
        `Install the orchestrator with: kici-admin orchestrator install --env-file ${envFilePath}`,
      );
    }
  }

  /**
   * Join via Platform relay: connect WS, authenticate, send join.request, receive join.response.
   */
  async joinViaPlatform(request: JoinRequest): Promise<JoinResponse> {
    const url = this.options.platformUrl!;
    const apiKey = this.options.apiKey;
    if (!apiKey) {
      throw new Error('--api-key is required for Platform relay mode');
    }

    // Dynamic import ws for Node.js environments
    const { default: WebSocket } = await import('ws');

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, {
        //: cap maximum decompressed frame size so a rogue or
        // compromised Platform peer cannot OOM the joiner with a compression
        // bomb during the join handshake. Without this, ws@8.x defaults
        // to 100 MiB.
        maxPayload: WS_MAX_PAYLOAD_BYTES,
        perMessageDeflate: {
          concurrencyLimit: 10,
          threshold: 128, // Skip compressing tiny messages like heartbeats
        },
      });
      let authenticated = false;
      let resolved = false;

      const finish = (fn: () => void) => {
        if (!resolved) {
          resolved = true;
          fn();
        }
      };

      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            type: 'auth.request',
            apiKey,
            role: 'orchestrator',
          }),
        );
      });

      ws.on('message', (data: Buffer | string) => {
        try {
          const msg = JSON.parse(typeof data === 'string' ? data : data.toString());

          if (msg.type === 'auth.success' && !authenticated) {
            authenticated = true;
            ws.send(JSON.stringify(request));
          } else if (msg.type === 'auth.failure') {
            ws.close();
            finish(() => reject(new Error(`Platform auth failed: ${msg.reason ?? 'unknown'}`)));
          } else if (msg.type === 'join.response') {
            ws.close();
            finish(() => resolve(msg as JoinResponse));
          }
        } catch (err) {
          ws.close();
          finish(() =>
            reject(new Error(`Failed to parse Platform message: ${toErrorMessage(err)}`)),
          );
        }
      });

      ws.on('error', (err: Error) => {
        finish(() => reject(new Error(`WebSocket error: ${toErrorMessage(err)}`)));
      });

      ws.on('close', () => {
        if (!authenticated) {
          finish(() => reject(new Error('WebSocket closed before auth')));
        }
      });

      // Timeout after 30 seconds
      setTimeout(() => {
        ws.close();
        finish(() => reject(new Error('Join request timed out (30s)')));
      }, 30_000);
    });
  }

  /**
   * Join via direct peer: POST to peer's join endpoint.
   */
  async joinViaPeer(request: JoinRequest): Promise<JoinResponse> {
    const url = new URL('/api/v1/cluster/join', this.options.peerUrl!);
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: request.token }),
    });

    if (!res.ok) {
      throw new Error(`Peer join request failed: HTTP ${res.status}`);
    }

    return (await res.json()) as JoinResponse;
  }
}
