/**
 * kici org commands
 *
 * Org management: list, use, current.
 * Uses PAT auth to fetch user's organizations from Platform API.
 */

import pc from 'picocolors';
import { loadGlobalConfig, mergeGlobalConfig, type GlobalConfig } from '../remote/config.js';

/** Organization returned by Platform API */
interface UserOrg {
  id: string;
  displayName: string;
  role: string;
}

/**
 * Fetch user's organizations from Platform API using PAT auth.
 */
async function fetchUserOrgs(config: GlobalConfig): Promise<UserOrg[] | null> {
  const url = `${config.platformEndpoint}/api/v1/user/orgs`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${config.pat}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    if (response.status === 401) {
      console.error(
        pc.red(
          'Authentication failed. Your PAT may be expired. Run `kici login` to re-authenticate.',
        ),
      );
      return null;
    }
    console.error(pc.red(`Failed to fetch organizations: HTTP ${response.status}`));
    return null;
  }

  const body = (await response.json()) as { orgs: UserOrg[] } | UserOrg[];
  // Platform /api/v1/user/orgs returns { orgs: [...] }, handle both shapes for safety
  return Array.isArray(body) ? body : body.orgs;
}

/**
 * Check that the user is logged in (PAT exists in config).
 * Returns the config if logged in, null otherwise.
 */
async function requireAuth(): Promise<GlobalConfig | null> {
  const config = await loadGlobalConfig();
  if (!config.pat) {
    console.error(pc.red('Not logged in. Run `kici login` first.'));
    return null;
  }
  if (!config.platformEndpoint) {
    console.error(
      pc.red('No Platform endpoint configured. Run `kici login` with --platform-endpoint.'),
    );
    return null;
  }
  return config;
}

/**
 * List user's organizations.
 *
 * Fetches orgs from Platform API and displays them as a formatted table.
 * Active org is marked with a star.
 */
export async function orgListCommand(): Promise<boolean> {
  const config = await requireAuth();
  if (!config) return false;

  const orgs = await fetchUserOrgs(config);
  if (orgs === null) return false;

  if (orgs.length === 0) {
    console.log(pc.gray('No organizations found.'));
    return true;
  }

  console.log(pc.bold('\nOrganizations:\n'));

  const nameWidth = Math.max(12, ...orgs.map((o) => o.displayName.length)) + 2;

  for (const org of orgs) {
    const isActive = org.id === config.activeOrgId;
    const marker = isActive ? pc.green('* ') : '  ';
    const name = isActive ? pc.bold(org.displayName) : org.displayName;
    const role = pc.gray(`(${org.role})`);
    const id = pc.gray(org.id);

    console.log(`  ${marker}${name.padEnd(nameWidth)} ${role}  ${id}`);
  }

  console.log('');
  return true;
}

/**
 * Switch active organization.
 *
 * Matches by display name (case-insensitive) or ID.
 * Validates org exists before setting.
 */
export async function orgUseCommand(nameOrId: string): Promise<boolean> {
  const config = await requireAuth();
  if (!config) return false;

  const orgs = await fetchUserOrgs(config);
  if (orgs === null) return false;

  const match = orgs.find(
    (o) => o.displayName.toLowerCase() === nameOrId.toLowerCase() || o.id === nameOrId,
  );

  if (!match) {
    console.error(pc.red(`Organization not found: ${nameOrId}`));
    if (orgs.length > 0) {
      console.error(pc.gray('Available organizations:'));
      for (const org of orgs) {
        console.error(pc.gray(`  - ${org.displayName} (${org.id})`));
      }
    }
    return false;
  }

  await mergeGlobalConfig({ activeOrgId: match.id });
  console.log(pc.green(`Active org set to: ${match.displayName}`));
  return true;
}

/**
 * Display current active organization.
 *
 * If PAT is available, fetches org name for display.
 */
export async function orgCurrentCommand(): Promise<boolean> {
  const config = await loadGlobalConfig();

  if (!config.activeOrgId) {
    console.log(pc.gray("No active org set. Run 'kici org use <name>' to set one."));
    return true;
  }

  // If PAT is available, try to fetch org name
  if (config.pat && config.platformEndpoint) {
    const orgs = await fetchUserOrgs(config);
    if (orgs) {
      const org = orgs.find((o) => o.id === config.activeOrgId);
      if (org) {
        console.log(`Active org: ${pc.bold(org.displayName)} ${pc.gray(`(${org.id})`)}`);
        return true;
      }
    }
  }

  // Fallback: just show the ID
  console.log(`Active org: ${pc.bold(config.activeOrgId)}`);
  return true;
}
