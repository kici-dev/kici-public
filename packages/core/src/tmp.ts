/**
 * Global temp allocator for KiCI-owned scratch dirs/files.
 *
 * Every allocation is `kici-<label>-XXXXXX` so a single GC pattern
 * (see @kici-dev/core/tmp-gc) sweeps every family. Node-API module
 * (filesystem): exported via the `@kici-dev/core/tmp` subpath, NOT the
 * package barrel, so browser consumers never pull in `node:fs`.
 */
import { mkdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const KICI_TMP_PREFIX = 'kici-';

/**
 * Base directory for KiCI-created temp allocations. Honors the `KICI_TMPDIR`
 * env var (creating it if it does not yet exist) so an operator can route
 * KiCI's temp footprint onto a volume with room; falls back to the OS temp dir
 * otherwise. This is the single resolution point for `KICI_TMPDIR` — the
 * `@kici-dev/shared` `kiciTmpBase` delegates here so there is exactly one env
 * read across the codebase.
 */
export function kiciTmpBase(): string {
  const custom = process.env.KICI_TMPDIR;
  if (!custom) return tmpdir();
  mkdirSync(custom, { recursive: true });
  return custom;
}
const LABEL_RE = /^[a-z0-9-]+$/;

export function assertValidLabel(label: string): void {
  if (!LABEL_RE.test(label)) {
    throw new Error(`invalid temp label "${label}": must match ${LABEL_RE}`);
  }
}

export interface TempHandle {
  readonly path: string;
  cleanup(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface MakeTempOptions {
  base?: string;
  // Only honored by createTempScope's mktemp/mktempFile — a standalone
  // makeTempDir/makeTempFile handle is never auto-registered, so persist is a
  // no-op there.
  persist?: boolean;
}

function makeHandle(rootToRemove: string, exposedPath: string): TempHandle {
  let done = false;
  const cleanup = async (): Promise<void> => {
    if (done) return;
    done = true;
    await rm(rootToRemove, { recursive: true, force: true });
  };
  return { path: exposedPath, cleanup, [Symbol.asyncDispose]: cleanup };
}

export async function makeTempDir(label: string, opts: MakeTempOptions = {}): Promise<TempHandle> {
  assertValidLabel(label);
  // Resolution order: explicit opts.base (caller owns it — e.g. the sandbox
  // bwrap tmpfs) > KICI_TMPDIR (via kiciTmpBase, which mkdir's it) > OS tmpdir.
  const base = opts.base ?? kiciTmpBase();
  const path = await mkdtemp(join(base, `${KICI_TMP_PREFIX}${label}-`));
  return makeHandle(path, path);
}

export async function makeTempFile(
  label: string,
  opts: MakeTempOptions & { suffix?: string } = {},
): Promise<TempHandle> {
  assertValidLabel(label);
  // Same resolution order as makeTempDir: explicit base > KICI_TMPDIR > tmpdir.
  const base = opts.base ?? kiciTmpBase();
  const holder = await mkdtemp(join(base, `${KICI_TMP_PREFIX}${label}-`));
  const filePath = join(holder, `${label}${opts.suffix ?? ''}`);
  await writeFile(filePath, '');
  // cleanup removes the holder dir (and the file within).
  return makeHandle(holder, filePath);
}

export async function withTempDir<T>(
  label: string,
  fn: (path: string) => Promise<T>,
  opts?: MakeTempOptions,
): Promise<T> {
  const h = await makeTempDir(label, opts);
  try {
    return await fn(h.path);
  } finally {
    await h.cleanup();
  }
}

export async function withTempFile<T>(
  label: string,
  fn: (path: string) => Promise<T>,
  opts?: MakeTempOptions & { suffix?: string },
): Promise<T> {
  const h = await makeTempFile(label, opts);
  try {
    return await fn(h.path);
  } finally {
    await h.cleanup();
  }
}

export interface TempScope {
  mktemp(label: string, opts?: MakeTempOptions): Promise<TempHandle>;
  mktempFile(label: string, opts?: MakeTempOptions & { suffix?: string }): Promise<TempHandle>;
  disposeAll(): Promise<void>;
}

export function createTempScope(): TempScope {
  const handles: TempHandle[] = [];

  const register = (h: TempHandle, persist: boolean | undefined): TempHandle => {
    if (persist) return h;
    const wrapped: TempHandle = {
      path: h.path,
      cleanup: async () => {
        const i = handles.indexOf(wrapped);
        if (i >= 0) handles.splice(i, 1);
        await h.cleanup();
      },
      [Symbol.asyncDispose]: async () => wrapped.cleanup(),
    };
    handles.push(wrapped);
    return wrapped;
  };

  return {
    async mktemp(label, opts) {
      return register(await makeTempDir(label, opts), opts?.persist);
    },
    async mktempFile(label, opts) {
      return register(await makeTempFile(label, opts), opts?.persist);
    },
    async disposeAll() {
      const errors: unknown[] = [];
      // LIFO drain: reverse a snapshot so a handle's own cleanup splicing the
      // live array does not perturb iteration.
      for (const h of [...handles].reverse()) {
        try {
          await h.cleanup();
        } catch (err) {
          errors.push(err);
        }
      }
      handles.length = 0;
      if (errors.length) {
        throw new AggregateError(errors, 'temp scope disposeAll had failures');
      }
    },
  };
}
