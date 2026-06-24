/**
 * CLI-secret overlay for `kici run` test dispatch.
 *
 * Wraps the orchestrator's environment `SecretResolver` and overlays the
 * developer's CLI-uploaded local secrets on top of the env-resolved secrets,
 * with CLI winning on collision. Passed to the shared dispatch core via
 * `ProcessingDeps.secretResolver`, so the core's secret-resolution path is
 * unchanged and oblivious to "test secrets".
 *
 * Precedence: env-resolved secrets → CLI context for the requested environment
 * → CLI flat. The CLI flat overlay is applied last so a CLI flat key always
 * wins.
 */

import type { SecretResolverApi, ResolvedSecretMeta } from '../secrets/secret-resolver.js';

/** Decrypted CLI-uploaded local secrets: flat keys + per-context namespaces. */
export interface CliSecrets {
  flat: Record<string, string>;
  contexts: Record<string, Record<string, string>>;
}

export class DecoratingSecretResolver implements SecretResolverApi {
  constructor(
    private readonly base: SecretResolverApi,
    private readonly cli: CliSecrets,
  ) {}

  async resolveForJob(orgId: string, environmentName: string): Promise<Record<string, string>> {
    const envSecrets = await this.base.resolveForJob(orgId, environmentName);
    return {
      ...envSecrets,
      ...(this.cli.contexts[environmentName] ?? {}),
      ...this.cli.flat,
    };
  }

  resolveNamed(
    orgId: string,
    scope: string,
    key: string,
    opts?: { store?: string; runId?: string; jobId?: string },
  ): Promise<string | null> {
    return this.base.resolveNamed(orgId, scope, key, opts);
  }

  resolveForJobWithMeta(
    orgId: string,
    environmentName: string,
  ): Promise<Record<string, ResolvedSecretMeta>> {
    return this.base.resolveForJobWithMeta(orgId, environmentName);
  }
}
