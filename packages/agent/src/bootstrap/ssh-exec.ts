/**
 * Agent-side SSH helper for bootstrap bring-up.
 *
 * Lifts the discipline from `infra/prod/hw/ssh.sh` + the deploy-prod
 * `runOnBox` helper into the agent: the bring-up private key is piped into an
 * **ephemeral ssh-agent** (`ssh-add -` reads it from stdin) and the agent is
 * torn down in a `finally`, so the key never lands on disk and never enters a
 * long-lived process environment. The agent only holds the key for the
 * lifetime of the one `ssh` / `scp` invocation.
 *
 * `sshExec` runs a remote command; `sshPush` ships local bytes to a remote
 * path (`ssh 'cat > path'`). Both accept a resolved private key string
 * (supplied by the caller — the orchestrator resolves the scoped secret and
 * hands the key down). `sshExec` supports `{ stdin, port, hostKeyMode }` so it
 * can also drive a pre-boot dropbear / initramfs prompt (a forced-command
 * endpoint such as `cryptroot-unlock` on port 2222, which accepts the unlock
 * input on stdin and uses a transient host key distinct from the OS sshd key).
 */
import { spawn } from 'node:child_process';
import type { HostReach } from './reach.js';

/** Host-key verification mode for the SSH connection. */
export type SshHostKeyMode = 'accept-new' | 'strict';

/** Result of an SSH invocation: exit code is reported, never thrown away. */
export interface SshResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SshExecOpts {
  /** Piped to the remote command's stdin (e.g. a LUKS passphrase to cryptroot-unlock). */
  stdin?: string;
  /** Override the default SSH port (22). E.g. 2222 for a dropbear initramfs prompt. */
  port?: number;
  /**
   * Host-key verification. Defaults to `accept-new` — the dropbear initramfs
   * host key differs from the OS sshd key, so a pinned OS entry must not be
   * reused. `strict` enforces a known_hosts match.
   */
  hostKeyMode?: SshHostKeyMode;
}

/**
 * Low-level process spawn boundary, injectable so unit tests can assert the
 * exact argv / env / stdin without running a real `ssh`. Mirrors the relevant
 * subset of `child_process.spawn`'s contract.
 */
export interface SpawnFn {
  (
    command: string,
    args: string[],
    opts: { env: NodeJS.ProcessEnv; stdin?: string },
  ): Promise<SshResult>;
}

/** Default spawn boundary backed by `node:child_process.spawn`. */
export const defaultSpawn: SpawnFn = (command, args, opts) =>
  new Promise<SshResult>((resolve, reject) => {
    const child = spawn(command, args, {
      env: opts.env,
      stdio: [opts.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (b: Buffer) => {
      stdout += b.toString();
    });
    child.stderr?.on('data', (b: Buffer) => {
      stderr += b.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
    if (opts.stdin !== undefined) {
      child.stdin?.end(opts.stdin);
    }
  });

/** Deps for the SSH helper — the spawn boundary is injectable for tests. */
export interface SshDeps {
  spawnFn?: SpawnFn;
}

const SSH_USER_DEFAULT = 'root';
const SSH_PORT_DEFAULT = 22;
const HOST_KEY_FLAG: Record<SshHostKeyMode, string> = {
  'accept-new': 'accept-new',
  strict: 'yes',
};

/** Common `-o` flags every bootstrap SSH connection carries. */
function baseSshOptions(hostKeyMode: SshHostKeyMode): string[] {
  return [
    '-o',
    `StrictHostKeyChecking=${HOST_KEY_FLAG[hostKeyMode]}`,
    '-o',
    'ConnectTimeout=10',
    '-o',
    'BatchMode=yes',
  ];
}

/** Resolve the `user@address` target + port from reach metadata. */
function resolveTarget(reach: HostReach, portOverride?: number): { dest: string; port: number } {
  if (!reach.address) {
    throw new Error(`host ${reach.agentId} has no SSH reach address declared`);
  }
  const user = reach.sshUser ?? SSH_USER_DEFAULT;
  const port = portOverride ?? reach.sshPort ?? SSH_PORT_DEFAULT;
  return { dest: `${user}@${reach.address}`, port };
}

/**
 * Run a command on the target over SSH using an ephemeral, in-memory key.
 *
 * The key is loaded into a per-call ssh-agent (never written to disk) and the
 * agent is killed in `finally`. The remote command's exit code / stdout /
 * stderr are returned verbatim — a non-zero exit is reported, not swallowed
 * (a pre-boot unlock legitimately drops the session, so the caller decides
 * what a "success" looks like).
 */
export async function sshExec(
  reach: HostReach,
  privateKey: string,
  command: string,
  opts: SshExecOpts = {},
  deps: SshDeps = {},
): Promise<SshResult> {
  const spawnFn = deps.spawnFn ?? defaultSpawn;
  const hostKeyMode = opts.hostKeyMode ?? 'accept-new';
  const { dest, port } = resolveTarget(reach, opts.port);
  return withEphemeralAgent(privateKey, spawnFn, async (env) => {
    const args = [...baseSshOptions(hostKeyMode), '-p', String(port), dest, command];
    return spawnFn('ssh', args, { env, stdin: opts.stdin });
  });
}

/**
 * Ship local bytes to a remote path over SSH (`ssh 'cat > path'`), using the
 * same ephemeral-key discipline. Throws on a non-zero exit (a push must
 * succeed end-to-end, unlike a pre-boot unlock).
 */
export async function sshPush(
  reach: HostReach,
  privateKey: string,
  localBytes: string,
  remotePath: string,
  opts: { port?: number; hostKeyMode?: SshHostKeyMode } = {},
  deps: SshDeps = {},
): Promise<void> {
  const spawnFn = deps.spawnFn ?? defaultSpawn;
  const hostKeyMode = opts.hostKeyMode ?? 'accept-new';
  const { dest, port } = resolveTarget(reach, opts.port);
  const result = await withEphemeralAgent(privateKey, spawnFn, async (env) => {
    // `cat > path` consumes stdin; we shell-quote the path to avoid splitting.
    const args = [
      ...baseSshOptions(hostKeyMode),
      '-p',
      String(port),
      dest,
      `cat > '${remotePath.replace(/'/g, `'\\''`)}'`,
    ];
    return spawnFn('ssh', args, { env, stdin: localBytes });
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `sshPush(${reach.agentId}:${remotePath}): exit ${result.exitCode}${
        result.stderr ? `\n${result.stderr}` : ''
      }`,
    );
  }
}

/**
 * Start a per-call ephemeral ssh-agent, load the key via stdin (never a file),
 * run `body` with `SSH_AUTH_SOCK` in env, and kill the agent in `finally`.
 */
async function withEphemeralAgent<T>(
  privateKey: string,
  spawnFn: SpawnFn,
  body: (env: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  const baseEnv = { ...process.env };
  const start = await spawnFn('ssh-agent', ['-s'], { env: baseEnv });
  if (start.exitCode !== 0) {
    throw new Error(`ssh-agent start failed: exit ${start.exitCode}\n${start.stderr}`);
  }
  const sock = parseAgentSocket(start.stdout);
  const pid = parseAgentPid(start.stdout);
  // SSH_ASKPASS=/bin/false makes a passphrase-protected key fail fast instead
  // of hanging on a TTY prompt — same contract as ssh.sh.
  const agentEnv: NodeJS.ProcessEnv = {
    ...baseEnv,
    SSH_AUTH_SOCK: sock,
    ...(pid ? { SSH_AGENT_PID: pid } : {}),
    SSH_ASKPASS: '/bin/false',
    DISPLAY: '',
  };
  try {
    // Key on stdin, ending with a newline (ssh-add expects a complete PEM).
    const add = await spawnFn('ssh-add', ['-'], {
      env: agentEnv,
      stdin: privateKey.endsWith('\n') ? privateKey : `${privateKey}\n`,
    });
    if (add.exitCode !== 0) {
      throw new Error(`ssh-add failed: exit ${add.exitCode}\n${add.stderr}`);
    }
    return await body(agentEnv);
  } finally {
    await spawnFn('ssh-agent', ['-k'], { env: agentEnv }).catch(() => {
      // Best-effort teardown; the agent dies with the process anyway.
    });
  }
}

/** Extract `SSH_AUTH_SOCK=<path>;` from `ssh-agent -s` output. */
function parseAgentSocket(out: string): string {
  const m = out.match(/SSH_AUTH_SOCK=([^;\n]+)/);
  if (!m) throw new Error('ssh-agent -s did not emit SSH_AUTH_SOCK');
  return m[1];
}

/** Extract `SSH_AGENT_PID=<n>;` from `ssh-agent -s` output (best-effort). */
function parseAgentPid(out: string): string | undefined {
  return out.match(/SSH_AGENT_PID=([^;\n]+)/)?.[1];
}
