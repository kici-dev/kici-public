/**
 * The `overlay` field of a `kici run remote --json` result: the overlay's size
 * and, when a `.git` shipped, what was asked for and what the remote workspace
 * actually holds.
 */

import type { OverlayReport } from '../commands/preview.js';
import type { GitShipRequirement } from './git-ship-requirement.js';
import type { ShippedGit } from './shipped-git/git-ship-types.js';

export function buildOverlayReport(
  summary: { compressedSize: number; fileCount: number },
  requirement: GitShipRequirement,
  git: ShippedGit | undefined,
): OverlayReport {
  return {
    compressedSize: summary.compressedSize,
    fileCount: summary.fileCount,
    ...(git && {
      git: {
        depth: requirement.depth,
        tags: requirement.tags,
        // The record the agent's history-gap warning reads, so the JSON and
        // the job log agree.
        shipped: { fetchDepth: git.record.fetchDepth, allTags: git.record.allTags },
        synthetic: git.synthetic,
        workspaceSha: git.workspaceSha,
        baseSha: git.baseSha,
        syntheticTags: git.createdTags,
      },
    }),
  };
}
