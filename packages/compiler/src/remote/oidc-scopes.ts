/** The scopes every `kici login` requests; no offline_access, as no refresh token is read. */
const BASE_OIDC_SCOPES = ['openid', 'profile', 'email'] as const;

/** Split a scope list on commas and whitespace, dropping empty entries. */
export function parseScopeList(value: string | undefined): string[] {
  return (value ?? '').split(/[\s,]+/).filter((scope) => scope !== '');
}

/** The `scope` parameter: the base scopes, then `extra`, each once, in order. */
export function oidcScopeString(extra: readonly string[] = []): string {
  return [...new Set([...BASE_OIDC_SCOPES, ...extra])].join(' ');
}
