/**
 * `owner/repo` from a clone URL, the form `repo.identifier` documents and the
 * orchestrator's write fence compares.
 *
 * - `https://host/owner/repo(.git)` and `http://…` → `owner/repo`
 * - `ssh://[user@]host[:port]/owner/repo(.git)` → `owner/repo`
 * - scp-like `user@host:owner/repo(.git)` → `owner/repo`
 *
 * Anything else (`file://…`, a local or Windows path, an scp-like URL with an
 * absolute path) comes back unchanged apart from a trailing `.git`: it names no
 * forge repository, and the write fence admits the job's own checkout by
 * exact match.
 *
 * Pure string code: the engine barrel is browser-safe.
 */
export function repoIdentifierFromUrl(repoUrl: string): string {
  const url = repoUrl.replace(/\.git$/, '');
  if (/^https?:\/\//.test(url)) return url.replace(/^https?:\/\/[^/]+\//, '');
  if (url.startsWith('ssh://')) return url.replace(/^ssh:\/\/[^/]+\//, '');
  const scp = /^[^/@:]+@[^:/]+:(?!\/)(.+)$/.exec(url);
  if (scp) return scp[1]!;
  return url;
}
