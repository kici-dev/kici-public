/**
 * The warning `context create` and `secret set` print when a context's secrets
 * reach no job. A job listing a context in `contexts:` gets its secrets only
 * through the scope bindings of the matched context row (fixed by exact name,
 * glob by pattern). With no binding it gets none, silently, and
 * `ctx.secrets.get()` throws at run time; a `<context>:<key>` git-credential or
 * registry reference resolves through the same bindings and finds nothing too.
 *
 * Advisory only: it runs after the command's write succeeded, and a failed
 * lookup prints nothing, so the exit code never changes.
 */
import { ContextType } from '@kici-dev/engine';
import { listContextsDirect, showContextDirect } from '@kici-dev/shared';
import type { ContextRow, ShowContextResult } from '@kici-dev/shared';

/** The one admin API call the lookup needs, so any client shape satisfies it. */
export interface ContextLookupClient {
  get<T>(path: string): Promise<T>;
}

export interface WarnIfContextUnboundArgs {
  orgId: string;
  /** The context name; for `secret set` this is the scope the secret was written to. */
  name: string;
  /** Direct-DB mode when set; otherwise the admin API through `client`. */
  dbUrl: string | null;
  client?: ContextLookupClient;
  /** Where the warning goes; stderr by default. */
  warn?: (line: string) => void;
}

export function unboundContextWarning(orgId: string, name: string): string {
  return (
    `warning: context '${name}' has no binding, so no job that lists it in contexts: receives its secrets, ` +
    `and a '${name}:<key>' reference resolves nothing. ` +
    `Bind a secret scope to it: kici-admin context bind --org ${orgId} --env ${name} --scope ${name}`
  );
}

/**
 * The context with its bindings, or null. Listing first answers a non-context
 * name (a `secret set` scope such as `aws/prod/db`) without a not-found error
 * that would need telling apart from a real failure.
 */
async function lookupContext(args: WarnIfContextUnboundArgs): Promise<ShowContextResult | null> {
  const { orgId, name, dbUrl, client } = args;
  if (dbUrl) {
    const { contexts } = await listContextsDirect(dbUrl, { orgId });
    if (!contexts.some((c) => c.name === name)) return null;
    return showContextDirect(dbUrl, { orgId, name });
  }
  if (!client) return null;
  const org = encodeURIComponent(orgId);
  const { contexts } = await client.get<{ contexts: ContextRow[] }>(
    `/api/v1/admin/contexts?orgId=${org}`,
  );
  if (!contexts.some((c) => c.name === name)) return null;
  return client.get<ShowContextResult>(
    `/api/v1/admin/contexts/${encodeURIComponent(name)}?orgId=${org}`,
  );
}

/**
 * Warns for a fixed or glob context (`ContextType`) with no binding. A template
 * row seeds other contexts, is no job context, and stays silent.
 */
export async function warnIfContextUnbound(args: WarnIfContextUnboundArgs): Promise<void> {
  let found: ShowContextResult | null;
  try {
    found = await lookupContext(args);
  } catch {
    // The write already succeeded; an unreadable context list (a token scoped
    // away from /contexts, an unreachable DB) leaves nothing to warn about.
    return;
  }
  // fails-when: a fixed or glob context with zero bindings, whose secrets reach no job, prints nothing
  // breaks-if-wrong: a bound context, a template, or a name that is no context must stay silent
  const type = found ? ContextType.safeParse(found.context.type) : undefined;
  if (found && type?.success && found.bindings.length === 0) {
    (args.warn ?? console.error)(unboundContextWarning(args.orgId, args.name));
  }
}
