/**
 * `kici run --local [event]` — a real routed dispatch with this machine as the
 * ephemeral agent, through the warm local dev plane. In this phase only the
 * offline (independent) plane is wired; Platform attachment (`--connected` /
 * auto-select hybrid) lands with the attachment work.
 *
 * The offline path reuses the real orchestrator + agent pipeline end-to-end, so
 * the execution parity dividend (emit / cache / needs / parallel / `KICI_SOURCE_*`)
 * holds by construction — there is no second engine.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { logger, toErrorMessage } from '@kici-dev/core';
import { resolveKiciDir } from '../execution/index.js';
import { compileCommand } from './compile.js';
import { withStdoutOnStderr } from './run.js';
import { renderRunBanner } from './run-banner.js';
import { resolvePlaneForRun } from '../local-plane/resolve-plane.js';
import { resolveWorkdir } from '../local-plane/source-provider.js';
import { ensureLocalSource } from '../local-plane/plane-seed.js';
import { seedLocalSecrets } from '../local-plane/secret-seed.js';
import { triggerRun } from '../local-plane/plane-trigger.js';
import { TRUSTED_ROUTING_LABEL, IN_PLACE_ROUTING_LABEL } from '../local-plane/scaler-config.js';
import { injectRunsOnLabel } from '../local-plane/trusted-routing.js';
import { followRun } from '../local-plane/run-follow.js';
import { formatSummary, type RunResult } from '../remote/output/summary.js';

export interface RunRoutedOptions {
  event?: string;
  local?: boolean;
  offline?: boolean;
  connected?: boolean;
  inPlace?: boolean;
  /**
   * Trusted fleet-agent profile: route this run to the plane's trusted label
   * set so steps run with the ambient host env passed through (minus the
   * agent's own KiCI identity secrets). Selects a PRE-CONFIGURED trusted scaler
   * label set by appending the `self-hosted` routing label to the run's job
   * `runsOn` — it never injects `KICI_TRUSTED_ENV` onto a dispatch payload.
   */
  trusted?: boolean;
  /** Flat per-run secrets (`--env KEY=VALUE`); delivery lands with the secret path. */
  env?: string[];
  /**
   * Path to a dispatch payload JSON `{ action?, client_payload? }`. Only read
   * when the event is `dispatch`: `action` becomes the dispatch `types` matcher
   * key and `client_payload` reaches the workflow. This is how `packages/ci`
   * targets a single `dispatch()` workflow (e.g. deploy-stg) on the routed path.
   */
  payload?: string;
  kiciDir?: string;
  quiet?: boolean;
  debug?: boolean;
}

/**
 * Entry point for the action-bearing `kici run`. Validates the routing flags and
 * drives the offline routed run. Returns true on run success.
 */
export async function runRoutedCommand(options: RunRoutedOptions): Promise<boolean> {
  if (options.debug) process.env.KICI_DEBUG = 'true';

  if (!options.local) {
    logger.error(
      pc.red(
        'kici run (connected cloud run) is not yet available. Use `kici run --local` for a ' +
          'routed run on this machine, or `kici run remote <fixture>` for the fixture path.',
      ),
    );
    return false;
  }

  if (!options.event) {
    logger.error(pc.red('Provide an event to run, e.g. `kici run --local push`.'));
    return false;
  }

  return runRouted({ ...options, event: options.event });
}

/**
 * Read a dispatch payload file `{ action?, client_payload? }`. Returns the
 * action + client_payload the routed dispatch trigger carries. An absent
 * `--payload` yields an empty action (a bare `dispatch()` workflow still
 * matches); a present file is parsed as JSON.
 */
export function readDispatchPayload(payloadPath?: string): {
  action?: string;
  clientPayload?: unknown;
} {
  if (!payloadPath) return {};
  const raw = JSON.parse(readFileSync(payloadPath, 'utf-8')) as {
    action?: string;
    client_payload?: unknown;
  };
  return { action: raw.action, clientPayload: raw.client_payload };
}

/** Drive the full routed run against the warm local plane (offline or attached). */
async function runRouted(options: RunRoutedOptions & { event: string }): Promise<boolean> {
  const quiet = Boolean(options.quiet);
  const kiciDir = resolveKiciDir(options.kiciDir);
  const repoRoot = path.resolve(kiciDir, '..');

  // Recompile the lock so the on-disk kici.lock.json the plane fetches (and the
  // overlay commits) reflects the current .kici/ sources.
  const compileOk = quiet
    ? await withStdoutOnStderr(() =>
        compileCommand({ kiciDir, check: false, verbose: options.debug ?? false, quiet: true }),
      )
    : await compileCommand({ kiciDir, check: false, verbose: options.debug ?? false });
  if (!compileOk) return false;

  let cleanup: (() => Promise<void>) | undefined;
  const restoreLocks: Array<() => void> = [];
  try {
    if (!quiet) logger.info(pc.dim('Starting the local dev plane…'));
    // Auto-select the plane (offline / attached / fallback) per the run flags.
    const resolved = await resolvePlaneForRun({
      offline: options.offline,
      connected: options.connected,
    });
    if ('error' in resolved) {
      logger.error(pc.red(resolved.error));
      return false;
    }
    const plane = resolved.plane;
    if (!plane.url || !plane.adminToken) {
      logger.error(pc.red('Local dev plane did not report a URL + admin token.'));
      return false;
    }

    const trusted = Boolean(options.trusted);
    if (!quiet) {
      logger.info(
        renderRunBanner(
          resolved.kind === 'attached'
            ? { mode: 'attached', planeUrl: plane.url, orgId: resolved.orgId, trusted }
            : resolved.kind === 'fallback'
              ? { mode: 'fallback', planeUrl: plane.url, fallbackReason: resolved.reason, trusted }
              : { mode: 'offline', planeUrl: plane.url, trusted },
        ),
      );
    }

    const workdir = await resolveWorkdir({ inPlace: Boolean(options.inPlace), repoRoot });
    cleanup = workdir.cleanup;

    // Trusted profile: route every job onto the plane's trusted label set by
    // appending the `self-hosted` routing label to the workdir lock the plane
    // reads. With `--in-place`, ALSO append `in-place` so the run lands on the
    // trusted IN-PLACE label set (the agent uses the real working tree directly,
    // no clone) — the routed `deploy:stg` profile. restore()s un-dirty an
    // in-place tree in the finally below (an isolated clone is removed by cleanup
    // regardless).
    if (trusted) {
      const lockPath = path.join(workdir.dir, '.kici', 'kici.lock.json');
      restoreLocks.push(injectRunsOnLabel(lockPath, TRUSTED_ROUTING_LABEL).restore);
      if (options.inPlace) {
        restoreLocks.push(injectRunsOnLabel(lockPath, IN_PLACE_ROUTING_LABEL).restore);
      }
    }

    const seeded = await ensureLocalSource(plane.url, plane.adminToken, {
      repoDir: workdir.dir,
      // In-place: the workdir IS the operator's real tree, so the plane skips
      // the source-pack build and the agent runs it directly.
      inPlace: Boolean(options.inPlace),
    });

    // Seed the project's local `secrets.yaml` / `.secrets` contexts into the
    // plane's real scoped-secret store so a job bound to a context resolves the
    // right scoped value through the real resolver (parity over the old
    // flatten). Local secret files stay read-only; values only transit into the
    // local plane's Postgres.
    const seededSecrets = await seedLocalSecrets(plane.url, plane.adminToken, {
      orgId: seeded.orgId,
      kiciDir,
    });
    if (!quiet && seededSecrets.contexts.length > 0) {
      logger.info(
        pc.dim(
          `Seeded ${seededSecrets.secretCount} local secret(s) across ` +
            `${seededSecrets.contexts.length} context(s): ${seededSecrets.contexts.join(', ')}`,
        ),
      );
    }

    if (!quiet) logger.info(pc.dim(`Triggering ${options.event} …`));
    const dispatch = options.event === 'dispatch' ? readDispatchPayload(options.payload) : undefined;
    const runId = await triggerRun(plane.url, plane.adminToken, {
      orgId: seeded.orgId,
      // The generic webhook route resolves a source by (customer_id, name), not
      // by the routing-key's id segment — so the trigger URL carries the name.
      sourceId: seeded.sourceName,
      repoFullName: '.',
      event:
        options.event === 'dispatch'
          ? 'dispatch'
          : options.event === 'pull_request'
            ? 'pull_request'
            : 'push',
      ref: workdir.ref,
      sha: workdir.sha,
      defaultBranch: workdir.branch,
      ...(dispatch && { action: dispatch.action, clientPayload: dispatch.clientPayload }),
    });
    if (!quiet) logger.info(pc.green(`Run started: ${runId}`));

    const outcome = await followRun(plane.url, plane.adminToken, runId, {
      quiet,
      onLine: (line) => process.stdout.write(line + '\n'),
    });

    if (!quiet) {
      const result: RunResult = {
        fixtureId: options.event,
        runId,
        status: outcome.status === 'success' ? 'success' : 'failed',
        totalDurationMs: 0,
        jobs: outcome.jobs,
      };
      process.stdout.write('\n' + formatSummary(result) + '\n');
    }
    return outcome.status === 'success';
  } catch (error) {
    logger.error(pc.red(`\nError: ${toErrorMessage(error)}\n`));
    if (options.debug && error instanceof Error && error.stack) logger.error(pc.gray(error.stack));
    return false;
  } finally {
    // Restore in reverse order (in-place label injected last → restored first).
    for (const restore of restoreLocks.reverse()) {
      try {
        restore();
      } catch {
        /* best-effort: an isolated clone is removed by cleanup anyway */
      }
    }
    if (cleanup) await cleanup().catch(() => undefined);
  }
}
