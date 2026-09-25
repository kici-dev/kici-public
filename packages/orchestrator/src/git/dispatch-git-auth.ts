/**
 * The clone auth a job dispatch carries to its agent.
 *
 * A job clones the repository its event came from (the source repository) and,
 * for a global workflow, also the repository that defines the workflow. Each
 * clone gets auth minted for that repository by the provider bundle that owns
 * it: installation tokens can be scoped per repository, so the source
 * repository's token cannot be assumed to read the workflow repository.
 */
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { ProviderGitAuth } from '@kici-dev/engine';
import type { ProviderBundle, ProviderRegistry } from '../provider-registry.js';
import { cloneTokenGitAuth } from './clone-token-auth.js';

const logger = createLogger({ prefix: 'dispatch-git-auth' });

/** Auth the dispatch message carries; every field is optional on the wire. */
export interface DispatchCloneAuth {
  /** Bare source-repository token, kept for agents that read only `token`. */
  token?: string;
  sourceAuth?: ProviderGitAuth;
  workflowAuth?: ProviderGitAuth;
}

/**
 * Mint structured auth (and a bare token when it is basic auth) for one
 * repository through one bundle. Providers that implement `issueGitAuth()`
 * return the auth kind directly; otherwise a clone token is wrapped in a
 * basic-auth envelope.
 */
export async function mintRepoGitAuth(
  bundle: ProviderBundle,
  repoIdentifier: string,
  providerContext: unknown,
): Promise<{ token: string | null; structuredAuth: ProviderGitAuth | null }> {
  const provider = bundle.cloneTokenProvider;
  let structuredAuth: ProviderGitAuth | null = null;
  if (provider?.issueGitAuth) {
    structuredAuth = await provider.issueGitAuth(repoIdentifier, providerContext);
  }
  let token: string | null = null;
  if (structuredAuth?.kind === 'basic') {
    token = structuredAuth.secret;
  } else if (!structuredAuth && provider?.createCloneToken) {
    token = await provider.createCloneToken(repoIdentifier, providerContext);
    if (token) structuredAuth = cloneTokenGitAuth(token);
  }
  return { token, structuredAuth };
}

/** The job fields the auth resolution reads. */
export interface DispatchAuthJob {
  id: string;
  repoUrl: string;
  routingKey: string;
  providerContext: unknown;
  jobConfig: Record<string, unknown>;
}

/**
 * Auth for the workflow repository of a global job, minted by the bundle of
 * the job's `workflowRoutingKey` (the job's own routing key when the job
 * predates that field) with the registration's provider context. `null` when
 * the job is not global, names no workflow repository, or the mint fails.
 */
async function mintWorkflowRepoAuth(
  providerRegistry: ProviderRegistry,
  job: DispatchAuthJob,
): Promise<ProviderGitAuth | null> {
  const cfg = job.jobConfig;
  const workflowRepoIdentifier = cfg.workflowRepoIdentifier;
  if (cfg.isGlobalWorkflow !== true || typeof workflowRepoIdentifier !== 'string') return null;
  const workflowRoutingKey =
    typeof cfg.workflowRoutingKey === 'string' ? cfg.workflowRoutingKey : job.routingKey;
  const workflowBundle = providerRegistry.getByRoutingKey(workflowRoutingKey);
  if (!workflowBundle) {
    logger.error('Global workflow: no bundle registered for the workflow routing key', {
      workflowRoutingKey,
      jobId: job.id,
    });
    return null;
  }
  const providerContext = cfg.workflowProviderContext ?? job.providerContext;
  try {
    const { structuredAuth } = await mintRepoGitAuth(
      workflowBundle,
      workflowRepoIdentifier,
      providerContext,
    );
    return structuredAuth;
  } catch (err) {
    logger.warn('Failed to mint workflowAuth for a global workflow', {
      workflowRoutingKey,
      workflowRepo: workflowRepoIdentifier,
      jobId: job.id,
      error: toErrorMessage(err),
    });
    return null;
  }
}

/** A URL with an explicit scheme (`https://`, `ssh://`, `file://`, …). */
const SCHEME_URL = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * The scp-style `[user@]host:path` form: git reads a clone location as this
 * form when a colon comes before the first slash.
 */
const SCP_LIKE = /^(?:[^@/:]+@)?([^/:]+):/;

/**
 * The git host of a clone URL: the URL host, or the host of an scp-style
 * `[user@]host:path` remote. `undefined` when neither form parses.
 */
export function gitHostOf(url: string): string | undefined {
  if (!SCHEME_URL.test(url)) {
    // fails-when: a userless `github.com:org/repo.git` is parsed as a URL with scheme `github.com:` and no host
    // breaks-if-wrong: `git@github.com:org/repo.git` must still yield github.com
    // Lowercased as the URL parser lowercases a host, so the two forms compare.
    // fails-when: `git@GitHub.com:x` and `https://github.com/y` read as two hosts
    const scp = SCP_LIKE.exec(url);
    if (scp) return scp[1].toLowerCase();
  }
  try {
    // Lowercased too: the URL parser leaves a non-special scheme's host as written.
    // fails-when: `ssh://git@GitHub.com/x` and `git@github.com:y` read as two hosts
    return new URL(url).host.toLowerCase();
  } catch {
    return undefined;
  }
}

/** A scheme-less filesystem path: absolute, or explicitly relative. */
const FILESYSTEM_PATH = /^(?:\/|\.\.?\/|~\/)/;

/**
 * Whether a clone location reaches no git host: a `file:` URL (git reads its
 * path locally whatever host it names) or a scheme-less absolute or explicitly
 * relative filesystem path. Anything else — an scp-style `host:path`, a
 * network URL, an unrecognised string — is treated as reaching a host.
 */
function isHostlessCloneUrl(url: string): boolean {
  // fails-when: an scp-style `host:path` is read as a local path
  // breaks-if-wrong: `/srv/repo.git` and `file:///srv/repo.git` must still read as local
  return /^file:/i.test(url) || FILESYSTEM_PATH.test(url);
}

/**
 * Why a global job must not be dispatched with this auth, or `undefined` when
 * it may.
 *
 * The agent falls back across the two clones: it clones the source repository
 * with `sourceAuth ?? workflowAuth ?? token` and the workflow repository with
 * `workflowAuth ?? sourceAuth ?? token`. When only one repository's credential is
 * present, the other clone sends it to that repository's host. On the same host
 * that is a credential the host issued; on another host it hands one provider's
 * credential to another, so the job is refused instead. A job with no source URL
 * clones nothing from a host, and neither does a `file:` clone, so pairing one
 * credential with a local repository is never refused.
 */
export function crossHostAuthRefusal(
  jobConfig: Record<string, unknown>,
  repoUrl: string,
  auth: DispatchCloneAuth,
): string | undefined {
  if (jobConfig.isGlobalWorkflow !== true || !repoUrl) return undefined;
  const hasSource = !!(auth.sourceAuth || auth.token);
  const hasWorkflow = !!auth.workflowAuth;
  // Both present: each clone uses its own. Neither present: nothing can leak.
  if (hasSource === hasWorkflow) return undefined;
  const workflowRepoUrl =
    typeof jobConfig.workflowRepoUrl === 'string' ? jobConfig.workflowRepoUrl : '';
  // fails-when: a local repository is read as a host the credential could reach
  // breaks-if-wrong: two networked repositories on different hosts must still be refused
  if (isHostlessCloneUrl(repoUrl) || isHostlessCloneUrl(workflowRepoUrl)) return undefined;
  const sourceHost = gitHostOf(repoUrl);
  const workflowHost = gitHostOf(workflowRepoUrl);
  // fails-when: the two repositories resolve to different hosts, or a host cannot be parsed
  // breaks-if-wrong: two repositories on one host must still dispatch with the one credential
  if (sourceHost !== undefined && sourceHost === workflowHost) return undefined;
  const workflowRepo = String(jobConfig.workflowRepoIdentifier ?? workflowRepoUrl);
  const sourceRepo = `the source repository ${repoUrl}`;
  const workflowRepoLabel = `the workflow repository ${workflowRepo}`;
  const [missing, present] = hasWorkflow
    ? [sourceRepo, workflowRepoLabel]
    : [workflowRepoLabel, sourceRepo];
  return (
    `Refusing to dispatch the global workflow job: no clone credentials could be minted ` +
    `for ${missing}, and ${present} is on another git host, so its credentials must not ` +
    `be used for the other clone`
  );
}

/**
 * Resolve the clone auth of one dispatch: the source repository's through the
 * job's bundle, and for a global job the workflow repository's through its own
 * bundle. Returns a refusal message when the job must not be dispatched.
 */
export async function resolveDispatchCloneAuth(args: {
  providerRegistry: ProviderRegistry;
  /** The bundle of the job's routing key; undefined for an overlay (local) run. */
  bundle: ProviderBundle | undefined;
  repoIdentifier: string;
  job: DispatchAuthJob;
}): Promise<{ auth: DispatchCloneAuth } | { refused: string }> {
  const { bundle, repoIdentifier, job } = args;
  const auth: DispatchCloneAuth = {};
  if (bundle) {
    try {
      const { token, structuredAuth } = await mintRepoGitAuth(
        bundle,
        repoIdentifier,
        job.providerContext,
      );
      if (token) auth.token = token;
      if (structuredAuth) auth.sourceAuth = structuredAuth;
    } catch (err) {
      logger.warn('Failed to generate clone token, agent will attempt unauthenticated clone', {
        jobId: job.id,
        error: toErrorMessage(err),
      });
    }
  }
  const workflowAuth = await mintWorkflowRepoAuth(args.providerRegistry, job);
  if (workflowAuth) auth.workflowAuth = workflowAuth;
  const refused = crossHostAuthRefusal(job.jobConfig, job.repoUrl, auth);
  return refused ? { refused } : { auth };
}
