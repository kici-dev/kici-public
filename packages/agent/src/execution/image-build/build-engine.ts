/**
 * Build a job's container image with the host's build CLI.
 *
 * The CLI is REQUIRED — there is deliberately no socket-API fallback. One build
 * path means one set of Dockerfile semantics: `.dockerignore`, BuildKit and
 * every directive behave as they do on the author's own machine, instead of
 * depending on which agent happened to pick the job up. A host without a CLI
 * cannot run a Dockerfile job, and says so in as many words.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import type { JobImageBuildSpec } from './resolve-build-spec.js';

/** The build CLIs an agent host may provide. */
export const ContainerBuildCli = z.enum(['docker', 'podman']);
export type ContainerBuildCli = z.infer<typeof ContainerBuildCli>;

/** Preference order when the operator expressed none. */
const CLI_PREFERENCE: readonly ContainerBuildCli[] = [
  ContainerBuildCli.enum.docker,
  ContainerBuildCli.enum.podman,
];

/** Lines of build output kept for the failure message. */
const FAILURE_TAIL_LINES = 20;

/** Is `bin` executable somewhere on `PATH`? */
export function binaryOnPath(bin: string): boolean {
  const parts = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  return parts.some((dir) => existsSync(join(dir, bin)));
}

/**
 * The container socket the SANDBOX will use.
 *
 * Mirrors what dockerode's `new Docker()` resolves, and exists so build and run
 * provably agree. A host with both runtimes whose sandbox socket points at
 * podman would otherwise build with docker and then start the job container on
 * a daemon that has never heard of that image — a failure that surfaces as
 * "no such image" and names nothing.
 */
export function sandboxSocketPath(): string {
  return process.env.DOCKER_HOST ?? '/var/run/docker.sock';
}

export function resolveBuildCli(args: {
  configured?: ContainerBuildCli | undefined;
  onPath?: (bin: string) => boolean;
}): ContainerBuildCli {
  const { configured } = args;
  const onPath = args.onPath ?? binaryOnPath;

  if (configured) {
    if (!onPath(configured)) {
      throw new Error(
        `KICI_CONTAINER_BUILD_CLI is set to '${configured}', but '${configured}' is not on ` +
          `PATH on this agent host.`,
      );
    }
    return configured;
  }

  const found = CLI_PREFERENCE.find((bin) => onPath(bin));
  if (!found) {
    throw new Error(
      `This job builds its container image from a Dockerfile, which needs a build CLI on the ` +
        `agent host. Neither 'docker' nor 'podman' is on PATH. Install one, or route the job ` +
        `to a pool whose hosts have one.`,
    );
  }
  return found;
}

/** Point the CLI at a specific daemon, in that CLI's own spelling. */
function socketFlags(cli: ContainerBuildCli, socketPath: string): string[] {
  const url = socketPath.includes('://') ? socketPath : `unix://${socketPath}`;
  return cli === ContainerBuildCli.enum.docker ? ['-H', url] : ['--url', url];
}

export function buildArgv(args: {
  cli: ContainerBuildCli;
  spec: JobImageBuildSpec;
  socketPath?: string | undefined;
}): string[] {
  const { cli, spec, socketPath } = args;
  const argv: string[] = [];
  if (socketPath) argv.push(...socketFlags(cli, socketPath));
  argv.push('build', '-f', spec.dockerfilePath);
  if (spec.target !== undefined) argv.push('--target', spec.target);
  for (const [k, v] of Object.entries(spec.args)) argv.push('--build-arg', `${k}=${v}`);
  for (const [k, v] of Object.entries(spec.labels)) argv.push('--label', `${k}=${v}`);
  argv.push('-t', spec.tag);
  // The context is the last positional, as both CLIs expect.
  argv.push(spec.contextDir);
  return argv;
}

/** Registry credentials in the shape a build CLI's config file expects. */
export interface BuildAuthconfig {
  username: string;
  password: string;
  serveraddress: string;
}

/**
 * Write `authconfig` into a throwaway config directory and return the env that
 * points the CLI at it.
 *
 * A throwaway directory rather than the host's own credential file: the build
 * runs on a shared agent host, and a job's registry token has no business being
 * written where the next job (or the operator) can read it.
 */
async function withTempAuth(
  cli: ContainerBuildCli,
  authconfig: BuildAuthconfig,
): Promise<{ env: Record<string, string>; dispose: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'kici-build-auth-'));
  const encoded = Buffer.from(`${authconfig.username}:${authconfig.password}`).toString('base64');
  const body = JSON.stringify({ auths: { [authconfig.serveraddress]: { auth: encoded } } });

  if (cli === ContainerBuildCli.enum.docker) {
    await writeFile(join(dir, 'config.json'), body, { mode: 0o600 });
    return {
      env: { DOCKER_CONFIG: dir },
      dispose: () => rm(dir, { recursive: true, force: true }),
    };
  }
  const file = join(dir, 'auth.json');
  await writeFile(file, body, { mode: 0o600 });
  return {
    env: { REGISTRY_AUTH_FILE: file },
    dispose: () => rm(dir, { recursive: true, force: true }),
  };
}

/**
 * Split a chunk stream into whole lines, carrying the remainder between chunks.
 *
 * `flush` matters: a builder whose last line has no trailing newline — which is
 * exactly the shape of an error written just before exit — would otherwise leave
 * that line in the carry, and the one line the author most needs would be the
 * one that never reaches the run log.
 */
export function makeLineSplitter(onLine: (line: string) => void): {
  write: (chunk: Buffer) => void;
  flush: () => void;
} {
  let carry = '';
  return {
    write: (chunk: Buffer) => {
      carry += chunk.toString('utf-8');
      const lines = carry.split('\n');
      carry = lines.pop() ?? '';
      for (const line of lines) onLine(line);
    },
    flush: () => {
      if (carry.length === 0) return;
      onLine(carry);
      carry = '';
    },
  };
}

export interface BuildJobImageArgs {
  spec: JobImageBuildSpec;
  cli: ContainerBuildCli;
  socketPath?: string | undefined;
  authconfig?: BuildAuthconfig | undefined;
  /** Every line of build output, in order, for the run log. */
  onLog: (line: string) => void;
  signal?: AbortSignal | undefined;
}

/**
 * Run the build. Resolves when the image is tagged; rejects with the builder's
 * own last words otherwise.
 *
 * The rejection carries real output rather than an exit code because the author
 * is the one who has to act on it, and "exit 1" tells them nothing about which
 * `RUN` failed.
 */
export async function buildJobImage(args: BuildJobImageArgs): Promise<void> {
  const { spec, cli, socketPath, authconfig, onLog, signal } = args;

  // Before the temp auth dir and the spawn: a job cancelled while it was still
  // cloning would otherwise run its whole build to completion, because an
  // already-aborted signal never fires the listener installed below.
  if (signal?.aborted) throw signal.reason ?? new Error('job image build aborted');

  const auth = authconfig ? await withTempAuth(cli, authconfig) : undefined;
  const argv = buildArgv({ cli, spec, ...(socketPath ? { socketPath } : {}) });

  try {
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(cli, argv, {
        env: { ...process.env, ...(auth?.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const tail: string[] = [];
      const record = (line: string) => {
        onLog(line);
        tail.push(line);
        if (tail.length > FAILURE_TAIL_LINES) tail.shift();
      };
      // Both streams matter: BuildKit writes its progress to stderr, and a
      // reader who only saw stdout would watch a successful build in silence.
      const outSplitter = makeLineSplitter(record);
      const errSplitter = makeLineSplitter(record);
      child.stdout.on('data', outSplitter.write);
      child.stderr.on('data', errSplitter.write);

      const onAbort = () => child.kill('SIGKILL');
      signal?.addEventListener('abort', onAbort, { once: true });

      child.on('error', (err) => {
        signal?.removeEventListener('abort', onAbort);
        reject(new Error(`failed to start '${cli} build': ${err.message}`));
      });

      child.on('close', (code) => {
        signal?.removeEventListener('abort', onAbort);
        // Emit whatever sat in each carry: a builder's dying words often have no
        // trailing newline.
        outSplitter.flush();
        errSplitter.flush();
        if (code === 0) {
          resolvePromise();
          return;
        }
        const detail = tail.length > 0 ? `\n${tail.join('\n')}` : '';
        reject(
          new Error(
            `'${cli} build' failed for ${spec.dockerfilePath} (exit ${code ?? 'signal'})${detail}`,
          ),
        );
      });
    });
  } finally {
    await auth?.dispose();
  }
}
