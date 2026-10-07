/**
 * Mutual peer authentication over real sockets: a real PeerClient against a
 * hand-written /ws/peer server (with and without a correct server proof), and
 * a real PeerClient against the real peer handler.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { sha256 } from '@kici-dev/shared';
import { jobRerouteSchema, type PeerHeartbeat } from '@kici-dev/engine';
import {
  credentialPsk,
  refAppKey,
  refServerProof,
  refTranscriptHash,
} from '../__test-helpers__/peer-mutual-auth.js';
import { PeerClient } from './peer-client.js';
import { PeerAuthCoordinator } from './peer-auth-coordinator.js';
import { PeerRegistry } from './peer-registry.js';
import { createPeerHandler, type PeerWsLike } from './peer-handler.js';
import { writeCredentialFile } from './peer-credentials.js';
import {
  decryptMessage,
  deriveSessionKey,
  encryptMessage,
  generateEcdhKeyPair,
} from './peer-crypto.js';

const CLIENT_ID = 'client-orch';
const SERVER_ID = 'server-orch';
const CRED = randomBytes(32).toString('hex');

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function inventory(instanceId: string): Omit<PeerHeartbeat, 'type'> {
  return {
    instanceId,
    term: 1,
    leaderId: null,
    draining: false,
    agents: [],
    capabilities: { s3LogAccess: false },
    timestamp: Date.now(),
  };
}

function jobReroute() {
  return jobRerouteSchema.parse({
    type: 'job.reroute',
    spawnRetry: { maxAttempts: 3, backoffMs: 0 },
    messageId: `msg-${randomBytes(4).toString('hex')}`,
    jobId: 'job-1',
    runId: 'run-1',
    deliveryId: 'del-1',
    routingKey: 'github:42',
    event: 'push',
    action: null,
    payload: {},
    jobName: 'build',
    workflowName: 'ci',
    runsOnLabels: [['linux']],
    triedConnections: [],
    maxHops: 3,
    coordinatorId: SERVER_ID,
  });
}

async function listen(wss: WebSocketServer): Promise<string> {
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  const { port } = wss.address() as AddressInfo;
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const c of wss.clients) c.terminate();
        wss.close(() => resolve());
      }),
  );
  return `ws://127.0.0.1:${port}/ws/peer`;
}

/** A real PeerClient in credential mode, with a credential file holding CRED. */
async function startClient(url: string) {
  const dir = await mkdtemp(join(tmpdir(), 'peer-mutual-auth-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const credentialFile = join(dir, 'peer-credential');
  await writeCredentialFile(credentialFile, {
    instanceId: CLIENT_ID,
    credential: CRED,
    role: 'coordinator',
    issuedAt: new Date().toISOString(),
  });
  const registry = new PeerRegistry();
  const onJobReroute = vi.fn().mockResolvedValue(undefined);
  const onConnected = vi.fn();
  const client = new PeerClient({
    url,
    credentialFile,
    authCoordinator: new PeerAuthCoordinator({ credentialFile, instanceId: CLIENT_ID }),
    instanceId: CLIENT_ID,
    peerRegistry: registry,
    getLocalInventory: () => inventory(CLIENT_ID),
    heartbeatIntervalMs: 200,
    maxReconnectDelayMs: 60_000,
    onJobReroute,
    onJobProgress: vi.fn(),
    onJobCancel: vi.fn(),
    onConnected,
  });
  cleanups.push(() => client.disconnect());
  client.connect();
  return { client, registry, onJobReroute, onConnected };
}

/**
 * A hand-written /ws/peer server that holds the client's credential hash. It
 * accepts the client, sending `serverProof` as `proofMode` says, then sends a
 * job.reroute under K_hs and under the K_app its proof implies.
 */
async function startHandWrittenServer(proofMode: 'none' | 'correct') {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const state = { closed: false, framesAfterAccept: 0 };
  wss.on('connection', (ws: WsSocket) => {
    const ecdh = generateEcdhKeyPair();
    const nonce = randomBytes(32);
    const authSchemes = ['mutual-v2'];
    let handshakeKey: Buffer | null = null;
    let transcriptHash: Buffer | null = null;
    let accepted = false;
    ws.send(
      JSON.stringify({
        type: 'peer.hello',
        ephemeralPublicKey: ecdh.publicKey.toString('base64'),
        nonce: nonce.toString('base64'),
        authSchemes,
      }),
    );
    ws.on('close', () => {
      state.closed = true;
    });
    ws.on('message', (data) => {
      const raw = data.toString();
      if (!handshakeKey) {
        const clientPub = Buffer.from(JSON.parse(raw).ephemeralPublicKey, 'base64');
        handshakeKey = deriveSessionKey(ecdh.privateKey, clientPub, nonce);
        transcriptHash = refTranscriptHash(ecdh.publicKey, nonce, authSchemes, clientPub);
        return;
      }
      if (accepted) {
        state.framesAfterAccept += 1;
        return;
      }
      const request = JSON.parse(decryptMessage(raw, handshakeKey));
      const psk = credentialPsk(CRED);
      const clientProof = Buffer.from(request.clientProof, 'hex');
      const serverProof = refServerProof({
        psk,
        th: transcriptHash!,
        clientProof,
        serverInstanceId: SERVER_ID,
        grantedRole: 'coordinator',
        sessionCredential: null,
      });
      ws.send(
        encryptMessage(
          JSON.stringify({
            type: 'peer.auth.response',
            accepted: true,
            instanceId: SERVER_ID,
            role: 'coordinator',
            ...(proofMode === 'correct' && { serverProof: serverProof.toString('hex') }),
            agents: [],
            capabilities: { s3LogAccess: false },
          }),
          handshakeKey,
        ),
      );
      accepted = true;
      const appKey = refAppKey({
        handshakeKey,
        psk: proofMode === 'correct' ? psk : randomBytes(32),
        th: transcriptHash!,
        clientProof,
        serverProof,
      });
      ws.send(encryptMessage(JSON.stringify(jobReroute()), handshakeKey));
      ws.send(encryptMessage(JSON.stringify(jobReroute()), appKey));
    });
  });
  return { url: await listen(wss), state };
}

describe('mutual peer authentication over real sockets', () => {
  it('refuses a server that accepts without a serverProof, and routes nothing', async () => {
    // fails-when: the client accepts an unproven acceptance over a real socket
    const server = await startHandWrittenServer('none');
    const { client, registry, onJobReroute, onConnected } = await startClient(server.url);
    await vi.waitFor(() => expect(server.state.closed).toBe(true), { timeout: 2_000 });
    expect(client.state).not.toBe('connected');
    expect(onJobReroute).not.toHaveBeenCalled();
    expect(onConnected).not.toHaveBeenCalled();
    expect(registry.getAllPeers()).toHaveLength(0);
    expect(server.state.framesAfterAccept).toBe(0);
  });

  it('accepts the same server when it sends a correct serverProof, and routes under K_app', async () => {
    // breaks-if-wrong: the adversarial case differs from this one only in the proof it sends
    const server = await startHandWrittenServer('correct');
    const { client, registry, onJobReroute, onConnected } = await startClient(server.url);
    await vi.waitFor(() => expect(onJobReroute).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    expect(client.state).toBe('connected');
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(registry.getPeer(SERVER_ID)!.authScheme.outbound).toBe('mutual-v2');
    // The client's own frames after acceptance reach the server.
    await vi.waitFor(() => expect(server.state.framesAfterAccept).toBeGreaterThan(0), {
      timeout: 2_000,
    });
  });

  it('a real client and the real handler mesh, with heartbeats under K_app', async () => {
    const handlerRegistry = new PeerRegistry();
    const handler = createPeerHandler({
      tokenManager: {} as never,
      credentialStore: {
        findByInstanceId: vi.fn(async (instanceId: string) =>
          instanceId === CLIENT_ID
            ? {
                id: 'cred-1',
                instanceId: CLIENT_ID,
                credentialHash: sha256(CRED),
                role: 'coordinator',
                routingKeys: [],
                sourceTokenHash: null,
                createdAt: new Date(),
                lastSeenAt: null,
                lastValidatedBy: null,
                expiresAt: new Date(Date.now() + 86_400_000),
                revokedAt: null,
                metadata: {},
              }
            : null,
        ),
        updateLastSeen: vi.fn().mockResolvedValue(undefined),
      } as never,
      instanceId: SERVER_ID,
      peerRegistry: handlerRegistry,
      getLocalInventory: () => inventory(SERVER_ID),
      heartbeatIntervalMs: 200,
      onJobReroute: vi.fn().mockResolvedValue(undefined),
      onJobProgress: vi.fn(),
      onJobCancel: vi.fn(),
    });
    cleanups.push(() => {
      handler.closeAllInbound();
      handler.cleanup();
    });
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    wss.on('connection', (ws, req) =>
      handler.handleConnection(ws as unknown as PeerWsLike, req.socket.remoteAddress),
    );
    const url = await listen(wss);

    const { client, registry } = await startClient(url);
    await vi.waitFor(() => expect(client.state).toBe('connected'), { timeout: 3_000 });
    expect(registry.getPeer(SERVER_ID)!.authScheme.outbound).toBe('mutual-v2');
    await vi.waitFor(
      () => expect(handlerRegistry.getPeer(CLIENT_ID)?.authScheme.inbound).toBe('mutual-v2'),
      { timeout: 2_000 },
    );
    // Heartbeats flowing both ways prove both sides switched to the same K_app.
    const handlerSeen = handlerRegistry.getPeer(CLIENT_ID)!.lastHeartbeatAt;
    const clientSeen = registry.getPeer(SERVER_ID)!.lastHeartbeatAt;
    await vi.waitFor(
      () => {
        expect(handlerRegistry.getPeer(CLIENT_ID)!.lastHeartbeatAt).toBeGreaterThan(handlerSeen);
        expect(registry.getPeer(SERVER_ID)!.lastHeartbeatAt).toBeGreaterThan(clientSeen);
      },
      { timeout: 3_000 },
    );
  });
});
