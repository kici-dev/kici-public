/**
 * A Firecracker scaler's `extraHosts`: the `host:address` mappings the rootfs
 * `/init` appends to each guest's `/etc/hosts`.
 *
 * An entry is `host:address`, the form the container backend documents for the
 * same field; the container runtimes accept more (`host=address`, bracketed
 * IPv6), a Firecracker scaler does not. `host-gateway` stands for the bridge
 * gateway, the address a microVM reaches its host at. A guest carries no
 * mapping unless the scaler configures one.
 */
import { isIP } from 'node:net';

/** The address keyword for the bridge gateway, as the container runtimes spell it. */
export const HOST_GATEWAY = 'host-gateway';

/**
 * An RFC 1123 hostname: dot-separated labels of letters, digits and inner
 * hyphens. Nothing else can reach the guest's `/etc/hosts`, so an entry can
 * never add a second line or a second name there.
 */
const HOSTNAME =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

export interface ExtraHost {
  host: string;
  /** An IPv4 or IPv6 address, or {@link HOST_GATEWAY}. */
  address: string;
}

/**
 * Parse one `host:address` entry. The host ends at the first colon, so an
 * IPv6 address keeps its own colons. Throws on a malformed entry.
 */
export function parseExtraHost(entry: string): ExtraHost {
  const sep = entry.indexOf(':');
  const host = sep === -1 ? '' : entry.slice(0, sep);
  const address = sep === -1 ? '' : entry.slice(sep + 1);
  if (host === '' || address === '') {
    throw new Error(`extraHosts entry "${entry}" must be host:address`);
  }
  if (!HOSTNAME.test(host)) {
    throw new Error(`extraHosts entry "${entry}": "${host}" is not a valid hostname`);
  }
  if (address !== HOST_GATEWAY && isIP(address) === 0) {
    throw new Error(
      `extraHosts entry "${entry}": the address must be an IP address or ${HOST_GATEWAY}`,
    );
  }
  return { host, address };
}

/**
 * The MMDS value the rootfs `/init` reads: `host:address` pairs joined by
 * commas, with `host-gateway` replaced by `gateway`. `undefined` when the
 * scaler configures no mapping, so the guest gets none. Throws on a malformed
 * entry, and on `host-gateway` when `gateway` is not an IP address.
 */
export function renderGuestExtraHosts(
  entries: readonly string[] | undefined,
  gateway: string,
): string | undefined {
  if (!entries || entries.length === 0) return undefined;
  return entries
    .map((entry) => {
      const { host, address } = parseExtraHost(entry);
      if (address !== HOST_GATEWAY) return `${host}:${address}`;
      if (isIP(gateway) === 0) {
        throw new Error(
          `extraHosts entry "${entry}": the bridge gateway "${gateway}" is not an IP address`,
        );
      }
      return `${host}:${gateway}`;
    })
    .join(',');
}
