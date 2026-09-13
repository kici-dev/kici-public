import { describe, it, expect, vi } from 'vitest';
import { stageAgentPayload, type StageDeps } from './stage-agent-payload.js';
import type { AgentPayloadSource } from './payload-source.js';
import type { SpawnFn, SshResult } from './ssh-exec.js';

const REACH = { agentId: 'box-1', address: '10.0.0.1', sshUser: 'root', sshPort: 22 };
const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nk\n-----END OPENSSH PRIVATE KEY-----';

function sourceReturning(tarballPath: string, sha256: string | null): AgentPayloadSource {
  return { resolve: vi.fn(async () => ({ tarballPath, sha256 })) };
}

function makeSpawn(overrides: Partial<Record<string, SshResult>> = {}): {
  spawnFn: SpawnFn;
  calls: Array<{ command: string; args: string[] }>;
} {
  const calls: Array<{ command: string; args: string[] }> = [];
  const agentStart: SshResult = {
    exitCode: 0,
    stdout: 'SSH_AUTH_SOCK=/tmp/a.sock;\nSSH_AGENT_PID=1;\n',
    stderr: '',
  };
  const spawnFn: SpawnFn = vi.fn(async (command, args) => {
    calls.push({ command, args });
    if (command === 'ssh-agent' && args[0] !== '-k') return agentStart;
    return overrides[command] ?? { exitCode: 0, stdout: '', stderr: '' };
  });
  return { spawnFn, calls };
}

const EXPECTED = 'a'.repeat(64);

function deps(spawnFn: SpawnFn, source: AgentPayloadSource, localHash: string): StageDeps {
  return { spawnFn, payloadSource: source, hashLocalFile: vi.fn(async () => localHash) };
}

describe('stageAgentPayload (ssh-push)', () => {
  it('rejects a local hash mismatch before any transfer happens', async () => {
    const { spawnFn, calls } = makeSpawn();
    const source = sourceReturning('/tmp/p.tar.gz', EXPECTED);
    await expect(
      stageAgentPayload(
        REACH,
        KEY,
        { platform: 'linux-x64', version: '1.2.3', delivery: { mode: 'ssh-push' } },
        deps(spawnFn, source, 'b'.repeat(64)),
      ),
    ).rejects.toThrow(/hash mismatch/i);
    // No scp, no on-box work — fail closed before delivery.
    expect(calls.some((c) => c.command === 'scp')).toBe(false);
  });

  it('refuses to stage a payload with no sha256 sidecar (unverifiable)', async () => {
    const { spawnFn } = makeSpawn();
    const source = sourceReturning('/tmp/p.tar.gz', null);
    await expect(
      stageAgentPayload(
        REACH,
        KEY,
        { platform: 'linux-x64', version: '1.2.3', delivery: { mode: 'ssh-push' } },
        deps(spawnFn, source, EXPECTED),
      ),
    ).rejects.toThrow(/no sha256|unverif/i);
  });

  it('pushes the tarball, verifies on-box, extracts, and returns the launcher path', async () => {
    const { spawnFn, calls } = makeSpawn();
    const source = sourceReturning('/tmp/p.tar.gz', EXPECTED);
    const result = await stageAgentPayload(
      REACH,
      KEY,
      { platform: 'linux-x64', version: '1.2.3', delivery: { mode: 'ssh-push' } },
      deps(spawnFn, source, EXPECTED),
    );
    expect(result.launcherPath).toBe('/opt/kici-init/kici-agent');

    // The tarball went over scp (binary-safe), not ssh cat.
    const scp = calls.find((c) => c.command === 'scp');
    expect(scp?.args).toContain('/tmp/p.tar.gz');

    // The on-box command verifies the hash before extracting.
    const onbox = calls.find(
      (c) => c.command === 'ssh' && c.args.some((a) => a.includes('sha256sum -c')),
    );
    expect(onbox).toBeDefined();
    const cmd = onbox!.args[onbox!.args.length - 1];
    expect(cmd).toContain(EXPECTED);
    expect(cmd).toContain('tar xzf');
    expect(cmd).toContain('/opt/kici-init');
  });

  it('honors a custom extractDir', async () => {
    const { spawnFn } = makeSpawn();
    const source = sourceReturning('/tmp/p.tar.gz', EXPECTED);
    const result = await stageAgentPayload(
      REACH,
      KEY,
      { platform: 'linux-x64', version: '1.2.3', delivery: { mode: 'ssh-push' } },
      { ...deps(spawnFn, source, EXPECTED), extractDir: '/tmp/kici-init' },
    );
    expect(result.launcherPath).toBe('/tmp/kici-init/kici-agent');
  });

  it('throws when the on-box verify/extract fails', async () => {
    const { spawnFn } = makeSpawn({ ssh: { exitCode: 1, stdout: '', stderr: 'checksum FAILED' } });
    const source = sourceReturning('/tmp/p.tar.gz', EXPECTED);
    await expect(
      stageAgentPayload(
        REACH,
        KEY,
        { platform: 'linux-x64', version: '1.2.3', delivery: { mode: 'ssh-push' } },
        deps(spawnFn, source, EXPECTED),
      ),
    ).rejects.toThrow(/extract|verify|checksum/i);
  });
});

describe('stageAgentPayload (s3-direct)', () => {
  it('the box curls the presigned URL, verifies the hash, extracts — no ops-agent transit', async () => {
    const { spawnFn, calls } = makeSpawn();
    const url = 'https://cache.local/agent-packages/1.2.3/kici-agent-linux-x64.tar.gz?sig=abc&x=1';
    const result = await stageAgentPayload(
      REACH,
      KEY,
      {
        platform: 'linux-x64',
        version: '1.2.3',
        delivery: { mode: 's3-direct', presignedUrl: url, sha256: EXPECTED },
      },
      // No payloadSource needed for s3-direct.
      { spawnFn },
    );
    expect(result.launcherPath).toBe('/opt/kici-init/kici-agent');

    // The payload never transits the ops agent: no scp push.
    expect(calls.some((c) => c.command === 'scp')).toBe(false);

    // A single ssh command: curl the presigned URL, verify, extract.
    const onbox = calls.find(
      (c) => c.command === 'ssh' && c.args.some((a) => a.includes('curl -fsSL')),
    );
    expect(onbox).toBeDefined();
    const cmd = onbox!.args[onbox!.args.length - 1];
    expect(cmd).toContain(url);
    expect(cmd).toContain('sha256sum -c');
    expect(cmd).toContain(EXPECTED);
    expect(cmd).toContain('tar xzf');
  });

  it('throws when the box-side pull/verify/extract fails (bad presign or hash)', async () => {
    const { spawnFn } = makeSpawn({ ssh: { exitCode: 22, stdout: '', stderr: 'curl: (22)' } });
    await expect(
      stageAgentPayload(
        REACH,
        KEY,
        {
          platform: 'linux-x64',
          version: '1.2.3',
          delivery: { mode: 's3-direct', presignedUrl: 'https://x/p.tgz', sha256: EXPECTED },
        },
        { spawnFn },
      ),
    ).rejects.toThrow(/s3-direct.*failed|pull\/verify\/extract/i);
  });
});
