/**
 * The warning `kici-admin context create` and `kici-admin secret set` print
 * when a context's secrets cannot reach any job.
 *
 * A job that lists a context in its `contexts:` receives the context's
 * secrets only through the context's scope bindings: the secret resolver reads
 * the bindings of the context row the job's declared name matched — a fixed
 * context by its exact name, a glob context by its pattern — and returns
 * nothing when there are none. So such a context with no binding delivers no
 * secret to those jobs, whatever its scopes hold, and nothing fails loudly — a
 * workflow's `ctx.secrets.get()` throws at run time instead. A
 * `<context>:<key>` git-credential or registry reference to a fixed context
 * still reads the scope named after it, through a deprecated fallback; a glob
 * context has no such fallback. The warning names the context, that fallback
 * where it applies, and the `context bind` command that fixes it.
 *
 * Advisory only: the lookup runs after the command's own write succeeded, and
 * a failed lookup prints nothing, so the command's exit code never changes.
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

/** The warning line for a context of `type` with no binding. */
export function unboundContextWarning(orgId: string, name: string, type: ContextType): string {
  // fails-when: a glob context's warning promises a same-named-scope fallback it does not have
  // breaks-if-wrong: a fixed context's warning must name the deprecated fallback its references take
  const fallback =
    type === ContextType.enum.fixed
      ? `A '${name}:<key>' reference still reads scope '${name}', through a deprecated fallback. `
      : '';
  return (
    `warning: context '${name}' has no binding, so no job that lists it in contexts: receives its secrets. ` +
    fallback +
    `Bind a secret scope to it: kici-admin context bind --org ${orgId} --env ${name} --scope ${name}`
  );
}

/**
 * The context named `name` with its bindings, or null when no context has that
 * name. The list read comes first, so a name that is not a context (a
 * positional `secret set` scope such as `aws/prod/db`) is answered without a
 * not-found error to tell apart from a real failure.
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
 * Print the unbound-context warning when `name` is a context a job can resolve
 * through (a fixed or glob context, `ContextType`) that has no binding. A
 * template row is a seed for other contexts, not a job context, and stays silent.
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
    (args.warn ?? console.error)(unboundContextWarning(args.orgId, args.name, type.data));
  }
}
