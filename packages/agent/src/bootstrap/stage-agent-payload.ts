/**
 * Stage a self-contained agent payload onto a bring-up target.
 *
 * The core of fresh-box bring-up: resolve a version-keyed payload from an
 * `AgentPayloadSource`, verify it, deliver it, verify it again on the box
 * before extracting, and return the launcher path. The launcher boots the agent
 * on its vendored Node, so a stock rescue box with no Node becomes an agent.
 *
 * Two delivery modes: `ssh-push` (the ops agent pulls the payload from its
 * source, then streams it to the box over a binary-safe scp) and `s3-direct`
 * (the box pulls a presigned URL itself, so no 50 MB transits the ops agent).
 * Every path is fail-closed: a hash it cannot verify is never extracted.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import type { AgentPlatform } from '@kici-dev/shared';
import { sshExec, sshPushFile, type SshDeps } from './ssh-exec.js';
import type { HostReach } from './reach.js';
import type { AgentPayloadSource } from './payload-source.js';
import { shQuote } from '@kici-dev/core';

/** `s3-direct` carries the sha256 the box verifies before extracting. */
export type DeliveryMode =
  { mode: 'ssh-push' } | { mode: 's3-direct'; presignedUrl: string; sha256: string };

export interface StageDeps extends SshDeps {
  /** Required for `ssh-push` only: `S3PayloadSource`, or a local dir for air-gap. */
  payloadSource?: AgentPayloadSource;
  /** Where the payload is extracted on the box (default `/opt/kici-init`). */
  extractDir?: string;
  /** Ops-agent-side file-hash boundary, injectable for tests. Defaults to a streamed sha256. */
  hashLocalFile?: (filePath: string) => Promise<string>;
}

export interface StageOpts {
  platform: AgentPlatform;
  version: string;
  delivery: DeliveryMode;
}

/** Default extract dir; overridable for a rescue env whose `/opt` is read-only. */
const DEFAULT_EXTRACT_DIR = '/opt/kici-init';
const REMOTE_TARBALL_PATH = '/tmp/kici-agent-payload.tar.gz';

function hashFileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(filePath)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Runs on the ops agent before any transfer. A payload with no sidecar hash is
 * refused (fail-closed), and a mismatch throws, so corrupt or tampered bytes
 * never leave this process.
 */
async function verifyLocalPayload(
  tarballPath: string,
  expectedSha256: string | null,
  deps: StageDeps,
): Promise<string> {
  if (!expectedSha256) {
    throw new Error(
      `refusing to stage ${tarballPath}: no sha256 sidecar — cannot verify the payload (run \`kici-admin agent package\` to (re)generate it with a hash)`,
    );
  }
  const actual = await (deps.hashLocalFile ?? hashFileSha256)(tarballPath);
  if (actual !== expectedSha256) {
    throw new Error(
      `payload hash mismatch for ${tarballPath}: expected ${expectedSha256}, got ${actual}`,
    );
  }
  return expectedSha256;
}

/** `sha256sum -c` breaks the `&&` chain on a mismatch, so only verified bytes extract. */
async function verifyAndExtractRemote(
  reach: HostReach,
  privateKey: string,
  sha256: string,
  extractDir: string,
  deps: StageDeps,
): Promise<void> {
  const remoteBase = path.posix.basename(REMOTE_TARBALL_PATH);
  const remoteDir = path.posix.dirname(REMOTE_TARBALL_PATH);
  const command = [
    `cd ${shQuote(remoteDir)}`,
    `echo ${shQuote(`${sha256}  ${remoteBase}`)} | sha256sum -c -`,
    `mkdir -p ${shQuote(extractDir)}`,
    `tar xzf ${shQuote(remoteBase)} -C ${shQuote(extractDir)}`,
  ].join(' && ');
  const res = await sshExec(reach, privateKey, command, {}, deps);
  if (res.exitCode !== 0) {
    throw new Error(
      `on-box verify/extract on ${reach.agentId} failed: exit ${res.exitCode}${
        res.stderr ? `\n${res.stderr}` : ''
      }`,
    );
  }
}

/** Resolve → verify locally → push → verify+extract on box. */
async function stageSshPush(
  reach: HostReach,
  privateKey: string,
  opts: StageOpts,
  extractDir: string,
  deps: StageDeps,
): Promise<void> {
  if (!deps.payloadSource) {
    throw new Error(
      'ssh-push delivery requires a payload source (KICI_AGENT_BINARY_SOURCE / KICI_AGENT_PAYLOAD_DIR)',
    );
  }
  const staged = await deps.payloadSource.resolve(opts.platform, opts.version);
  const sha256 = await verifyLocalPayload(staged.tarballPath, staged.sha256, deps);
  await sshPushFile(reach, privateKey, staged.tarballPath, REMOTE_TARBALL_PATH, {}, deps);
  await verifyAndExtractRemote(reach, privateKey, sha256, extractDir, deps);
}

/**
 * One `sshExec` pulls, verifies and extracts on the box. `sha256sum -c` breaks
 * the `&&` chain on a mismatch, and `curl -f` on a non-2xx (an expired or
 * absent presign).
 */
async function stageS3Direct(
  reach: HostReach,
  privateKey: string,
  presignedUrl: string,
  sha256: string,
  extractDir: string,
  deps: StageDeps,
): Promise<void> {
  const remoteBase = path.posix.basename(REMOTE_TARBALL_PATH);
  const remoteDir = path.posix.dirname(REMOTE_TARBALL_PATH);
  const command = [
    `cd ${shQuote(remoteDir)}`,
    `curl -fsSL ${shQuote(presignedUrl)} -o ${shQuote(remoteBase)}`,
    `echo ${shQuote(`${sha256}  ${remoteBase}`)} | sha256sum -c -`,
    `mkdir -p ${shQuote(extractDir)}`,
    `tar xzf ${shQuote(remoteBase)} -C ${shQuote(extractDir)}`,
  ].join(' && ');
  const res = await sshExec(reach, privateKey, command, {}, deps);
  if (res.exitCode !== 0) {
    throw new Error(
      `s3-direct pull/verify/extract on ${reach.agentId} failed: exit ${res.exitCode}${
        res.stderr ? `\n${res.stderr}` : ''
      }`,
    );
  }
}

/** Returns the launcher path the caller runs as the init-runner's `agentCommand`. */
export async function stageAgentPayload(
  reach: HostReach,
  privateKey: string,
  opts: StageOpts,
  deps: StageDeps,
): Promise<{ launcherPath: string }> {
  const extractDir = deps.extractDir ?? DEFAULT_EXTRACT_DIR;
  switch (opts.delivery.mode) {
    case 'ssh-push':
      await stageSshPush(reach, privateKey, opts, extractDir, deps);
      break;
    case 's3-direct':
      await stageS3Direct(
        reach,
        privateKey,
        opts.delivery.presignedUrl,
        opts.delivery.sha256,
        extractDir,
        deps,
      );
      break;
  }
  return { launcherPath: path.posix.join(extractDir, 'kici-agent') };
}
