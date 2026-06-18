/**
 * Join client for zero-knowledge cluster bootstrap.
 *
 * Provides the joiner-side logic for `kici-admin join`:
 * 1. Connect to Platform relay (WS) or direct peer (HTTP POST)
 * 2. Send join.request with the join token
 * 3. Receive join.response with encrypted config bundle
 * 4. Decrypt bundle using token-derived AES-256-GCM key
 * 5. Write decrypted config as local YAML file
 *
 * The token carries routing info (cleartext for Platform relay) and a secret
 * (used for HKDF key derivation). Only the joiner and the token creator
 * can derive the encryption key -- the Platform relay sees only ciphertext.
 */

import { writeFile } from 'node:fs/promises';

import { createLogger, toErrorMessage } from '@kici-dev/shared';
import { WS_MAX_PAYLOAD_BYTES, type JoinRequest, type JoinResponse } from '@kici-dev/engine';
import { stringify as yamlStringify } from 'yaml';

import { parseToken, deriveKeys, decryptBundle } from './join-token.js';
import type { ConfigBundle } from './join-handler.js';

const logger = createLogger({ prefix: 'join-client' });

interface JoinClientOptions {
  token: string;
  /** Platform WebSocket URL for relay mode (e.g., wss://platform.kici.dev/ws) */
  platformUrl?: string;
  /** Peer HTTP URL for direct mode (e.g., https://orch-1:8080) */
  peerUrl?: string;
  /** API key for Platform authentication (required for --platform mode) */
  apiKey?: string;
  /** Path to write the resulting local config YAML */
  configPath?: string;
}

/**
 * Local config structure written by the join client.
 * Compatible with loadLocalConfig() from config/loader.ts.
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
 * Write a local config object to a YAML file.
 */
export async function writeConfigFile(
  path: string,
  config: Record<string, unknown>,
): Promise<void> {
  await writeFile(path, yamlStringify(config), 'utf-8');
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
   * 4. Write local config YAML
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

    // Build and write local config
    const localConfig = buildLocalConfig(bundle);
    const configPath = this.options.configPath ?? './kici-orchestrator.yaml';
    await writeConfigFile(configPath, localConfig as unknown as Record<string, unknown>);

    logger.info(`Config written to ${configPath}`);
    logger.info('Start the orchestrator with: kici-admin orchestrator start');
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
