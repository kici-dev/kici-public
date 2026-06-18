/**
 * Firecracker host-network provisioning.
 *
 * Creates the per-coordinator bridge (kici-brN), assigns its gateway IP,
 * marks kici-* interfaces unmanaged by NetworkManager, enables IP forwarding,
 * and builds a disjoint, source-scoped nftables table for NAT + egress
 * isolation. One pure command-builder drives live provisioning, the rendered
 * boot script, and (read-only) verification.
 *
 * This is HOST setup, distinct from the runtime per-VM isolation in
 * scaler/nftables.ts (added at spawn / removed at destroy). The two share the
 * nft table name but have separate lifecycles; this module never touches the
 * per-VM rules.
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import { RFC1918_RANGES, METADATA_RANGE } from '../scaler/nftables.js';

const execFileP = promisify(execFileCb);
const logger = createLogger({ prefix: 'fc-host-network' });

/** Privileged binaries that need `sudo -n` on a non-root orchestrator host. */
const PRIVILEGED_BINS = new Set(['ip', 'nft', 'sysctl']);

/** Timeout for a single host-network provisioning command. */
const COMMAND_TIMEOUT_MS = 30_000;

/** A single subprocess invocation (no shell). */
export interface CommandSpec {
  bin: string;
  args: string[];
  /** Optional stdin payload (used for `nft -f -`). */
  stdin?: string;
}

/** Host-bridge configuration for one Firecracker coordinator. */
export interface FirecrackerBridgeConfig {
  /** Bridge interface name, e.g. 'kici-br0'. */
  bridgeName: string;
  /** Gateway IP + prefix, e.g. '10.0.0.1/24'. */
  bridgeCidr: string;
  /** nft table name, e.g. 'kici' or 'kici_b'. */
  table: string;
  /** NAT egress interface; auto-detected from the default route when omitted. */
  hostIface?: string;
}

/**
 * Derive the network address (CIDR) from a gateway CIDR by masking host bits.
 * '10.0.0.1/24' -> '10.0.0.0/24'.
 */
export function cidrToNetwork(cidr: string): string {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr);
  if (!m) throw new Error(`Invalid CIDR "${cidr}" (expected a.b.c.d/prefix)`);
  const octets = [m[1], m[2], m[3], m[4]].map((o) => Number(o));
  for (const o of octets) {
    if (o > 255) throw new Error(`Invalid octet in CIDR "${cidr}" (each octet must be 0-255)`);
  }
  const prefix = Number(m[5]);
  if (prefix > 32) throw new Error(`Invalid prefix /${prefix} in CIDR "${cidr}" (max /32)`);
  // Build the 32-bit address, apply the prefix mask.
  const addr = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const net = (addr & mask) >>> 0;
  const netOctets = [(net >>> 24) & 0xff, (net >>> 16) & 0xff, (net >>> 8) & 0xff, net & 0xff];
  return `${netOctets.join('.')}/${prefix}`;
}

/** Bridge-name prefix used as the iifname match (matches the bridge + its TAP members). */
function bridgePrefix(bridgeName: string): string {
  // 'kici-br0' -> 'kici-*' (TAP devices forward with the TAP iifname, all kici-*).
  return `${bridgeName.split('-')[0]}-*`;
}

/**
 * Build the ordered command list that provisions one Firecracker host bridge.
 * Pure — performs no I/O. `provisionBridge` executes these; `renderBootScript`
 * serializes them.
 *
 * The nft `delete table`/`add table` here only ever touches `cfg.table`, so a
 * coord-B provision never wipes coord A's table (and vice versa). Every
 * forward/postrouting/MSS rule is source-scoped to the bridge subnet so two
 * tables on the shared hooks do not cross-drop each other's traffic.
 */
export function buildBridgeCommands(cfg: FirecrackerBridgeConfig): CommandSpec[] {
  const iface = cfg.hostIface;
  if (!iface) {
    throw new Error(
      'buildBridgeCommands requires a resolved hostIface (call resolveHostIface first)',
    );
  }
  const subnet = cidrToNetwork(cfg.bridgeCidr);
  const gatewayIp = cfg.bridgeCidr.split('/')[0];
  const prefix = bridgePrefix(cfg.bridgeName);
  const t = cfg.table;
  const nft = (...args: string[]): CommandSpec => ({ bin: 'nft', args });
  const saddr = ['ip', 'saddr', subnet];

  return [
    // 1. Bridge.
    { bin: 'ip', args: ['link', 'add', 'name', cfg.bridgeName, 'type', 'bridge'] },
    { bin: 'ip', args: ['addr', 'add', cfg.bridgeCidr, 'dev', cfg.bridgeName] },
    { bin: 'ip', args: ['link', 'set', cfg.bridgeName, 'up'] },
    // 2. Forwarding.
    { bin: 'sysctl', args: ['-w', 'net.ipv4.ip_forward=1'] },
    // 3. Fresh, disjoint table.
    nft('delete', 'table', 'ip', t),
    nft('add', 'table', 'ip', t),
    // 4. Postrouting masquerade, source-scoped.
    nft(
      'add',
      'chain',
      t,
      'postrouting',
      '{ type nat hook postrouting priority srcnat; policy accept; }',
    ),
    nft('add', 'rule', t, 'postrouting', ...saddr, 'oifname', iface, 'masquerade'),
    // 5. Forward chain, source-scoped rules (order matters: gateway accept,
    //    RFC1918 drops, metadata drop, internet accept, established, MSS).
    nft(
      'add',
      'chain',
      t,
      'forward',
      '{ type filter hook forward priority filter; policy accept; }',
    ),
    nft(
      'add',
      'rule',
      t,
      'forward',
      ...saddr,
      'iifname',
      prefix,
      'ip',
      'daddr',
      gatewayIp,
      'accept',
    ),
    ...RFC1918_RANGES.map((r) =>
      nft('add', 'rule', t, 'forward', ...saddr, 'iifname', prefix, 'ip', 'daddr', r, 'drop'),
    ),
    nft(
      'add',
      'rule',
      t,
      'forward',
      ...saddr,
      'iifname',
      prefix,
      'ip',
      'daddr',
      METADATA_RANGE,
      'drop',
    ),
    nft('add', 'rule', t, 'forward', ...saddr, 'iifname', prefix, 'oifname', iface, 'accept'),
    nft(
      'add',
      'rule',
      t,
      'forward',
      'iifname',
      iface,
      'ip',
      'daddr',
      subnet,
      'oifname',
      prefix,
      'ct',
      'state',
      'related,established',
      'accept',
    ),
    nft(
      'add',
      'rule',
      t,
      'forward',
      ...saddr,
      'tcp',
      'flags',
      'syn',
      '/',
      'syn,rst',
      'tcp',
      'option',
      'maxseg',
      'size',
      'set',
      '1460',
    ),
  ];
}

export const NM_CONF_PATH = '/etc/NetworkManager/conf.d/90-kici-unmanaged.conf';
export const NM_CONF_CONTENT = [
  '# Managed by kici-admin firecracker — do not hand-edit.',
  '#',
  "# KiCI's Firecracker scaler creates and destroys many kici-* interfaces",
  '# (TAP devices + bridges). NetworkManager must not manage them: it auto-adopts',
  '# them and can wedge the NM main thread at 100% CPU under churn.',
  '[keyfile]',
  'unmanaged-devices=interface-name:kici-*',
  '',
].join('\n');

export type CommandRunner = (spec: CommandSpec) => Promise<{ stdout: string }>;

/** Writes the host-scoped NetworkManager conf. Injectable for tests. */
export type FileWriter = (path: string, content: string) => Promise<void>;

export interface ExecOptions {
  /** Inject a runner for tests. */
  runner?: CommandRunner;
  /** Inject the NM-conf file writer for tests. */
  writeNmConf?: FileWriter;
  /** Wrap privileged bins with `sudo -n` (non-root orchestrator hosts). */
  requireSudo?: boolean;
}

const defaultFileWriter: FileWriter = (path, content) => writeFile(path, content, 'utf8');

function defaultRunner(requireSudo: boolean): CommandRunner {
  return async ({ bin, args, stdin }) => {
    const useSudo = requireSudo && PRIVILEGED_BINS.has(bin);
    const child = useSudo
      ? execFileP('sudo', ['-n', bin, ...args], { timeout: COMMAND_TIMEOUT_MS })
      : execFileP(bin, args, { timeout: COMMAND_TIMEOUT_MS });
    if (stdin && child.child.stdin) {
      child.child.stdin.end(stdin);
    }
    const { stdout } = await child;
    return { stdout: stdout.toString() };
  };
}

/** Resolve the default-route egress interface. */
export async function resolveHostIface(opts: ExecOptions = {}): Promise<string> {
  const runner = opts.runner ?? defaultRunner(opts.requireSudo ?? false);
  const { stdout } = await runner({ bin: 'ip', args: ['-j', 'route', 'show', 'default'] });
  const routes = JSON.parse(stdout) as Array<{ dev?: string }>;
  const dev = routes.find((r) => r.dev)?.dev;
  if (!dev) throw new Error('could not detect the default-route interface for NAT egress');
  return dev;
}

export interface BridgeHealth {
  bridgeName: string;
  bridgeExists: boolean;
  bridgeUp: boolean;
  addrPresent: boolean;
  tablePresent: boolean;
  healthy: boolean;
  detail: string;
}

/** Provision (or heal) one Firecracker host bridge. Throws on any failure. */
export async function provisionBridge(
  cfg: FirecrackerBridgeConfig,
  opts: ExecOptions = {},
): Promise<void> {
  const runner = opts.runner ?? defaultRunner(opts.requireSudo ?? false);
  const iface = cfg.hostIface ?? (await resolveHostIface(opts));
  const resolved = { ...cfg, hostIface: iface };

  // NM unmanaged conf (host-scoped) before any bridge churn.
  const writeNmConf = opts.writeNmConf ?? defaultFileWriter;
  try {
    await writeNmConf(NM_CONF_PATH, NM_CONF_CONTENT);
  } catch (err) {
    // Only swallow ENOENT (no NetworkManager dir on this host); anything else is fatal.
    if (!toErrorMessage(err).includes('ENOENT')) {
      throw new Error(`failed to write ${NM_CONF_PATH}: ${toErrorMessage(err)}`);
    }
  }

  for (const spec of buildBridgeCommands(resolved)) {
    const line = [spec.bin, ...spec.args].join(' ');
    try {
      await runner(spec);
    } catch (err) {
      const msg = toErrorMessage(err);
      // Idempotency carve-outs: a missing-table delete and an already-existing
      // bridge/addr are expected on re-runs and are NOT failures.
      const benignDelete =
        line.startsWith('nft delete table') && /No such file|does not exist/i.test(msg);
      // `ip link add` on a re-run answers "RTNETLINK answers: File exists";
      // `ip addr add` answers "Error: ipv4: Address already assigned." — both
      // mean the resource is already present and the re-run is a no-op.
      const benignExists =
        /File exists|already a member|already assigned|exists/i.test(msg) &&
        (line.includes('link add') || line.includes('addr add'));
      if (benignDelete || benignExists) {
        logger.debug(`idempotent skip: ${line} (${msg})`);
        continue;
      }
      throw new Error(`FC host-network command failed: ${line}: ${msg}`);
    }
  }
  logger.info(
    `provisioned bridge ${cfg.bridgeName} (${cfg.bridgeCidr}, table ${cfg.table}, egress ${iface})`,
  );
}

/** Read-only health probe for one bridge. Never throws on a missing resource. */
export async function verifyBridge(
  cfg: FirecrackerBridgeConfig,
  opts: ExecOptions = {},
): Promise<BridgeHealth> {
  const runner = opts.runner ?? defaultRunner(opts.requireSudo ?? false);
  const want = cfg.bridgeCidr.split('/')[0];
  const wantPrefix = Number(cfg.bridgeCidr.split('/')[1]);
  let bridgeExists = false;
  let bridgeUp = false;
  let addrPresent = false;
  let tablePresent = false;
  const misses: string[] = [];

  try {
    const { stdout } = await runner({ bin: 'ip', args: ['-j', 'link', 'show', cfg.bridgeName] });
    const link = JSON.parse(stdout) as Array<{ operstate?: string; flags?: string[] }>;
    bridgeExists = link.length > 0;
    // A bridge with no enslaved TAP reports operstate DOWN + NO-CARRIER even
    // when administratively up — that's the normal post-provision state before
    // any microVM spawns. The administrative state is the IFF_UP flag in
    // `flags`; that's what we assert (operstate UP/UNKNOWN also counts, for a
    // bridge that happens to already have a carrier-bearing member).
    const adminUp = (link[0]?.flags ?? []).includes('UP');
    const operUp = link[0]?.operstate === 'UP' || link[0]?.operstate === 'UNKNOWN';
    bridgeUp = adminUp || operUp;
    if (!bridgeUp) misses.push(`${cfg.bridgeName} not up`);
  } catch {
    misses.push(`${cfg.bridgeName} does not exist`);
  }

  try {
    const { stdout } = await runner({ bin: 'ip', args: ['-j', 'addr', 'show', cfg.bridgeName] });
    const info = JSON.parse(stdout) as Array<{
      addr_info?: Array<{ local?: string; prefixlen?: number }>;
    }>;
    addrPresent = (info[0]?.addr_info ?? []).some(
      (a) => a.local === want && a.prefixlen === wantPrefix,
    );
    if (!addrPresent) misses.push(`${cfg.bridgeCidr} not assigned to ${cfg.bridgeName}`);
  } catch {
    misses.push(`could not read addrs on ${cfg.bridgeName}`);
  }

  try {
    await runner({ bin: 'nft', args: ['list', 'table', 'ip', cfg.table] });
    tablePresent = true;
  } catch {
    misses.push(`nft table ip ${cfg.table} missing`);
  }

  const healthy = bridgeExists && bridgeUp && addrPresent && tablePresent;
  return {
    bridgeName: cfg.bridgeName,
    bridgeExists,
    bridgeUp,
    addrPresent,
    tablePresent,
    healthy,
    detail: healthy ? 'healthy' : misses.join('; '),
  };
}

/** Remove the bridge + its nft table. Leaves the host-scoped NM conf in place. */
export async function teardownBridge(
  cfg: FirecrackerBridgeConfig,
  opts: ExecOptions = {},
): Promise<void> {
  const runner = opts.runner ?? defaultRunner(opts.requireSudo ?? false);
  for (const spec of [
    { bin: 'nft', args: ['delete', 'table', 'ip', cfg.table] },
    { bin: 'ip', args: ['link', 'del', cfg.bridgeName] },
  ]) {
    try {
      await runner(spec);
    } catch (err) {
      logger.debug(`teardown skip ${spec.bin}: ${toErrorMessage(err)}`);
    }
  }
}

const HOST_IFACE_SENTINEL = '__HOST_IFACE__';

/** Serialize the provisioning command list into a dependency-free boot script. */
export function renderBootScript(cfg: FirecrackerBridgeConfig): string {
  const specs = buildBridgeCommands({ ...cfg, hostIface: HOST_IFACE_SENTINEL });
  const lines = specs.map((s) => {
    const benign = s.bin === 'nft' && s.args[0] === 'delete' && s.args[1] === 'table';
    const argv = [s.bin, ...s.args]
      .map((tok) => (tok === HOST_IFACE_SENTINEL ? '"$HOST_IFACE"' : shellQuote(tok)))
      .join(' ');
    return benign ? `${argv} 2>/dev/null || true` : argv;
  });
  return [
    '#!/usr/bin/env bash',
    `# Generated by kici-admin firecracker --persist for bridge ${cfg.bridgeName}. Do not hand-edit.`,
    'set -euo pipefail',
    // Write the NM-unmanaged conf via a quoted heredoc so the multi-line
    // content lands verbatim (real newlines, no shell expansion). `printf '%s'`
    // would NOT interpret backslash escapes in its argument, so embedding
    // \n-escaped content there collapses the conf onto one line — a single
    // comment line NM ignores, leaving kici-* interfaces NM-managed on reboot.
    `cat > ${NM_CONF_PATH} <<'KICI_NM_EOF' || true`,
    NM_CONF_CONTENT.replace(/\n$/, ''),
    'KICI_NM_EOF',
    'HOST_IFACE=$(ip -j route show default | sed -n \'s/.*"dev":"\\([^"]*\\)".*/\\1/p\' | head -1)',
    'if [ -z "$HOST_IFACE" ]; then echo "no default-route iface" >&2; exit 1; fi',
    ...lines,
    '',
  ].join('\n');
}

/**
 * Minimal POSIX-safe single-quote shell escaping for boot-script tokens.
 *
 * `*` is deliberately NOT in the bare-token allow-list: an `nft` arg like
 * `kici-*` (the iifname match) must reach nft literally, but an unquoted
 * `kici-*` would be glob-expanded by bash against the CWD. Tokens carrying any
 * shell metacharacter (incl. `*`, spaces, `{`/`;` from chain definitions) are
 * single-quoted so they pass through verbatim.
 */
function shellQuote(tok: string): string {
  if (/^[A-Za-z0-9_./:=,+-]+$/.test(tok)) return tok;
  return `'${tok.replace(/'/g, `'\\''`)}'`;
}
