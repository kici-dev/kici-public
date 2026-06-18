/**
 * Universal-git changed-files fetcher.
 *
 * Implements the `ChangedFilesFetcher` interface from `@kici-dev/engine` for
 * universal-git sources. Unlike the GitHub fetcher, this implementation does
 * not make REST API calls — every supported forge (Forgejo, Gitea, Gogs,
 * GitLab repo webhook, plain GitHub repo webhook) already includes the full
 * `commits[].{added,modified,removed}` arrays in the push payload, so we
 * extract them via JSONPath from the already-delivered webhook body.
 *
 * For PR events we return an empty list: the upstream trigger matcher treats
 * empty changed-files as "match any path", which is the safest default when
 * we don't have per-PR diff data. A follow-up can add an optional REST
 * fetcher if source authors want PR path filtering.
 */

import type { ChangedFilesFetcher } from '@kici-dev/engine';
import { JSONPath } from 'jsonpath-plus';
import {
  expandUniversalGitConfig,
  type UniversalGitConfig,
  type UniversalGitPayloadPaths,
  type EventMapping,
} from './config.js';

/** Dedupe + filter to non-empty string paths. */
function collectStrings(values: unknown[]): string[] {
  const out = new Set<string>();
  for (const v of values) {
    if (typeof v === 'string' && v.length > 0) out.add(v);
  }
  return [...out];
}

/**
 * Universal-git implementation of ChangedFilesFetcher.
 *
 * One instance per universal-git source, configured with the source's
 * expanded `payloadPaths` + `eventMapping`.
 */
export class UniversalGitChangedFilesFetcher implements ChangedFilesFetcher {
  readonly provider = 'generic' as const;

  private readonly paths: UniversalGitPayloadPaths;
  private readonly eventMapping: EventMapping;

  constructor(params: { config: UniversalGitConfig }) {
    const expanded = expandUniversalGitConfig(params.config);
    this.paths = expanded.payloadPaths;
    this.eventMapping = expanded.eventMapping;
  }

  /**
   * Extract changed files from the webhook payload.
   *
   * @param _repoIdentifier Unused — all data is in `payload`.
   * @param eventType       Raw header event type (pre-mapping).
   * @param payload         The webhook body the forge delivered.
   * @param _credentials    Unused — no REST call is made.
   */
  async getChangedFiles(
    _repoIdentifier: string,
    eventType: string,
    payload: unknown,
    _credentials: unknown,
  ): Promise<string[]> {
    const kind = this.classifyEvent(eventType);
    if (kind !== 'push') {
      // PR events: no per-commit diff available in the webhook body; upstream
      // trigger logic treats empty changed-files as "match any path", which
      // is the intended semantics for universal-git v1.
      return [];
    }

    const p = (payload as Record<string, unknown>) ?? {};
    const added = JSONPath({ path: this.paths.commitsAdded, json: p, wrap: true }) as unknown[];
    const modified = JSONPath({
      path: this.paths.commitsModified,
      json: p,
      wrap: true,
    }) as unknown[];
    const removed = JSONPath({
      path: this.paths.commitsRemoved,
      json: p,
      wrap: true,
    }) as unknown[];

    return collectStrings([...added, ...modified, ...removed]);
  }

  private classifyEvent(eventType: string): 'push' | 'pull_request' | null {
    if (this.eventMapping.push.includes(eventType)) return 'push';
    if (this.eventMapping.pullRequest.includes(eventType)) return 'pull_request';
    return null;
  }
}
