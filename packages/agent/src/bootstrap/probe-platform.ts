/**
 * Probe a bring-up target's platform over SSH.
 *
 * A stock rescue box has nothing but sshd — no `kici-agent`, no Node — so we
 * cannot ask the box what to run; we must ask what it IS, then stage the
 * matching self-contained payload. One `uname -s -m` (+ a libc check) maps to
 * an `AgentPlatform`; an unsupported target (musl-only, non-Linux, unknown
 * arch) throws early, naming what was detected, rather than staging bytes that
 * won't boot.
 */
import { AgentPlatform } from '@kici-dev/shared';
import { sshExec, type SshDeps } from './ssh-exec.js';
import type { HostReach } from './reach.js';

/** The remote probe: OS + machine, then the libc flavor (glibc vs musl). */
const PROBE_COMMAND = 'uname -s -m; (ldd --version 2>&1 | head -1) || true';

/**
 * Map `uname -s -m` (+ libc line) output to an `AgentPlatform`. Pure + directly
 * unit-tested. Throws a self-describing error for any unsupported target.
 */
export function parseUname(stdout: string): AgentPlatform {
  const lines = stdout.split('\n');
  const unameLine = (lines[0] ?? '').trim();
  const libc = lines.slice(1).join('\n').toLowerCase();
  const [os, arch] = unameLine.split(/\s+/);

  if (os !== 'Linux') {
    throw new Error(`unsupported bring-up target OS "${os}" (uname: "${unameLine}") — Linux only`);
  }
  // musl libcs need a musl Node build, which nodejs.org does not publish.
  if (libc.includes('musl') || libc.includes('ld-musl')) {
    throw new Error(
      `unsupported bring-up target: musl libc detected (uname: "${unameLine}") — glibc Linux only`,
    );
  }
  if (arch === 'x86_64') return AgentPlatform.enum['linux-x64'];
  if (arch === 'aarch64') return AgentPlatform.enum['linux-arm64'];
  throw new Error(
    `unsupported bring-up target arch "${arch}" (uname: "${unameLine}") — x86_64 or aarch64 only`,
  );
}

/** SSH into `reach` and detect its `AgentPlatform` (one probe, fail-fast on unsupported). */
export async function probeTargetPlatform(
  reach: HostReach,
  privateKey: string,
  deps: SshDeps = {},
): Promise<AgentPlatform> {
  const res = await sshExec(reach, privateKey, PROBE_COMMAND, {}, deps);
  if (res.exitCode !== 0) {
    throw new Error(
      `platform probe on ${reach.agentId} failed: exit ${res.exitCode}${
        res.stderr ? `\n${res.stderr}` : ''
      }`,
    );
  }
  return parseUname(res.stdout);
}
