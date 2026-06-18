/**
 * Cross-peer propagation of generic-webhook-source registration changes.
 *
 * Sister to the GitHub-app `SourceManager`
 * (`packages/orchestrator/src/sources/source-manager.ts`), which owns the
 * `sources_change` channel. This listener owns `generic_sources_change`
 * — the channel the migration-019 trigger emits on every INSERT, UPDATE,
 * or DELETE of a `generic_webhook_sources` row.
 *
 * On NOTIFY:
 *   1. Queue the affected `routing_key` (the channel payload).
 *   2. Debounce 200 ms so rapid edits coalesce into one drain pass.
 *   3. For each queued routing_key:
 *        - Re-query `GenericSourceManager.getByRoutingKey()`. The query
 *          already filters out soft-deleted (`deleted_at IS NOT NULL`)
 *          and disabled (`enabled = false`) rows.
 *        - If the row is gone (DELETE, soft-delete, or disable):
 *          `providerRegistry.unregister(routingKey)`.
 *        - Otherwise: `registerProviderBundleForSource(row, deps)`
 *          (idempotent — a second call replaces the prior bundle).
 *
 * The listener does NOT own the `ProviderRegistry` — it mutates the
 * shared instance the rest of the orchestrator dispatches against. This
 * differs from `SourceManager`, which rebuilds a fresh registry on
 * every reload and asks the caller to swap the reference. The reason is
 * shared ownership: the GitHub-app and generic-webhook sources both
 * populate the same `ProviderRegistry` instance, so a wholesale rebuild
 * by one of them would clobber the other's bundles.
 *
 * The admin POST/PATCH/DELETE handlers in `routes/admin-events.ts` ALSO
 * mutate the registry inline so the API response is self-consistent on
 * the issuing peer (a webhook fired immediately after a 200 OK sees the
 * change without waiting for the NOTIFY round-trip). The local NOTIFY
 * fires too — `registerByRoutingKey` is idempotent, so the redundant
 * apply is harmless.
 */

import type pg from 'pg';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { GenericSourceManager } from './generic-sources.js';
import type { ProviderRegistry } from '../provider-registry.js';
import type { AppConfig } from '../config.js';
import type { SecretResolver } from '../secrets/secret-resolver.js';
import { registerProviderBundleForSource } from './register-source-bundle.js';

const logger = createLogger({ prefix: 'generic-sources-listener' });

export interface GenericSourcesChangeListenerOptions {
  /** Raw pg pool — a dedicated PoolClient is checked out for LISTEN. */
  pool: pg.Pool;
  /** Used to re-query the affected row by routing_key on each NOTIFY. */
  sourceManager: GenericSourceManager;
  /** Mutated in place — registerByRoutingKey / unregister. */
  providerRegistry: ProviderRegistry;
  /** Gates internal-provider bundle registration in the helper. */
  config: AppConfig;
  /** Required for universal-git source rows; null is acceptable on
   *  peers that cannot serve them. */
  secretResolver: SecretResolver | null;
  /** Active scaler backend on this peer. Threaded into the warm-path
   *  registration so a local source added at runtime on a container /
   *  firecracker scaler emits the same reachability warning as a cold-boot one. */
  scalerBackendType?: string;
  /** Coalesce window for rapid NOTIFYs against the same row. Default 200 ms. */
  debounceMs?: number;
  /**
   * Invoked once per drain pass that applied at least one change. The
   * platform-mode boot wires this to re-push the full source list to the
   * Platform (`platformClient.updateSources()`) so a generic source added /
   * removed at runtime reaches the Platform's `webhook_sources` immediately,
   * not just the local registry.
   */
  onChange?: () => void;
}

export class GenericSourcesChangeListener {
  private client: pg.PoolClient | null = null;
  private readonly pending = new Set<string>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly debounceMs: number;
  /**
   * Drain-applied-change callback. Mutable so the platform-mode boot can wire
   * it after the Platform client exists (this listener is constructed before).
   */
  private onChange?: () => void;

  constructor(private readonly opts: GenericSourcesChangeListenerOptions) {
    this.debounceMs = opts.debounceMs ?? 200;
    this.onChange = opts.onChange;
  }

  /** Replace the drain-applied-change callback after construction. */
  setOnChange(cb: () => void): void {
    this.onChange = cb;
  }

  /** Open the dedicated client and subscribe. Cold-boot bundle
   *  registration is handled by the orchestrator-core startup loop
   *  via the same helper; this listener only services warm-path
   *  NOTIFYs. */
  async start(): Promise<void> {
    this.client = await this.opts.pool.connect();
    this.client.on('notification', (msg) => {
      if (msg.channel !== 'generic_sources_change') return;
      const routingKey = msg.payload ?? '';
      if (!routingKey) {
        logger.warn('generic_sources_change NOTIFY missing payload');
        return;
      }
      this.pending.add(routingKey);
      this.scheduleDrain();
    });
    await this.client.query('LISTEN generic_sources_change');
    logger.info(`Listening for generic-source changes (debounce: ${this.debounceMs}ms)`);
  }

  async stop(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.client) {
      try {
        await this.client.query('UNLISTEN generic_sources_change');
      } catch {
        // Connection may already be closed during shutdown.
      }
      this.client.release();
      this.client = null;
    }
  }

  private scheduleDrain(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.drain().catch((err) => {
        logger.error('Failed to drain generic-source change queue', {
          error: toErrorMessage(err),
        });
      });
    }, this.debounceMs);
  }

  /** Visible for tests — drain the queued routing_keys synchronously. */
  async drain(): Promise<void> {
    const keys = Array.from(this.pending);
    this.pending.clear();
    let appliedChange = false;
    for (const routingKey of keys) {
      try {
        const row = await this.opts.sourceManager.getByRoutingKey(routingKey);
        if (!row) {
          const removed = this.opts.providerRegistry.unregister(routingKey);
          logger.info('Unregistered provider bundle for generic source', {
            routingKey,
            removed,
          });
          appliedChange = true;
          continue;
        }
        // Clear any prior per-routing-key bundle before re-registering,
        // so a provider-type change `local` → `generic` (or
        // `universal-git` → `generic`) wipes the stale specialised bundle
        // instead of leaving it shadowing the new no-op shape.
        this.opts.providerRegistry.unregister(routingKey);
        registerProviderBundleForSource(row, {
          providerRegistry: this.opts.providerRegistry,
          config: this.opts.config,
          secretResolver: this.opts.secretResolver,
          scalerBackendType: this.opts.scalerBackendType,
        });
        appliedChange = true;
      } catch (err) {
        logger.error('Failed to apply generic-source change', {
          routingKey,
          error: toErrorMessage(err),
        });
      }
    }
    if (appliedChange) {
      this.onChange?.();
    }
  }
}
