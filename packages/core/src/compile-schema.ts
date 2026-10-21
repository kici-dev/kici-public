/**
 * Compile schema version — bump when the compilation approach changes (what the
 * digest covers, how the hash input is built, the artifact model).
 * This is NOT the lock file schema version.
 *
 * The compiler that writes a `contentHash` and the agent that re-verifies it
 * must mix in the same number, so `@kici-dev/compiler` `lockfile/hasher.ts` and
 * `@kici-dev/agent` `execution/workflow-loader.ts` both re-export this one
 * definition (through `@kici-dev/core/kici-source-digest`).
 *
 * What each version means:
 *
 * - 3 → 4: the agent artifact switched from a Rolldown-bundled `.compiled.mjs`
 *   to a raw `.kici/` source tarball extracted and imported via the shared
 *   oxc-transform ESM loader hook.
 * - 4 → 5: the hash input became line-ending-normalized (CRLF → LF) so a lock
 *   produced on Linux matches a Windows agent's checkout.
 * - 5 → 6: `bundleSource` became a digest over the whole `.kici/` tree
 *   (`hashKiciSourceTree`) rather than the workflow entry file's text, so the
 *   identity covers the same files the source tarball carries.
 * - 6 → 7: the covered set became declarative — `.kici/.kiciignore` — and the
 *   default exclusions grew to cover `.npmrc`, `package-lock.json` and
 *   `pnpm-lock.yaml`, which a run rewrites inside the tree the agent re-hashes
 *   (the drift gate rejected runs whose source had not moved). Every repo's
 *   `contentHash` moves; `kici compile` regenerates the stale lock files.
 *
 * This module imports nothing from Node: the core barrel exports it, so the
 * orchestrator and the dashboard-facing packages can read it.
 */
export const COMPILE_SCHEMA_VERSION = 7;

/** First words of every compile-schema mismatch message, agent and orchestrator alike. */
export const COMPILE_SCHEMA_MISMATCH_PREFIX =
  'The workflow lock was compiled for a different compile schema:';

/** The mismatch text agents up to 0.24.x throw; still recognised on their failures. */
const LEGACY_MISMATCH_MARKER = 'was compiled by an incompatible @kici-dev/compiler';

const LOCK_FILE = '.kici/kici.lock.json';

/**
 * The compile schema a lock entry declares, or `null` when it declares none
 * the agent would check: 0 is the compiler's "no bundle, no hash" sentinel. Only a
 * positive integer counts, the shape `registrationItemSchema` relays, so one malformed
 * lock entry cannot fail a client's parse of the whole registrations list.
 */
export function lockCompileSchema(
  entry: { compileSchemaVersion?: unknown } | null | undefined,
): number | null {
  const v = entry?.compileSchemaVersion;
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null;
}

export interface CompileSchemaMismatchInput {
  /** The schema the lock entry declares. */
  lockSchema: number;
  /** The schema the agent (or every candidate agent) implements. */
  implementedSchema: number;
  /** `'agent'` when one agent reports its own rejection, `'agents'` for the orchestrator's verdict. */
  implementer: 'agent' | 'agents';
  /** `owner/repo` of the repository whose `.kici/kici.lock.json` holds the entry. */
  lockRepo?: string;
  /** The KiCI release of the implementing agents, when known. */
  implementerRelease?: string;
  /** Set on a re-run: the repository and commit whose recorded lock the re-run replays. */
  rerun?: { repo: string; sha: string };
}

/**
 * The re-run sentence: a re-run replays the lock its original run recorded, so a
 * recompiled lock reaches only the next event.
 */
export function formatRerunLockNote(rerun: { repo: string; sha: string }): string {
  return (
    `This is a re-run. A re-run uses the lock that the original run recorded ` +
    `(${rerun.repo}@${rerun.sha.slice(0, 7)}), so it fails again after you recompile. ` +
    `Only a new event runs the recompiled lock.`
  );
}

/**
 * The one compile-schema mismatch message. It names the lock file and its
 * repository, and picks the remedy by direction: an older lock is recompiled
 * with the agents' compiler release (never an agent downgrade); a newer lock
 * needs newer agents or a recompile.
 */
export function formatCompileSchemaMismatch(input: CompileSchemaMismatchInput): string {
  const { lockSchema, implementedSchema, implementer, lockRepo, implementerRelease, rerun } = input;
  const lockFile = lockRepo ? `${LOCK_FILE} in ${lockRepo}` : LOCK_FILE;
  const subject = implementer === 'agent' ? 'this agent' : 'these agents';
  const implementsClause =
    implementer === 'agent'
      ? `this agent implements schema ${implementedSchema}`
      : `the agents that run it implement schema ${implementedSchema}`;
  const compiler = implementerRelease
    ? `@kici-dev/compiler ${implementerRelease} (the release of ${subject}; it implements schema ${implementedSchema})`
    : `the @kici-dev/compiler release that matches ${subject} (it implements schema ${implementedSchema})`;
  const recompile = `run \`npx kici compile\`, and commit ${lockFile}.`;

  const remedy =
    lockSchema < implementedSchema
      ? `Install ${compiler}, ${recompile}`
      : `Upgrade ${implementer === 'agent' ? 'the agent' : 'the agents'} to the KiCI release ` +
        `whose compiler compiled this lock, or install ${compiler}, ${recompile}`;

  const parts = [
    `${COMPILE_SCHEMA_MISMATCH_PREFIX} ${lockFile} declares compile schema ${lockSchema}, ` +
      `and ${implementsClause}.`,
    `The schema is part of every content hash, so ${subject} can never accept this lock.`,
    remedy,
  ];
  if (rerun) parts.push(formatRerunLockNote(rerun));
  return parts.join(' ');
}

/** True for a compile-schema mismatch message, from this release's agents or an older one. */
export function isCompileSchemaMismatchMessage(text: string): boolean {
  return text.includes(COMPILE_SCHEMA_MISMATCH_PREFIX) || text.includes(LEGACY_MISMATCH_MARKER);
}
