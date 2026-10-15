/**
 * Agent-side SSH helper for bootstrap bring-up, with the same discipline as
 * `infra/prod/hw/ssh.sh` and the deploy-prod `runOnBox` helper: the bring-up
 * private key is piped into an **ephemeral ssh-agent** (`ssh-add -` reads
 * stdin) that is torn down in a `finally`, so the key never lands on disk or in
 * a long-lived process environment, and lives only for one `ssh` / `scp`
 * invocation.
 *
 * The caller supplies the private key (the orchestrator resolves the scoped
 * secret). `sshExec` also drives a pre-boot dropbear / initramfs prompt: a
 * forced-command endpoint such as `cryptroot-unlock` on port 2222, which reads
 * the unlock input on stdin and uses a transient host key distinct from the OS
 * sshd key.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { makeTempDir } from '@kici-dev/core/tmp';
import type { HostReach } from './reach.js';

export type SshHostKeyMode = 'accept-new' | 'strict';

/** The exit code is reported, never thrown away. */
export interface SshResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SshExecOpts {
  /** Piped to the remote command's stdin (e.g. a LUKS passphrase to cryptroot-unlock). */
  stdin?: string;
  /** Default 22; e.g. 2222 for a dropbear initramfs prompt. */
  port?: number;
  /**
   * Defaults to `accept-new`: the dropbear initramfs host key differs from the
   * OS sshd key, so a pinned OS entry must not be reused. `strict` enforces a
   * known_hosts match.
   */
  hostKeyMode?: SshHostKeyMode;
}

/**
 * Process spawn boundary (a subset of `child_process.spawn`), injectable so
 * unit tests can assert the exact argv / env / stdin without a real `ssh`.
 */
export interface SpawnFn {
  (
    command: string,
    args: string[],
    opts: { env: NodeJS.ProcessEnv; stdin?: string },
  ): Promise<SshResult>;
}

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
      // The remote can close its read end mid-write (a pre-boot unlock drops the
      // session; a connect-timeout exits ssh early), emitting EPIPE on
      // child.stdin. Unhandled, it crashes the agent as an uncaught exception.
      // Swallowing it loses nothing: a genuine SSH failure still shows in the
      // 'close' exit code and stderr.
      child.stdin?.on('error', () => {});
      child.stdin?.end(opts.stdin);
    }
  });

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
 * Exit code, stdout and stderr return verbatim and a non-zero exit does not
 * throw: a pre-boot unlock legitimately drops the session, so the caller
 * decides what success looks like.
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
 * Ship local text to a remote path over SSH (`ssh 'cat > path'`) with an
 * ephemeral key. Throws on a non-zero exit: a push must succeed end-to-end.
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
    // Shell-quote the path so the remote shell does not split it.
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
 * Ship a local FILE to a remote path over `scp` with an ephemeral key. The ONLY
 * sanctioned path for a binary payload: `sshPush` pipes a JS string and
 * corrupts binary data (a ~50 MB tarball), so it is for text (launcher
 * scripts) only. Throws on a non-zero exit.
 */
export async function sshPushFile(
  reach: HostReach,
  privateKey: string,
  localFilePath: string,
  remotePath: string,
  opts: { port?: number; hostKeyMode?: SshHostKeyMode } = {},
  deps: SshDeps = {},
): Promise<void> {
  const spawnFn = deps.spawnFn ?? defaultSpawn;
  const hostKeyMode = opts.hostKeyMode ?? 'accept-new';
  const { dest, port } = resolveTarget(reach, opts.port);
  const result = await withEphemeralAgent(privateKey, spawnFn, async (env) => {
    // scp takes uppercase -P for the port (ssh uses -p). The key comes from the
    // ephemeral agent via SSH_AUTH_SOCK, never a temp key file.
    const args = [
      ...baseSshOptions(hostKeyMode),
      '-P',
      String(port),
      localFilePath,
      `${dest}:${remotePath}`,
    ];
    return spawnFn('scp', args, { env });
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `sshPushFile(${reach.agentId}:${remotePath}): exit ${result.exitCode}${
        result.stderr ? `\n${result.stderr}` : ''
      }`,
    );
  }
}

/**
 * Run `body` against a per-call ssh-agent holding the key (loaded via stdin,
 * never a file), killed in `finally`.
 *
 * The socket lives in a private `kici-bootstrap-ssh-*` directory rather than
 * the default `/tmp/ssh-XXXX`. `ssh-agent` daemonizes into its own session, so
 * a SIGKILL of this process (routine when an ephemeral bring-up runner is torn
 * down) skips the `finally` and orphans the daemon; the namespaced path lets a
 * host cleanup job tell a KiCI bring-up agent from an operator's login agent
 * and reap it. An outer `finally` removes the private dir.
 */
async function withEphemeralAgent<T>(
  privateKey: string,
  spawnFn: SpawnFn,
  body: (env: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  const baseEnv = { ...process.env };
  const { path: agentDir, cleanup } = await makeTempDir('bootstrap-ssh');
  const sock = join(agentDir, 'agent.sock');
  try {
    const start = await spawnFn('ssh-agent', ['-a', sock, '-s'], { env: baseEnv });
    if (start.exitCode !== 0) {
      throw new Error(`ssh-agent start failed: exit ${start.exitCode}\n${start.stderr}`);
    }
    const pid = parseAgentPid(start.stdout);
    // SSH_ASKPASS=/bin/false makes a passphrase-protected key fail fast instead
    // of hanging on a TTY prompt. SSH_AUTH_SOCK is the socket bound above, not
    // whatever ssh-agent echoed.
    const agentEnv: NodeJS.ProcessEnv = {
      ...baseEnv,
      SSH_AUTH_SOCK: sock,
      SSH_ASKPASS: '/bin/false',
      DISPLAY: '',
    };
    // Carry only the ephemeral agent's own PID. Without one, drop any inherited
    // SSH_AGENT_PID so `ssh-agent -k` can never signal a login agent; it no-ops
    // and the cleanup job reaps the orphan by its kici-bootstrap-ssh socket.
    if (pid) {
      agentEnv.SSH_AGENT_PID = pid;
    } else {
      delete agentEnv.SSH_AGENT_PID;
    }
    try {
      // ssh-add expects a complete PEM, ending with a newline.
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
        // Best-effort; the host cleanup job reaps an orphan by its socket.
      });
    }
  } finally {
    await cleanup().catch(() => {
      // Best-effort; a host cleanup job can sweep a leaked dir.
    });
  }
}

/** `SSH_AGENT_PID=<n>;` from `ssh-agent -s` output, best-effort. */
function parseAgentPid(out: string): string | undefined {
  return out.match(/SSH_AGENT_PID=([^;\n]+)/)?.[1];
}
