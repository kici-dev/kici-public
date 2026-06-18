import pc from 'picocolors';
import { DashboardClient, DashboardClientError } from '../remote/dashboard-client.js';
import type { EnvironmentContext } from '../remote/dashboard-client.js';
import { toErrorMessage } from '@kici-dev/core';

export interface SecretsListOptions {
  /** Reserved for future use; the command targets the Platform via the active org. */
  endpoint?: string;
}

/**
 * List test-available secret contexts through the Platform.
 *
 * Calls GET /api/v1/orgs/:orgId/environments?includeSecrets=true (relayed to
 * the org's orchestrator), filters to environments with
 * allowLocalExecution=true, and displays a table of names, key names, and
 * flags. Values are never exposed -- only key names.
 */
export async function secretsListCommand(_options: SecretsListOptions = {}): Promise<boolean> {
  try {
    const client = await DashboardClient.load();
    const environments = await client.listEnvironments(true);
    const contexts = environments.filter((e) => e.allowLocalExecution);

    if (contexts.length === 0) {
      console.log(pc.yellow('No test-available secret contexts found.'));
      console.log(
        pc.gray(
          'Enable test runs (allowLocalExecution) on an environment to make its secrets available for test runs.',
        ),
      );
      return true;
    }

    renderContextTable(contexts);
    return true;
  } catch (err: unknown) {
    if (err instanceof DashboardClientError) {
      console.error(pc.red(err.message));
      return false;
    }
    console.error(pc.red(`Failed to list secrets: ${toErrorMessage(err)}`));
    return false;
  }
}

/** Render the secret-context table to stdout. */
function renderContextTable(contexts: EnvironmentContext[]): void {
  console.log(pc.bold('\nTest-available secret contexts:\n'));

  const ctxKeys = (c: EnvironmentContext): string[] => c.secretKeys ?? [];

  const nameWidth = Math.max('Context'.length, ...contexts.map((c) => c.name.length));
  const keysWidth = Math.max(
    'Keys'.length,
    ...contexts.map((c) => {
      const k = ctxKeys(c);
      return k.length > 0 ? k.join(', ').length : 4;
    }),
  );
  const flagsWidth = Math.max(
    'Flags'.length,
    ...contexts.map((c) => (c.enabled ? 0 : 'disabled'.length)),
  );

  const pad = (s: string, w: number) => s.padEnd(w);
  const hr = (w: number) => '─'.repeat(w);

  console.log(`┌${hr(nameWidth + 2)}┬${hr(keysWidth + 2)}┬${hr(flagsWidth + 2)}┐`);
  console.log(
    `│ ${pad('Context', nameWidth)} │ ${pad('Keys', keysWidth)} │ ${pad('Flags', flagsWidth)} │`,
  );
  console.log(`├${hr(nameWidth + 2)}┼${hr(keysWidth + 2)}┼${hr(flagsWidth + 2)}┤`);

  for (const ctx of contexts) {
    const k = ctxKeys(ctx);
    const keys = k.length > 0 ? k.join(', ') : pc.gray('none');
    const keysRaw = k.length > 0 ? k.join(', ') : 'none';
    const flagStr = ctx.enabled ? '' : 'disabled';

    console.log(
      `│ ${pad(ctx.name, nameWidth)} │ ${keys}${' '.repeat(Math.max(0, keysWidth - keysRaw.length))} │ ${pad(flagStr, flagsWidth)} │`,
    );
  }

  console.log(`└${hr(nameWidth + 2)}┴${hr(keysWidth + 2)}┴${hr(flagsWidth + 2)}┘`);
  console.log('');
}
