/** A release version: `major.minor.patch`, with an optional prerelease suffix (`0.30.0-4512`). */
export const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** The longest `componentVersion` a reader uses, so a logged value stays small. */
export const COMPONENT_VERSION_MAX_LENGTH = 64;

/**
 * The release version an `auth.request` `componentVersion` carries: a string of at most
 * {@link COMPONENT_VERSION_MAX_LENGTH} characters that matches {@link RELEASE_VERSION_PATTERN}.
 * Any other value (absent, another type, another form) gives `undefined`.
 */
export function readComponentVersion(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > COMPONENT_VERSION_MAX_LENGTH) return undefined;
  return RELEASE_VERSION_PATTERN.test(value) ? value : undefined;
}

/** A short form of a `componentVersion` value for a log line: a bounded string, or its type. */
export function describeComponentVersion(value: unknown): string {
  if (typeof value === 'string') {
    const head = value.slice(0, COMPONENT_VERSION_MAX_LENGTH);
    return JSON.stringify(head).replace(/"$/, value.length > head.length ? '…"' : '"');
  }
  if (value === null) return 'null';
  return Array.isArray(value) ? 'array' : typeof value;
}

/** The request header that carries the `kici` CLI's release version to a Platform. */
export const CLIENT_VERSION_HEADER = 'X-Kici-Client-Version';

/** What a Platform tells a component that is newer than itself. */
export const PLATFORM_UPGRADE_REQUIRED_MESSAGE =
  'This component is newer than the KiCI Platform it connects to. Upgrade the Platform first.';

/** The `major.minor.patch` numbers of a release version; throws on anything else. */
function releaseBase(version: string): [number, number, number] {
  if (!RELEASE_VERSION_PATTERN.test(version)) {
    throw new Error(`${JSON.stringify(version)} is not a release version (major.minor.patch)`);
  }
  const [major, minor, patch] = version.split('-')[0]!.split('.').map(Number);
  return [major!, minor!, patch!];
}

/** Compares on `major.minor.patch`, dropping a prerelease suffix; throws on a non-version. */
export function compareReleaseBase(a: string, b: string): -1 | 0 | 1 {
  const left = releaseBase(a);
  const right = releaseBase(b);
  for (let i = 0; i < 3; i++) {
    if (left[i]! !== right[i]!) return left[i]! > right[i]! ? 1 : -1;
  }
  return 0;
}

/** Whether `component` is a later release than `platform`, by base version. */
export function isNewerRelease(component: string, platform: string): boolean {
  return compareReleaseBase(component, platform) === 1;
}
