/**
 * CLI-secret overlay for `kici run` test dispatch.
 *
 * Wraps the context `SecretResolver` and overlays the developer's CLI-uploaded
 * secrets, passed as `ProcessingDeps.secretResolver` so the dispatch core stays
 * oblivious to test secrets.
 *
 * Precedence, lowest first: env-resolved → CLI context → CLI flat.
 */

import type { HostFacts } from '@kici-dev/engine';
import type {
  MatchedContextRef,
  ResolvedSecretMeta,
  SecretResolutionAttribution,
  SecretResolverApi,
} from '../secrets/secret-resolver.js';

/** Decrypted CLI-uploaded local secrets: flat keys + per-context namespaces. */
export interface CliSecrets {
  flat: Record<string, string>;
  contexts: Record<string, Record<string, string>>;
}

export class DecoratingSecretResolver implements SecretResolverApi {
  /** The wrapped resolver's binding count, when it offers one. */
  readonly countContextBindings?: (contextId: string) => Promise<number>;

  constructor(
    private readonly base: SecretResolverApi,
    private readonly cli: CliSecrets,
  ) {
    this.countContextBindings = base.countContextBindings?.bind(base);
  }

  async resolveForContext(
    orgId: string,
    context: MatchedContextRef,
    hostCtx?: HostFacts,
    attribution?: SecretResolutionAttribution,
  ): Promise<Record<string, string>> {
    // Dropping hostCtx would silently widen a per-host resolution to fleet-wide.
    const envSecrets = await this.base.resolveForContext(orgId, context, hostCtx, attribution);
    // The CLI overlay is keyed by the name the job declared, not the matched row.
    return {
      ...envSecrets,
      ...(this.cli.contexts[context.name] ?? {}),
      ...this.cli.flat,
    };
  }

  resolveNamedInternal(
    orgId: string,
    scope: string,
    key: string,
    opts?: { store?: string; runId?: string; jobId?: string },
  ): Promise<string | null> {
    return this.base.resolveNamedInternal(orgId, scope, key, opts);
  }

  resolveForContextWithMeta(
    orgId: string,
    context: MatchedContextRef,
    hostCtx?: HostFacts,
  ): Promise<Record<string, ResolvedSecretMeta>> {
    // Forward hostCtx for the same per-host-scoping reason as resolveForContext.
    return this.base.resolveForContextWithMeta(orgId, context, hostCtx);
  }
}
