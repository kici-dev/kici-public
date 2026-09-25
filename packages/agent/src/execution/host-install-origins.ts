/**
 * Parse `KICI_HOST_INSTALL_REGISTRIES`: the registry origins, beyond the
 * public npm registry and the agent user's own `~/.npmrc`, that a container
 * job's `.kici/` install on the agent host may contact.
 *
 * The host install runs outside the job network's egress filter, so every
 * origin it contacts must be one the operator chose. A workflow's
 * `registries:` block and a repository's `.kici/.npmrc` are chosen by the
 * repository, so they qualify only when their origin is on this list.
 * Matching is by exact origin (scheme, host and port after URL
 * normalization), never by what a name resolves to.
 */

export type RegistryOriginParse = { ok: true; origin: string } | { ok: false; reason: string };

export interface ParsedHostInstallRegistries {
  /** Normalized origins, in first-seen order, without duplicates. */
  origins: string[];
  /**
   * Entries that are not an http(s) origin, with the reason. Each entry has its
   * credentials removed (`redactRegistryEntry`), since it goes into a startup error.
   */
  invalid: { entry: string; reason: string }[];
}

/** A host name an origin may carry: DNS labels, an IPv4 address, or a bracketed IPv6 literal. */
const PLAIN_HOST = /^(?:[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.?|\[[0-9a-f:.]+\])$/;

/**
 * Normalize one operator entry to its origin. The entry must be an http(s)
 * URL naming only an origin: no credentials, path, query or fragment, and a
 * host name that is a plain DNS name or IP address.
 */
export function parseRegistryOrigin(entry: string): RegistryOriginParse {
  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    return { ok: false, reason: 'is not a URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'is not an http or https URL' };
  }
  if (url.username || url.password) return { ok: false, reason: 'carries credentials' };
  // fails-when: `http://verdaccio.local:4873/npm/` is accepted, so an operator
  // reads the path as a narrower grant than the origin match applies.
  // breaks-if-wrong: `http://verdaccio.local:4873` and its trailing-slash form
  // both parse.
  if (url.pathname !== '/' || url.search || url.hash) {
    return { ok: false, reason: 'names more than an origin (a path, query or fragment)' };
  }
  if (!PLAIN_HOST.test(url.hostname)) {
    return { ok: false, reason: 'has a host that is not a plain DNS name or IP address' };
  }
  return { ok: true, origin: url.origin };
}

/**
 * `entry` without anything that may be a credential, for an error message: the
 * userinfo before the host, and the text of a query or a fragment. The rest of
 * the entry is kept as written, so the operator can find it in the setting.
 */
export function redactRegistryEntry(entry: string): string {
  return (
    entry
      // Everything up to the last `@` before the path, as the URL parser reads userinfo.
      .replace(/^((?:[a-z][a-z0-9+.-]*:)?\/\/)?[^/?#]*@/i, '$1')
      .replace(/\?[^#]*/, '?[redacted]')
      .replace(/#.*$/, '#[redacted]')
  );
}

/** Split the comma-separated setting, normalize each entry, and collect the refusals. */
export function parseHostInstallRegistries(raw: string): ParsedHostInstallRegistries {
  const origins: string[] = [];
  const invalid: ParsedHostInstallRegistries['invalid'] = [];
  for (const entry of raw.split(',').map((e) => e.trim())) {
    if (!entry) continue;
    const parsed = parseRegistryOrigin(entry);
    // fails-when: a refused entry keeps its userinfo, and the startup error prints it
    if (!parsed.ok) invalid.push({ entry: redactRegistryEntry(entry), reason: parsed.reason });
    else if (!origins.includes(parsed.origin)) origins.push(parsed.origin);
  }
  return { origins, invalid };
}
