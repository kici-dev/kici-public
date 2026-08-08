import { z } from 'zod';

/** Supported fresh-box agent target platforms (glibc-Linux bootstrap set). */
export const AgentPlatform = z.enum(['linux-x64', 'linux-arm64']);
export type AgentPlatform = z.infer<typeof AgentPlatform>;

/**
 * How a fresh-box agent payload is delivered to the target during bring-up.
 * `s3-direct`: the box pulls the payload from the orchestrator cache bucket via
 * a presigned URL (no 50 MB through the ops agent). `ssh-push`: the ops agent
 * fetches the payload and streams it to the box over a binary-safe scp (the
 * fallback for a box that cannot reach object storage).
 */
export const AgentDeliveryMode = z.enum(['ssh-push', 's3-direct']);
export type AgentDeliveryMode = z.infer<typeof AgentDeliveryMode>;

export interface AgentPlatformParts {
  /** nodejs.org os token. */
  nodeOs: 'linux';
  /** nodejs.org arch token. */
  nodeArch: 'x64' | 'arm64';
  /** npm `--os` token. */
  npmOs: 'linux';
  /** npm `--cpu` token. */
  npmCpu: 'x64' | 'arm64';
}

/** Decompose an AgentPlatform into the os/arch tokens npm and nodejs.org expect. */
export function splitAgentPlatform(platform: AgentPlatform): AgentPlatformParts {
  const arch = platform === 'linux-x64' ? 'x64' : 'arm64';
  return { nodeOs: 'linux', nodeArch: arch, npmOs: 'linux', npmCpu: arch };
}
