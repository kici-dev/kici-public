/**
 * kici logout command
 *
 * Revokes PAT server-side and clears local auth config.
 */

import pc from 'picocolors';
import { loadGlobalConfig, saveGlobalConfig, getConfigPath } from '../remote/config.js';

/**
 * Logout from KiCI.
 *
 * 1. Revokes the PAT server-side (DELETE /api/v1/pats/:id)
 * 2. Clears auth fields from local config (preserves non-auth settings)
 *
 * If server revocation fails (network error), still clears local config
 * with a warning that the PAT will expire automatically.
 *
 * @returns true on completion (always succeeds from user's perspective)
 */
export async function logoutCommand(): Promise<boolean> {
  const config = await loadGlobalConfig();

  if (!config.pat && !config.token) {
    console.log(pc.gray('Not logged in.'));
    return true;
  }

  // Try to revoke PAT server-side
  if (config.patId && config.platformEndpoint) {
    try {
      const url = `${config.platformEndpoint}/api/v1/pats/${config.patId}`;
      const response = await fetch(url, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${config.pat}`,
          'Content-Type': 'application/json',
        },
      });

      if (response.ok) {
        console.log(pc.green('PAT revoked on server.'));
      } else {
        console.log(
          pc.yellow('Warning: could not revoke PAT on server (will expire automatically).'),
        );
      }
    } catch {
      console.log(
        pc.yellow('Warning: could not revoke PAT on server (will expire automatically).'),
      );
    }
  }

  // Clear all auth fields from config, preserving connection settings
  const cleanConfig = { ...config };
  delete cleanConfig.pat;
  delete cleanConfig.patId;
  delete cleanConfig.patExpiresAt;
  delete cleanConfig.userEmail;
  delete cleanConfig.activeOrgId;
  delete cleanConfig.token;

  await saveGlobalConfig(cleanConfig);

  const configPath = getConfigPath();
  console.log(pc.green(`Logged out. Config cleared at ${configPath}.`));
  return true;
}
