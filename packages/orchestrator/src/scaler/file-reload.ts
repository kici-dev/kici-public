/**
 * The one scaler config reload: re-read the scaler file, hand it to the
 * manager (which validates everything before it applies anything), and report
 * what happened.
 *
 * `SIGHUP` (through `ConfigReloader`), the `POST /admin/scaler/reload` route
 * and a peer's `peer.scaler.reload.request` all run this function, so each of
 * them applies a file the same way.
 */
import { toErrorMessage, type Logger } from '@kici-dev/shared';
import { ScalerReloadOutcome, type ScalerReloadAnswer } from '@kici-dev/engine';
import { scalerConfigReloadsTotal } from '../metrics/prometheus.js';
import type { ScalerManager, ScalerReloadResult } from './manager.js';
import type { ScalerConfig } from './types.js';
import { ConfigReloader } from '../config/reload.js';

export interface ScalerFileReloadDeps {
  /** Null when the orchestrator runs without a scaler config. */
  manager: Pick<ScalerManager, 'reload'> | null;
  /** Re-reads the scaler config from disk; throws on a missing or invalid file. */
  load: () => Promise<ScalerConfig>;
  /** Runs after a reload applied (the dashboard diagnostics snapshot). */
  onApplied?: (config: ScalerConfig) => void;
  logger: Logger;
}

/**
 * One orchestrator's scaler reload outcome: `applied` with its plan, `rejected`
 * with its errors (nothing applied), or `not-configured`.
 */
export type ScalerFileReloadResult = ScalerReloadAnswer;

/** Runs one scaler file reload; see `createScalerFileReload`. */
export type ScalerFileReload = () => Promise<ScalerFileReloadResult>;

/**
 * Build the reload function. Calls run one after the other: a reload that
 * arrives while another runs (a `SIGHUP` during an HTTP reload) waits, then
 * reads the file again, and each caller gets the outcome of its own run.
 */
export function createScalerFileReload(deps: ScalerFileReloadDeps): ScalerFileReload {
  let tail: Promise<unknown> = Promise.resolve();
  return () => {
    const run = tail.then(() => reloadOnce(deps));
    tail = run.catch(() => undefined);
    return run;
  };
}

async function reloadOnce(deps: ScalerFileReloadDeps): Promise<ScalerFileReloadResult> {
  const { manager, logger } = deps;
  if (!manager) return { outcome: ScalerReloadOutcome.enum['not-configured'] };

  scalerConfigReloadsTotal.add(1, { result: 'attempted' });
  let config: ScalerConfig;
  let result: ScalerReloadResult;
  try {
    config = await deps.load();
    result = await manager.reload(config);
  } catch (err) {
    const error = toErrorMessage(err);
    logger.error('Scaler config reload error', { error });
    scalerConfigReloadsTotal.add(1, { result: 'failed' });
    return { outcome: ScalerReloadOutcome.enum.rejected, errors: [error] };
  }

  if (!result.valid) {
    logger.error('Config reload validation failed, keeping current config', {
      errors: result.errors,
    });
    scalerConfigReloadsTotal.add(1, { result: 'failed' });
    return { outcome: ScalerReloadOutcome.enum.rejected, errors: result.errors };
  }

  // The dashboard diagnostics snapshot renders its scaler list from the stored
  // config, not from the manager, so leaving it at the boot-time value makes
  // the panel hide a scaler the reload just added and keep showing one it
  // removed.
  deps.onApplied?.(config);
  logger.info('Scaler configuration reloaded successfully', { plan: result.plan });
  scalerConfigReloadsTotal.add(1, { result: 'success' });
  return { outcome: ScalerReloadOutcome.enum.applied, plan: result.plan };
}

/** The part of `process` the signal listener needs, injectable for tests. */
export interface SignalSource {
  on(signal: 'SIGHUP', listener: () => void): unknown;
  off(signal: 'SIGHUP', listener: () => void): unknown;
}

/**
 * Run `reload` on `SIGHUP`, debounced like the coordinator's `ConfigReloader`
 * so a burst of signals reloads once. A Node.js process with no `SIGHUP`
 * listener exits on the signal, so a host that reloads only its scaler config
 * (a worker) installs this one. Returns the disposer that removes the listener.
 */
export function installScalerReloadSignal(
  reload: ScalerFileReload,
  logger: Logger,
  signals: SignalSource = process,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const onSignal = (): void => {
    logger.info('SIGHUP received, reloading the scaler config');
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      reload().catch((err: unknown) => {
        logger.error('Scaler config reload error', { error: toErrorMessage(err) });
      });
    }, ConfigReloader.DEBOUNCE_MS);
  };
  signals.on('SIGHUP', onSignal);
  return () => {
    if (timer) clearTimeout(timer);
    timer = null;
    signals.off('SIGHUP', onSignal);
  };
}
