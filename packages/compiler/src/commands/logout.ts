import pc from 'picocolors';
import { ClientNewerThanPlatformError, platformFetch } from '../remote/platform-fetch.js';
import { loadGlobalConfig, saveGlobalConfig, getConfigPath } from '../remote/config.js';
import { planeStatus, detachPlane } from '../local-plane/plane-manager.js';

/**
 * A failed server-side PAT revoke only warns (the PAT expires on its own); the
 * login fields are cleared regardless, and the command always succeeds.
 */
export async function logoutCommand(): Promise<boolean> {
  const config = await loadGlobalConfig();

  if (!config.pat) {
    console.log(pc.gray('Not logged in.'));
    return true;
  }

  if (config.patId && config.platformEndpoint) {
    try {
      const url = `${config.platformEndpoint}/api/v1/pats/${config.patId}`;
      const response = await platformFetch(url, {
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
    } catch (err) {
      console.log(
        pc.yellow(
          err instanceof ClientNewerThanPlatformError
            ? `Warning: could not revoke PAT on server: ${err.message}`
            : 'Warning: could not revoke PAT on server (will expire automatically).',
        ),
      );
    }
  }

  // A hybrid plane would hold an orphaned orchestrator key. Best-effort, using
  // the still-present PAT.
  try {
    if ((await planeStatus()).mode === 'hybrid') {
      await detachPlane({ pat: config.pat });
      console.log(pc.gray('Local dev plane detached (back to offline).'));
    }
  } catch {
    // Non-fatal.
  }

  // Connection settings are preserved.
  const cleanConfig = { ...config };
  delete cleanConfig.pat;
  delete cleanConfig.patId;
  delete cleanConfig.patExpiresAt;
  delete cleanConfig.userEmail;
  delete cleanConfig.activeOrgId;

  await saveGlobalConfig(cleanConfig);

  const configPath = getConfigPath();
  console.log(pc.green(`Logged out. Config cleared at ${configPath}.`));
  return true;
}
