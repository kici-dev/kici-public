/**
 * `kici run --local [event]` — a real routed dispatch with this machine as the
 * ephemeral agent, through the warm local dev plane (offline or
 * Platform-attached, per `resolvePlaneForRun`). It reuses the real orchestrator
 * + agent pipeline, so execution parity (emit / cache / needs / parallel /
 * `KICI_SOURCE_*`) holds by construction: there is no second engine.
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
import { planeLogPath } from '../local-plane/plane-manager.js';
import { readParentSha, resolveWorkdir } from '../local-plane/source-provider.js';
import { ensureLocalSource } from '../local-plane/plane-seed.js';
import { seedLocalSecrets } from '../local-plane/secret-seed.js';
import { triggerRun } from '../local-plane/plane-trigger.js';
import { TRUSTED_ROUTING_LABEL, IN_PLACE_ROUTING_LABEL } from '../local-plane/scaler-config.js';
import { injectRunsOnLabel } from '../local-plane/trusted-routing.js';
import { followRun } from '../local-plane/run-follow.js';
import { detectOsMismatchHints } from '../local-plane/os-mismatch-hint.js';
import { formatSummary, type RunResult } from '../remote/output/summary.js';

export interface RunRoutedOptions {
  event?: string;
  local?: boolean;
  offline?: boolean;
  connected?: boolean;
  inPlace?: boolean;
  /**
   * Trusted fleet-agent profile: steps see the ambient host env (minus the
   * agent's KiCI identity secrets). Selects a PRE-CONFIGURED trusted scaler
   * label set by appending the `self-hosted` label to each job's `runsOn`; it
   * never injects `KICI_TRUSTED_ENV` onto a dispatch payload.
   */
  trusted?: boolean;
  /** Flat per-run secrets (`--env KEY=VALUE`); delivery lands with the secret path. */
  env?: string[];
  /**
   * Dispatch payload JSON `{ action?, client_payload? }`, read only for the
   * `dispatch` event: `action` is the `types` matcher key and
   * `client_payload` reaches the workflow.
   */
  payload?: string;
  kiciDir?: string;
  quiet?: boolean;
  debug?: boolean;
}

/** The action-bearing `kici run`. Returns true on run success. */
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

/** An absent `--payload` yields an empty action: a bare `dispatch()` workflow still matches. */
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

async function runRouted(options: RunRoutedOptions & { event: string }): Promise<boolean> {
  const quiet = Boolean(options.quiet);
  const kiciDir = resolveKiciDir(options.kiciDir);
  const repoRoot = path.resolve(kiciDir, '..');

  // An isolated run clones into a temp dir with no root node_modules, as an
  // agent does; an in-place run uses the developer's own node_modules.
  const warnMissingKiciManifest = !options.inPlace;
  // The plane fetches (and the overlay commits) the on-disk lock.
  const compileOk = quiet
    ? await withStdoutOnStderr(() =>
        compileCommand({
          kiciDir,
          check: false,
          verbose: options.debug ?? false,
          quiet: true,
          warnMissingKiciManifest,
        }),
      )
    : await compileCommand({
        kiciDir,
        check: false,
        verbose: options.debug ?? false,
        warnMissingKiciManifest,
      });
  if (!compileOk) return false;

  // The local plane matches only the host's own kici:os:* label.
  if (!quiet) {
    try {
      const os = await import('node:os');
      const lockRaw = readFileSync(path.join(kiciDir, 'kici.lock.json'), 'utf-8');
      const hints = detectOsMismatchHints(JSON.parse(lockRaw), os.platform(), os.arch());
      for (const hint of hints) logger.warn(pc.yellow(hint));
    } catch {
      // An unreadable/partial lock never blocks the run.
    }
  }

  let cleanup: (() => Promise<void>) | undefined;
  const restoreLocks: Array<() => void> = [];
  try {
    if (!quiet) logger.info(pc.dim('Starting the local dev plane…'));
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
    // Paths the isolated checkout leaves out (submodules, dangling symlinks), on
    // stderr so --json keeps stdout parseable.
    for (const warning of workdir.warnings) process.stderr.write(`${pc.yellow(`⚠ ${warning}`)}\n`);

    // Labels go into the workdir lock the plane reads. `--in-place` ALSO adds
    // `in-place` (the agent uses the real working tree, no clone); the
    // restore()s in the finally un-dirty an in-place tree.
    if (trusted) {
      const lockPath = path.join(workdir.dir, '.kici', 'kici.lock.json');
      restoreLocks.push(injectRunsOnLabel(lockPath, TRUSTED_ROUTING_LABEL).restore);
      if (options.inPlace) {
        restoreLocks.push(injectRunsOnLabel(lockPath, IN_PLACE_ROUTING_LABEL).restore);
      }
    }

    const seeded = await ensureLocalSource(plane.url, plane.adminToken, {
      repoDir: workdir.dir,
      // A generic source's routing key embeds the org, so an attached plane
      // must seed under its real Platform org: the `__default__` sentinel would
      // mint a key the Platform rejects (the orchestrator refuses that create).
      // Offline and fallback planes have no Platform org and keep the sentinel.
      ...(resolved.kind === 'attached' && { orgId: resolved.orgId }),
      // In-place: the workdir IS the operator's real tree, so the plane skips
      // the source-pack build and the agent runs it directly.
      inPlace: Boolean(options.inPlace),
    });

    // Local `secrets.yaml` / `.secrets` contexts go into the plane's real
    // scoped-secret store, so a context-bound job resolves through the real
    // resolver. Local secret files stay read-only; values only transit into the
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
    const dispatch =
      options.event === 'dispatch' ? readDispatchPayload(options.payload) : undefined;
    const runId = await triggerRun(
      plane.url,
      plane.adminToken,
      {
        orgId: seeded.orgId,
        // The generic webhook route resolves a source by (customer_id, name),
        // not the routing key's id segment.
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
        // The changed files are the snapshot's own commit, so path filters and
        // `ctx.changedFiles` rules see a real diff.
        before: readParentSha(workdir.dir, workdir.sha),
        defaultBranch: workdir.branch,
        ...(dispatch && { action: dispatch.action, clientPayload: dispatch.clientPayload }),
      },
      // For the timeout diagnosis.
      { repoBasePath: workdir.dir, logPath: planeLogPath() },
    );
    if (!quiet) logger.info(pc.green(`Run started: ${runId}`));

    const outcome = await followRun(plane.url, plane.adminToken, runId, {
      quiet,
      onLine: (line) => process.stdout.write(line + '\n'),
      hintLogPath: planeLogPath(),
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
    // Reverse order: the in-place label was injected last.
    for (const restore of restoreLocks.reverse()) {
      try {
        restore();
      } catch {
        /* an isolated clone is removed by cleanup anyway */
      }
    }
    if (cleanup) await cleanup().catch(() => undefined);
  }
}
