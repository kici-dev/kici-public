/**
 * The host binaries the agent checks for at startup.
 */
import type { ToolRequirement } from '@kici-dev/shared';

/**
 * What the agent needs on PATH before it accepts work on `platform`.
 *
 * git checks out the repository everywhere. Steps run their shell commands in
 * bash on Linux and macOS, and in PowerShell 7 (`pwsh`) on Windows, which the
 * agent installs with winget when a step first needs it. So bash is required
 * on every platform but Windows, where Git for Windows keeps it out of the
 * `cmd` folder its installer puts on PATH.
 */
export function agentToolRequirements(platform: NodeJS.Platform): ToolRequirement[] {
  const requirements: ToolRequirement[] = [
    { type: 'path-binary', name: 'git', reason: 'required for repository checkout' },
  ];
  if (platform !== 'win32') {
    requirements.push({ type: 'path-binary', name: 'bash', reason: 'required for step execution' });
  }
  return requirements;
}
