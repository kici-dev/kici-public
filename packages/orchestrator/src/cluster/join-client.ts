/**
 * Join client: the joiner side of `kici-admin join` (join protocol v2).
 *
 * 1. Build a join.request from the token: its routing part, a one-time X25519
 *    public key, a nonce, and a proof that this host holds the token secret.
 *    The secret itself stays on this host.
 * 2. Send it through the Platform relay (WS) or directly to a peer (HTTP POST).
 * 3. Check the existing orchestrator's proof in the join.response, then open the
 *    configuration bundle sealed to the one-time key.
 * 4. Write the bundle as the env file the orchestrator boots from.
 *
 * A relay sees the routing part, the public keys, the nonces, the proofs and the
 * ciphertext; none of them lets it read or change the bundle.
 */

import { createLogger, toErrorMessage } from '@kici-dev/shared';
import {
  JOIN_PROTOCOL_UNSUPPORTED_MESSAGE,
  JOIN_PROTOCOL_VERSION,
  JoinErrorCode,
  OrchRole,
  PROTOCOL_VERSION,
  WS_MAX_PAYLOAD_BYTES,
  joinResponseSchema,
  type JoinRequest,
  type JoinResponse,
} from '@kici-dev/engine';

import { writeFileSecurely } from '../helpers/secure-write.js';
import { parseToken, tokenHashOf } from './join-token.js';
import {
  createJoinRequest,
  openJoinResponse,
  type SealedJoinResponse,
} from './join-protocol-v2.js';
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
  /** Path to write the env file `orchestrator install --env-file` consumes. */
  envFilePath?: string;
}

/** Default path the join writes its env file to. */
export const DEFAULT_JOIN_ENV_FILE = './kici-orchestrator.env';

/** Mode for the join artifact: it carries the cluster's master secret key. */
const SECRET_FILE_MODE = 0o600;

/** How long a join waits for the join.response, through either transport. */
export const JOIN_TIMEOUT_MS = 30_000;

/** POST target for `--peer`, keeping any base path of the peer URL. */
export function joinEndpointUrl(peerUrl: string): string {
  return new URL('api/v1/cluster/join', peerUrl.endsWith('/') ? peerUrl : `${peerUrl}/`).toString();
}

/** One-line operator message for a refused join. */
export function describeJoinRefusal(response: JoinResponse): string {
  if (response.errorCode === JoinErrorCode.enum.join_protocol_unsupported) {
    return JOIN_PROTOCOL_UNSUPPORTED_MESSAGE;
  }
  const code = response.errorCode ? ` (${response.errorCode})` : '';
  return `Join rejected: ${response.error ?? 'unknown error'}${code}`;
}

function sealedResponseOf(response: JoinResponse): SealedJoinResponse {
  const { joinProtocol, serverPublicKey, serverNonce, serverProof, encryptedBundle } = response;
  if (
    joinProtocol !== JOIN_PROTOCOL_VERSION ||
    !serverPublicKey ||
    !serverNonce ||
    !serverProof ||
    !encryptedBundle
  ) {
    throw new Error('Join response is missing its join protocol v2 fields');
  }
  return { joinProtocol, serverPublicKey, serverNonce, serverProof, encryptedBundle };
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
   * Execute the join flow: send the v2 join.request, check the existing
   * orchestrator's proof, open the sealed bundle, and write the env file. Nothing
   * is written when the response fails its proof.
   */
  async join(): Promise<void> {
    const parsed = parseToken(this.options.token);
    const { fields, state } = createJoinRequest({
      routingB64: parsed.routingB64,
      tokenHash: Buffer.from(tokenHashOf(parsed.secretHex), 'hex'),
    });
    const request: JoinRequest = { type: 'join.request', ...fields };

    logger.info('Sending join request...');
    const response = this.options.platformUrl
      ? await this.joinViaPlatform(request)
      : await this.joinViaPeer(request);

    if (!response.success) {
      throw new Error(describeJoinRefusal(response));
    }

    // openJoinResponse checks the server proof before it opens the bundle.
    const bundle = openJoinResponse(state, sealedResponseOf(response)) as ConfigBundle;

    logger.info('Join successful, writing config...', { clusterId: bundle.clusterId });

    const envFilePath = this.options.envFilePath ?? DEFAULT_JOIN_ENV_FILE;
    await writeEnvFile(envFilePath, bundle);
    logger.info(`Env file written to ${envFilePath}`);
    logger.info(
      `Install the orchestrator with: kici-admin orchestrator install --env-file ${envFilePath}`,
    );
  }

  /**
   * Join via Platform relay: connect WS, authenticate with the API key, send the
   * join.request, receive the join.response.
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
        // Cap the maximum decompressed frame size so a rogue or
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
      let settled = false;

      const timer = setTimeout(() => {
        ws.close();
        finish(() => reject(new Error(`Join request timed out (${JOIN_TIMEOUT_MS / 1000}s)`)));
      }, JOIN_TIMEOUT_MS);

      function finish(fn: () => void): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      }

      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            type: 'auth.request',
            token: apiKey,
            protocolVersion: PROTOCOL_VERSION,
            // The joining host becomes a worker of the cluster it joins.
            capabilities: { orchRole: OrchRole.enum.worker },
          }),
        );
      });

      ws.on('message', (data: Buffer | string) => {
        let msg: { type?: unknown; reason?: unknown };
        try {
          msg = JSON.parse(typeof data === 'string' ? data : data.toString());
        } catch (err) {
          ws.close();
          finish(() =>
            reject(new Error(`Failed to parse Platform message: ${toErrorMessage(err)}`)),
          );
          return;
        }

        if (msg.type === 'auth.success' && !authenticated) {
          authenticated = true;
          ws.send(JSON.stringify(request));
        } else if (msg.type === 'auth.failure') {
          ws.close();
          finish(() =>
            reject(new Error(`Platform auth failed: ${String(msg.reason ?? 'unknown')}`)),
          );
        } else if (msg.type === 'join.response') {
          ws.close();
          const parsed = joinResponseSchema.safeParse(msg);
          finish(() =>
            parsed.success
              ? resolve(parsed.data)
              : reject(new Error('Malformed join response from the Platform')),
          );
        }
        // Every other frame (capabilities, plan headroom, ...) is ignored.
      });

      ws.on('error', (err: Error) => {
        finish(() => reject(new Error(`WebSocket error: ${toErrorMessage(err)}`)));
      });

      ws.on('close', (code: number, reason: Buffer) => {
        const detail = `code ${code}${reason.length > 0 ? `: ${reason.toString()}` : ''}`;
        finish(() =>
          reject(
            new Error(
              authenticated
                ? `WebSocket closed before the join response arrived (${detail})`
                : `WebSocket closed before auth (${detail})`,
            ),
          ),
        );
      });
    });
  }

  /**
   * Join via direct peer: POST the join.request to the peer's join endpoint.
   * There is no fallback to an earlier join protocol.
   */
  async joinViaPeer(request: JoinRequest): Promise<JoinResponse> {
    const peerUrl = this.options.peerUrl!;
    const res = await fetch(joinEndpointUrl(peerUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(JOIN_TIMEOUT_MS),
    });
    const body: unknown = await res.json().catch(() => undefined);
    const parsed = joinResponseSchema.safeParse(body);
    // An orchestrator that predates join protocol v2 answers a body without
    // `token` with this 400.
    if (res.status === 400 && parsed.success && parsed.data.error === 'Missing token') {
      throw new Error(
        `The orchestrator at ${peerUrl} predates join protocol v2. Upgrade it, then join again.`,
      );
    }
    if (parsed.success) return parsed.data;
    throw new Error(`Peer join request failed: HTTP ${res.status}`);
  }
}
