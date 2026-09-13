/**
 * Egress filtering for nested job containers.
 *
 * A job container joins a dedicated `kici-jobs` bridge network, and the agent
 * installs the same RFC1918 + cloud-metadata nftables drops the orchestrator's
 * scaler installs for agent containers. Without them a job container keeps the
 * runtime's default bridge, which reaches `169.254.169.254` and the host's whole
 * private network — a step can take the instance role or sweep the customer's
 * internal services.
 *
 * The rule builder is `@kici-dev/shared`'s, so the agent and the scaler apply
 * one implementation rather than two copies that drift.
 *
 * `network: 'host'` (from `KICI_SANDBOX_NETWORK=host` or a per-job
 * `sandbox: { network: 'host' }` grant) bypasses this by construction: asking
 * for the host namespace is asking for the host's network.
 */

import type Docker from 'dockerode';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import {
  addHostIsolationRules,
  addIsolationRules,
  buildHostAccessRuleOps,
  buildIsolationRuleOps,
  ensureKiciTable,
  JOB_NETWORK_SUBNET,
  readForwardChain,
  readInputChain,
  removeIsolationRules,
  validateNftablesAvailability,
  type NetworkPolicy,
} from '@kici-dev/shared/net';

const logger = createLogger({ prefix: 'job-network' });

/** Bridge network every filtered job container joins. */
export const JOB_NETWORK_NAME = 'kici-jobs';
/**
 * Subnet for {@link JOB_NETWORK_NAME}. Distinct from the scaler's agent network.
 *
 * Defined in `@kici-dev/shared/net` and re-exported here: the Firecracker host
 * provisioner must recognise this subnet's rules to leave them alone, and it
 * cannot import from the agent package.
 */
export { JOB_NETWORK_SUBNET };
/** Gateway for {@link JOB_NETWORK_NAME} — the one destination the rules allow. */
export const JOB_NETWORK_GATEWAY = '172.31.0.1';

/** Port the bridge gateway's DNS resolver listens on. */
const DNS_PORT = 53;

/**
 * Resolve what a job container may reach on the host.
 *
 * The default is DNS on the bridge gateway and nothing else. A job container
 * talks to the agent through `docker exec` rather than over the network, and it
 * holds none of the agent's credentials, so name resolution is the one host
 * service it genuinely needs. That carve-out is not cosmetic: rootful podman
 * runs its resolver on the gateway, a host address, so a container with no such
 * rule cannot resolve any name at all. Docker answers inside the container's
 * own netns and is unaffected either way.
 *
 * The set is derived HERE, from the agent's own configuration, and takes no
 * argument that could widen it. A `NetworkPolicy` reaching
 * {@link applyJobEgressRules} governs the FORWARD hook only — what the job
 * reaches through the host — so its `hostAccess` is deliberately not consulted:
 * a job that could name its own host reachability is the escape hatch this
 * boundary exists to close, and a signature that cannot carry one is what makes
 * that structural rather than a convention.
 */
export function resolveJobHostAccess(gateway: string = JOB_NETWORK_GATEWAY): string[] {
  return [`${gateway}:${DNS_PORT}`];
}

/**
 * Ensure the `kici-jobs` network exists, the nftables table is ready, and the
 * subnet's default egress drops are installed.
 *
 * The drops land here — before any job container is created — and are keyed on
 * the subnet rather than on a container address, so a customer image's own
 * `ENTRYPOINT` never runs unfiltered.
 *
 * Returns whether egress filtering is actually in force. A host without `nft`
 * or without `NET_ADMIN` — a rootless agent, most commonly — warns loudly and
 * degrades to the network with no rules rather than refusing to run any job:
 * `kici-admin agent install` is a compat-protected surface, and hard-requiring
 * NET_ADMIN would break every existing rootless install with no additive path.
 * The same trade-off the scaler already made for agent containers.
 */
export async function ensureJobNetwork(docker: Docker): Promise<boolean> {
  try {
    // Order matters: the nft probe runs FIRST, so a host that cannot filter
    // never joins the bridge either. Joining without rules would be a network
    // change that buys nothing, and it would fail the job outright on a runtime
    // whose client cannot create the network.
    await validateNftablesAvailability();
    await ensureKiciTable();
    await ensureJobSubnetEgressRules(JOB_NETWORK_SUBNET, JOB_NETWORK_GATEWAY);

    // The bridge may already exist — made by a hand, or by a version that used
    // a different range — and a container on it gets THAT subnet's addresses,
    // which the set installed above would not match. Cover the real range too
    // rather than refusing: refusing returns false, which puts the container on
    // the runtime's default bridge with no filtering at all.
    const actual = await ensureJobNetworkExists(docker);
    if (actual.subnet !== JOB_NETWORK_SUBNET || actual.gateway !== JOB_NETWORK_GATEWAY) {
      logger.warn(
        `Job network ${JOB_NETWORK_NAME} carries ${actual.subnet} (gateway ${actual.gateway}), ` +
          `not the expected ${JOB_NETWORK_SUBNET} (gateway ${JOB_NETWORK_GATEWAY}). ` +
          'Installing the egress drops for the range it actually uses. Remove the network ' +
          'to have the agent recreate it with the expected addressing.',
      );
      await ensureJobSubnetEgressRules(actual.subnet, actual.gateway);
    }
    return true;
  } catch (err) {
    logger.warn(
      `Job-container egress filtering DISABLED: ${toErrorMessage(err)} ` +
        'Job containers reach the host private network and the cloud metadata endpoint. ' +
        'Grant the agent --cap-add=NET_ADMIN (and install nftables), or set ' +
        'KICI_SANDBOX_NETWORK_ISOLATION=false to silence this.',
    );
    return false;
  }
}

/**
 * Install the default RFC1918 + cloud-metadata drops for the whole job subnet.
 *
 * Keyed on `ip saddr 172.31.0.0/16`, so one rule set covers every container
 * that will ever join the bridge — including one that does not exist yet. A
 * customer image's own `ENTRYPOINT` therefore starts behind the drops: there is
 * no window between the container running and its rules landing, because the
 * rules do not depend on the container.
 *
 * The per-container rules {@link applyJobEgressRules} adds stay the layer above
 * these, and stay effective: `addIsolationRules` inserts at the chain head, so
 * a rule keyed on one container's address is evaluated before the subnet set
 * and a per-job `accept` still wins over the subnet `drop`. The exception is a
 * repair (below), which puts a fresh subnet set at the head — above the
 * per-container rules of jobs that were already running. That reordering has no
 * effect while `applyJobEgressRules` is called with no policy, since the two
 * sets then hold identical verdicts; a per-job policy would have to reinstall
 * its own rules after a repair to keep winning.
 *
 * Idempotent, because `ensureJobNetwork` runs once per job and an unconditional
 * install would leak a rule set per job: the chain is read first and the install
 * is skipped when it already carries the set.
 *
 * The skip requires EVERY expected rule, never merely one of them. The install
 * is one `nft insert` per rule, so a failure or a kill part-way through
 * leaves some of the set in the chain; a check that skipped on the first match
 * would then read a chain missing the `10.0.0.0/8` drop as covered, and every
 * later job on that host would join the bridge behind permanently partial
 * filtering with nothing to heal it. Comparing against the rule text
 * {@link buildIsolationRuleOps} emits is also what rejects the two near-misses
 * the scaler writes into this same chain — a per-container rule at
 * `172.31.0.10`, and an operator allowlist naming this subnet as a DESTINATION.
 *
 * A partial set is repaired by installing the whole set again rather than by
 * deleting first: the fresh block lands at the chain head, complete and in
 * order, so a job container already running behind the surviving rules is never
 * left unfiltered even briefly. The superseded rules below it are inert
 * duplicates.
 */
async function ensureJobSubnetEgressRules(subnet: string, gateway: string): Promise<void> {
  await ensureJobSubnetHostRules(subnet, gateway);

  const expected = buildIsolationRuleOps(['ip', 'saddr', subnet], gateway).map((tokens) =>
    tokens.join(' '),
  );

  const chain = await readForwardChain();
  const present = new Set(
    (chain ?? '').split('\n').map((line) => line.trim().replace(/\s*# handle \d+$/, '')),
  );
  if (chain !== null && expected.every((rule) => present.has(rule))) return;

  await addIsolationRules(subnet, gateway, undefined, 'saddr');
  logger.info(`Installed default egress drops for ${subnet}`);
}

/**
 * Install the subnet-wide host-access rules — what a job container may reach ON
 * the host, as opposed to through it.
 *
 * Keyed on the subnet for the same reason the forward set is: it covers a
 * container that does not exist yet, so a customer image's `ENTRYPOINT` never
 * runs in the window before the per-container rules land.
 *
 * Idempotent against the chain's own text rather than by remove-then-insert.
 * Removing first would take the drop away from every running job container for
 * as long as the re-insert takes, which is the one direction that must not
 * fail open.
 */
async function ensureJobSubnetHostRules(subnet: string, gateway: string): Promise<void> {
  const hostAccess = resolveJobHostAccess(gateway);
  const expected = buildHostAccessRuleOps(['ip', 'saddr', subnet], hostAccess).map((tokens) =>
    tokens.join(' '),
  );

  const chain = await readInputChain();
  const present = new Set(
    (chain ?? '').split('\n').map((line) => line.trim().replace(/\s*# handle \d+$/, '')),
  );
  if (chain !== null && expected.every((rule) => present.has(rule))) return;

  await addHostIsolationRules(subnet, hostAccess, 'saddr');
  logger.info(`Installed default host-access rules for ${subnet}`);
}

/** The address range a job container on the bridge actually gets. */
interface JobNetworkAddressing {
  subnet: string;
  gateway: string;
}

/**
 * Create the `kici-jobs` bridge network, tolerating a concurrent creator.
 *
 * Returns the addressing job containers will actually get. That is the
 * canonical pair whenever this call created the network, and whatever an
 * already-present network carries otherwise — which is the only thing the drop
 * set can honestly be keyed on. A network someone else made under this name
 * with a different subnet would leave every job container outside a set keyed
 * on the constant, and the pre-start window this whole module exists to close
 * would reopen for it.
 */
async function ensureJobNetworkExists(docker: Docker): Promise<JobNetworkAddressing> {
  const canonical = { subnet: JOB_NETWORK_SUBNET, gateway: JOB_NETWORK_GATEWAY };

  // The name filter matches substrings, so the exact name is re-checked.
  const existing = await findJobNetwork(docker);
  if (existing) return existing;

  try {
    await docker.createNetwork({
      Name: JOB_NETWORK_NAME,
      Driver: 'bridge',
      IPAM: { Config: [{ Subnet: JOB_NETWORK_SUBNET, Gateway: JOB_NETWORK_GATEWAY }] },
      Labels: { 'kici-managed': 'true' },
    });
    logger.info(`Created job network ${JOB_NETWORK_NAME}`);
    return canonical;
  } catch (err) {
    // 409: another agent (or another job on this agent) created it first. Read
    // back what THEY made rather than assuming they asked for what we did.
    if ((err as { statusCode?: number }).statusCode === 409) {
      return (await findJobNetwork(docker)) ?? canonical;
    }
    throw err;
  }
}

/** The present `kici-jobs` network's addressing, or `undefined` when absent. */
async function findJobNetwork(docker: Docker): Promise<JobNetworkAddressing | undefined> {
  const found = (await docker.listNetworks({ filters: { name: [JOB_NETWORK_NAME] } })).find(
    (n) => n.Name === JOB_NETWORK_NAME,
  );
  if (!found) return undefined;

  // A network with no IPAM config at all reports nothing to key on, so the
  // canonical pair is the honest fallback: the per-container rules still land.
  const config = (found.IPAM?.Config ?? [])[0] as { Subnet?: string; Gateway?: string } | undefined;
  return {
    subnet: config?.Subnet ?? JOB_NETWORK_SUBNET,
    gateway: config?.Gateway ?? JOB_NETWORK_GATEWAY,
  };
}

/**
 * Apply the per-container egress rules once the container has an IP.
 *
 * This is the per-job layer, not the control: the subnet drop set
 * {@link ensureJobNetwork} installs is already in the chain and already covers
 * this container. What a per-container rule set adds is a place to key a future
 * per-job policy — an allowlist or `denyAll` — on one address rather than on
 * the whole bridge.
 *
 * Returns the container IP the rules are keyed on, so teardown can remove
 * exactly those rules; `undefined` when no IP could be read, which is logged
 * rather than thrown — a job whose rules could not be keyed still runs behind
 * the subnet drops, and the operator sees why.
 */
export async function applyJobEgressRules(
  docker: Docker,
  containerId: string,
  policy: NetworkPolicy | undefined,
): Promise<string | undefined> {
  const info = await docker.getContainer(containerId).inspect();
  const containerIp = info.NetworkSettings?.Networks?.[JOB_NETWORK_NAME]?.IPAddress as
    string | undefined;
  if (!containerIp) {
    logger.warn(
      'Could not determine job container IP — no per-container egress rules applied. ' +
        'A container on the kici-jobs bridge stays behind the subnet drops; one that is not ' +
        'on that bridge has unfiltered egress.',
      { containerId },
    );
    return undefined;
  }

  await addIsolationRules(containerIp, JOB_NETWORK_GATEWAY, policy, 'saddr');
  await addHostIsolationRules(containerIp, resolveJobHostAccess(), 'saddr');
  return containerIp;
}

/**
 * Remove the per-container rules at teardown.
 *
 * Never throws: a failed cleanup must not turn a finished job into a failed
 * one. A leaked rule set is keyed on an IP the network will reuse, so it is
 * reported at `warn` for the operator rather than swallowed.
 */
export async function removeJobEgressRules(containerIp: string | undefined): Promise<void> {
  if (!containerIp) return;
  try {
    await removeIsolationRules(containerIp);
  } catch (err) {
    logger.warn('Failed to remove job-container egress rules', {
      containerIp,
      error: toErrorMessage(err),
    });
  }
}
