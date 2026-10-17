/**
 * A Debian package name (lowercase letters, digits, `+`, `-` and `.`, two
 * characters or more, starting with a letter or digit), optionally pinned as
 * `name=version`. The agent passes it to apt-get, so the pattern is anchored at
 * both ends.
 */
const APT_PACKAGE_PATTERN = /^[a-z0-9][a-z0-9+.-]+(=[0-9][A-Za-z0-9.+~:-]*)?$/;

/** Whether `spec` is a Debian package name, optionally pinned as `name=version`. */
export function isAptPackageSpec(spec: string): boolean {
  return APT_PACKAGE_PATTERN.test(spec);
}
