/** The shipped `.git/config`: generated as `git clone` writes it, never copied from the developer. */

import { GitObjectFormat } from './git-ship-types.js';

/** `scheme://authority/rest`, as git's URL syntax (`https://`, `ssh://`, `file://`). */
const SCHEME_URL = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/?#]*)(.*)$/s;

/**
 * Strip the userinfo (user, password, token) of `scheme://user:pass@host/path` and scp-like
 * `user@host:path` URLs; a local path comes back unchanged.
 */
export function stripUrlUserinfo(url: string): string {
  const match = SCHEME_URL.exec(url);
  if (match) {
    const [, scheme, authority, rest] = match;
    return `${scheme}${authority.slice(authority.lastIndexOf('@') + 1)}${rest}`;
  }
  // git reads `host:path` as scp-like when no '/' comes before the first ':'.
  const colon = url.indexOf(':');
  const slash = url.indexOf('/');
  if (colon > 0 && (slash === -1 || colon < slash)) {
    const at = url.slice(0, colon).lastIndexOf('@');
    return at === -1 ? url : url.slice(at + 1);
  }
  return url;
}

/**
 * The shipped `remote.origin.url`: without userinfo and, for `scheme://`, without the query and
 * fragment, which can carry a token (`?private_token=…`).
 */
export function shippedOriginUrl(url: string): string {
  const stripped = stripUrlUserinfo(url);
  if (!SCHEME_URL.test(stripped)) return stripped;
  return stripped.replace(/[?#].*$/s, '');
}

/** A config value as git writes it: escaped, and quoted when it would otherwise parse differently. */
function configValue(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
  const needsQuotes = /[#;]/.test(value) || /^\s|\s$/.test(value);
  return needsQuotes ? `"${escaped}"` : escaped;
}

function subsection(name: string): string {
  return `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function renderShippedGitConfig(args: {
  objectFormat: GitObjectFormat;
  originUrl?: string;
  branch?: string;
  depth: number;
  /** As `git clone --no-tags`: a later `git fetch` fetches no tags either. */
  noTags?: boolean;
}): string {
  const sha256 = args.objectFormat === GitObjectFormat.Sha256;
  const lines = [
    '[core]',
    `\trepositoryformatversion = ${sha256 ? 1 : 0}`,
    '\tfilemode = true',
    '\tbare = false',
    '\tlogallrefupdates = true',
  ];
  if (sha256) lines.push('[extensions]', '\tobjectformat = sha256');
  if (args.originUrl !== undefined) {
    // A shallow clone fetches only its branch; a full clone and a detached one track all.
    const fetch =
      args.depth > 0 && args.branch !== undefined
        ? `+refs/heads/${args.branch}:refs/remotes/origin/${args.branch}`
        : '+refs/heads/*:refs/remotes/origin/*';
    lines.push(`[remote ${subsection('origin')}]`, `\turl = ${configValue(args.originUrl)}`);
    if (args.noTags) lines.push('\ttagOpt = --no-tags');
    lines.push(`\tfetch = ${configValue(fetch)}`);
    if (args.branch !== undefined) {
      lines.push(
        `[branch ${subsection(args.branch)}]`,
        '\tremote = origin',
        `\tmerge = ${configValue(`refs/heads/${args.branch}`)}`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}
