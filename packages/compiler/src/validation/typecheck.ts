import { existsSync } from 'node:fs';
import path from 'node:path';
import { $ } from 'zx';
import { initZx } from '@kici-dev/core';
import { compilerError, type CompilerError, type SourceLocation } from '../errors/index.js';

// Initialize zx for cross-platform execution (module-level, runs once on import).
// Without this the `$` invocation below uses zx's default shell/quoting, which
// breaks on Windows — every other zx entrypoint in the compiler does the same.
initZx();

/**
 * Result of the opt-in `tsc --noEmit` type-check pass.
 *
 * `ran: false` means the pass was skipped (no `tsconfig.json` — a
 * JavaScript-only / `--mjs` workspace has no types to check). `ran: true` with
 * an empty `errors` array means the sources type-check cleanly.
 */
export interface TypecheckResult {
  ran: boolean;
  errors: CompilerError[];
}

/** `path(line,col): error TSxxxx: message` — a located tsc diagnostic. */
const TSC_LOCATED_RE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/;
/** `error TSxxxx: message` — a global tsc diagnostic (config errors, etc.). */
const TSC_GLOBAL_RE = /^error (TS\d+): (.+)$/;

/**
 * Turn `tsc --noEmit --pretty false` output into located `E120` compiler errors.
 * Handles both located diagnostics (`file(line,col): error TS…`) and global
 * ones (`error TS…`, e.g. a bad tsconfig). Non-diagnostic noise lines are
 * ignored. Paths are left as tsc emits them (kiciDir-relative), readable in the
 * GNU error format.
 */
export function parseTscOutput(stdout: string): CompilerError[] {
  const errors: CompilerError[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    const located = TSC_LOCATED_RE.exec(line);
    if (located) {
      const [, file, lineStr, colStr, tsCode, message] = located;
      const location: SourceLocation = {
        file,
        line: parseInt(lineStr, 10),
        column: parseInt(colStr, 10),
      };
      errors.push(
        compilerError('E120', `${tsCode}: ${message}`, {
          location,
          suggestion: 'Fix the type error in your workflow source.',
        }),
      );
      continue;
    }
    const global = TSC_GLOBAL_RE.exec(line);
    if (global) {
      const [, tsCode, message] = global;
      errors.push(
        compilerError('E120', `${tsCode}: ${message}`, {
          suggestion: 'Fix the type error in your workflow source.',
        }),
      );
    }
  }
  return errors;
}

/** The E121 "compiler could not be resolved" error. */
function typecheckUnavailable(): CompilerError {
  return compilerError(
    'E121',
    'Type-check unavailable: could not resolve the TypeScript compiler',
    {
      suggestion:
        'Add "typescript" to your .kici/package.json devDependencies (kici init scaffolds it), then reinstall.',
    },
  );
}

/**
 * Run an opt-in `tsc --noEmit` type-check over the workflow sources in
 * `kiciDir`. Skips (returns `ran: false`) when there is no `tsconfig.json`.
 * Prefers the workspace-local `tsc` binary, falling back to `npx typescript`;
 * returns a single `E121` when the compiler cannot be resolved.
 */
export async function runTypecheck(kiciDir: string): Promise<TypecheckResult> {
  const tsconfigPath = path.join(kiciDir, 'tsconfig.json');
  if (!existsSync(tsconfigPath)) {
    return { ran: false, errors: [] };
  }

  const localBin = path.join(kiciDir, 'node_modules', '.bin', 'tsc');
  const usedLocal = existsSync(localBin);
  const invocation = usedLocal ? [localBin] : ['npx', '--yes', '-p', 'typescript', 'tsc'];
  const tscArgs = ['--noEmit', '--pretty', 'false', '-p', tsconfigPath];

  let out;
  try {
    out = await $({ cwd: kiciDir, nothrow: true })`${invocation} ${tscArgs}`;
  } catch {
    // Spawn-time failure (binary not found / npx unavailable).
    return { ran: true, errors: [typecheckUnavailable()] };
  }

  const errors = parseTscOutput(out.stdout);
  if (out.exitCode !== 0 && errors.length === 0) {
    // Non-zero exit with no parseable TS diagnostics: when we fell back to npx,
    // that signals the compiler itself could not be resolved (offline, no
    // installable typescript). A local-bin failure with no output is
    // pathological — surface the raw output so it is never silent.
    if (!usedLocal) {
      return { ran: true, errors: [typecheckUnavailable()] };
    }
    return {
      ran: true,
      errors: [
        compilerError('E120', `type-check failed: ${(out.stderr || out.stdout).trim()}`, {
          suggestion: 'Fix the type error in your workflow source.',
        }),
      ],
    };
  }
  return { ran: true, errors };
}
