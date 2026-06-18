/**
 * Shared input-mode helper for `kici-admin secret set` and
 * `kici-admin variable set`.
 *
 * Resolves a value from exactly one of:
 *   --value <plaintext>   — argv literal (warned; goes into shell history)
 *   --prompt              — interactive no-echo prompt (TTY only)
 *   --from-stdin          — pipe (full stdin until EOF)
 *   --from-file <path>    — file contents (--trim default-on)
 *   --from-env  <VAR>     — env var contents
 *
 * Default-mode resolution when no flag is provided:
 *   TTY     -> --prompt
 *   non-TTY -> --from-stdin
 *
 * Optional checks:
 *   --confirm-fingerprint <hex>  — SHA-256 fingerprint guard against
 *     paste corruption.
 *
 * The helper does NOT print to stdout (it returns the value). It DOES
 * write to stderr for the `--value` warning, the prompt label, and any
 * "empty value" warning. Stdout is reserved for the caller's confirmation
 * output so the caller's `--dry-run` summary stays clean.
 */

import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';

export interface SecretInputOptions {
  value?: string;
  fromStdin?: boolean;
  fromFile?: string;
  fromEnv?: string;
  prompt?: boolean;
  trim?: boolean;
  confirmFingerprint?: string;
}

export interface SecretInputResult {
  value: string;
  /** Which input mode supplied the value (after default resolution). */
  source: 'value' | 'stdin' | 'file' | 'env' | 'prompt';
}

const INPUT_MODE_FLAGS: Array<keyof SecretInputOptions> = [
  'value',
  'fromStdin',
  'fromFile',
  'fromEnv',
  'prompt',
];

const FINGERPRINT_RE = /^[0-9a-f]{64}$/i;

export async function resolveSecretInput(
  opts: SecretInputOptions,
  stderr: NodeJS.WritableStream = process.stderr,
  stdin: NodeJS.ReadStream = process.stdin,
): Promise<SecretInputResult> {
  const explicit = INPUT_MODE_FLAGS.filter((flag) => {
    const v = opts[flag];
    return v !== undefined && v !== false;
  });
  if (explicit.length > 1) {
    throw new Error(
      `Ambiguous input mode: pick exactly one of --value, --from-stdin, --from-file, --from-env, --prompt (got: ${explicit
        .map((f) => '--' + f.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()))
        .join(', ')}).`,
    );
  }

  let result: SecretInputResult;
  if (opts.value !== undefined) {
    stderr.write(
      'warning: --value puts the secret in shell history. Prefer --prompt, --from-stdin, --from-env, or --from-file.\n',
    );
    result = { value: opts.value, source: 'value' };
  } else if (opts.fromEnv !== undefined) {
    const envValue = process.env[opts.fromEnv];
    if (envValue === undefined) {
      throw new Error(`--from-env ${opts.fromEnv}: environment variable is not set.`);
    }
    result = { value: envValue, source: 'env' };
  } else if (opts.fromFile !== undefined) {
    const raw = await fs.readFile(opts.fromFile, 'utf8');
    const trimmed = opts.trim === false ? raw : raw.replace(/\r?\n$/, '');
    result = { value: trimmed, source: 'file' };
  } else if (opts.prompt) {
    if (!stdin.isTTY) {
      throw new Error('--prompt requires a TTY; use --from-stdin to read piped input.');
    }
    result = { value: await promptSecret(stderr, stdin), source: 'prompt' };
  } else if (opts.fromStdin) {
    if (stdin.isTTY) {
      throw new Error(
        '--from-stdin requires piped input (no TTY); pipe the value in or use --prompt to enter interactively.',
      );
    }
    result = { value: await readAllStdin(stdin), source: 'stdin' };
  } else {
    // Default-mode resolution.
    if (stdin.isTTY) {
      result = { value: await promptSecret(stderr, stdin), source: 'prompt' };
    } else {
      result = { value: await readAllStdin(stdin), source: 'stdin' };
    }
  }

  if (result.value.length === 0) {
    stderr.write('warning: value is empty.\n');
  }

  if (opts.confirmFingerprint !== undefined) {
    if (!FINGERPRINT_RE.test(opts.confirmFingerprint)) {
      throw new Error(
        '--confirm-fingerprint must be a SHA-256 hex string (64 lowercase hex characters).',
      );
    }
    const actual = createHash('sha256').update(result.value, 'utf8').digest('hex');
    if (actual !== opts.confirmFingerprint.toLowerCase()) {
      throw new Error(
        `--confirm-fingerprint mismatch: expected ${opts.confirmFingerprint.toLowerCase()}, got ${actual}. Value not written.`,
      );
    }
  }

  return result;
}

async function readAllStdin(stdin: NodeJS.ReadStream): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stdin.on('data', (chunk: Buffer | string) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
    });
    stdin.on('end', () =>
      resolve(
        Buffer.concat(chunks)
          .toString('utf8')
          .replace(/\r?\n$/, ''),
      ),
    );
    stdin.on('error', reject);
  });
}

async function promptSecret(
  stderr: NodeJS.WritableStream,
  stdin: NodeJS.ReadStream,
): Promise<string> {
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: stdin, output: stderr });
  if (stdin.setRawMode) stdin.setRawMode(true);

  return new Promise<string>((resolve) => {
    stderr.write('Enter value: ');
    let value = '';

    function onData(chunk: Buffer): void {
      const str = chunk.toString('utf8');
      for (const char of str) {
        if (char === '\n' || char === '\r') {
          stdin.removeListener('data', onData);
          if (stdin.setRawMode) stdin.setRawMode(false);
          stderr.write('\n');
          rl.close();
          resolve(value);
          return;
        } else if (char === '\x7f' || char === '\b') {
          value = value.slice(0, -1);
        } else if (char === '\x03') {
          stderr.write('\n');
          process.exit(1);
        } else {
          value += char;
        }
      }
    }

    stdin.on('data', onData);
  });
}

/**
 * Compute the canonical SHA-256 fingerprint for a value. Helper for
 * callers (tests, --dry-run output) that want to display the same hex
 * the user would pass to `--confirm-fingerprint`.
 */
export function fingerprintValue(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
