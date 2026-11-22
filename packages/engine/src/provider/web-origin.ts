/**
 * The origin of `value` when it is a bare `https:` origin (`https://host[:port]`,
 * optionally with a trailing slash), else null: a value carrying a path, query,
 * fragment or credentials can never become a link host.
 */
export function webOriginOrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const bare =
    url.protocol === 'https:' &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === '' &&
    url.username === '' &&
    url.password === '';
  return bare ? url.origin : null;
}
