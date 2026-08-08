/**
 * Anchor prefixes used inside cache / artifact tarballs.
 *
 * The packer stages every entry under one of two anchor prefixes so a
 * repo-root-relative path and a home-relative path can never collide inside the
 * same archive. Every producer and consumer of those archives — the agent's
 * cache engine and the CLI's artifact extractor — shares these constants so the
 * on-tape layout cannot drift between them.
 */

/** Anchor prefix for repo-root-relative entries inside the tar. */
export const REPO_ANCHOR = '__repo__';

/** Anchor prefix for home-relative (`~`) entries inside the tar. */
export const HOME_ANCHOR = '__home__';
