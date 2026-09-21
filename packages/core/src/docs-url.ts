/**
 * The published docs host. The marketing apex (`kici.dev`) fronts only the
 * marketing bundle: any `/docs/*` path on the apex serves the SPA shell and 404s
 * client-side, so every docs URL a CLI prints, a template scaffolds, or a
 * contract advertises is built here and nowhere else.
 */
export const DOCS_SITE_URL = 'https://docs.kici.dev';

/**
 * A docs URL for a site-relative path. Page paths get the trailing slash the
 * docs site treats as canonical; a file path (one with an extension in its
 * last segment) is left as-is. A query or fragment stays after the slash.
 */
export function docsUrl(path: string): string {
  const cut = path.search(/[?#]/);
  const suffix = cut === -1 ? '' : path.slice(cut);
  const trimmed = (cut === -1 ? path : path.slice(0, cut)).replace(/^\/+/, '').replace(/\/+$/, '');
  if (trimmed === '') return `${DOCS_SITE_URL}/${suffix}`;
  const last = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  const isFile = /\.[a-z0-9]+$/i.test(last);
  return `${DOCS_SITE_URL}/${trimmed}${isFile ? '' : '/'}${suffix}`;
}
