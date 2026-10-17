/**
 * The container-scaler agent image check `kici-admin orchestrator upgrade`
 * runs before it restarts the service.
 *
 * A container scaler spawns each agent from the image its label set names, not
 * from the upgraded orchestrator. So an upgrade leaves container agents on the
 * old release when a label set pins an older `kici-agent:<version>`, or names
 * the moving `:latest` tag with the default `imagePullPolicy: IfNotPresent`: a
 * host that already pulled `:latest` keeps that image. The check only warns:
 * it never rewrites the operator's scaler config and never stops the upgrade.
 */

import fs from 'node:fs';
import { ScalerBackendType } from '@kici-dev/engine';
import { parseVersionBase } from '../../../agent/agent-version.js';
import { loadScalerConfig } from '../../../scaler/config.js';
import { ImagePullPolicy, type ScalerConfig } from '../../../scaler/types.js';
import { scalerConfigLocation } from './bare-metal-binary-check.js';

/** The repository name of the published agent image, under any registry or mirror. */
const AGENT_IMAGE_NAME = 'kici-agent';

/** The moving tag an untagged image reference resolves to. */
const LATEST_TAG = 'latest';

/** Why a container label set keeps spawning an old agent after the upgrade. */
export enum AgentImageIssue {
  /** `:latest` (or no tag) with `IfNotPresent`: the host keeps the image it pulled. */
  MovingTag = 'moving-tag',
  /** A `kici-agent:<version>` older than the release the upgrade installs. */
  OlderPin = 'older-pin',
}

export interface AgentImageFinding {
  issue: AgentImageIssue;
  scaler: string;
  labels: string[];
  image: string;
  message: string;
}

/** An image reference split into its repository, tag and digest. */
export interface ImageRefParts {
  repository: string;
  tag: string | null;
  digest: string | null;
}

/**
 * Split `[registry/]path/name[:tag][@digest]`. A `:` before the last `/` is a
 * registry port, not a tag.
 */
export function parseImageRef(image: string): ImageRefParts {
  const at = image.indexOf('@');
  const named = at === -1 ? image : image.slice(0, at);
  const digest = at === -1 ? null : image.slice(at + 1);
  const colon = named.lastIndexOf(':');
  if (colon > named.lastIndexOf('/')) {
    return { repository: named.slice(0, colon), tag: named.slice(colon + 1), digest };
  }
  return { repository: named, tag: null, digest };
}

/** True when the repository is the KiCI agent image, from quay.io or a mirror. */
function isAgentImage(repository: string): boolean {
  return repository.slice(repository.lastIndexOf('/') + 1) === AGENT_IMAGE_NAME;
}

/** -1, 0 or 1 as `a` is an older, the same or a newer release than `b`; null for a non-version. */
function compareReleases(a: string, b: string): number | null {
  const left = parseVersionBase(a.replace(/^v/, ''));
  const right = parseVersionBase(b.replace(/^v/, ''));
  if (!left || !right) return null;
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

export interface CheckAgentImagesArgs {
  config: ScalerConfig;
  /** The release the upgrade installs, or null when the caller does not know it. */
  targetVersion: string | null;
  /** The main scaler config file, for the remedy text. */
  scalerConfigPath: string;
  /** The `KICI_SCALER_CONFIG_DIR` directory, when one is set. */
  scalerConfigDir?: string;
}

/**
 * Every container-scaler label set whose agent image an upgrade to
 * `targetVersion` leaves unchanged. An empty result means each agent image is
 * pinned to the target (or newer), pulled on every spawn, or not a KiCI agent.
 */
export function checkContainerAgentImages(args: CheckAgentImagesArgs): AgentImageFinding[] {
  const { config } = args;
  // Only a release number names a published tag: `--version latest` must not
  // become the "pin" the warning suggests.
  const bare = args.targetVersion?.trim().replace(/^v/, '') ?? null;
  const targetVersion = bare && parseVersionBase(bare) ? bare : null;
  const where = args.scalerConfigDir
    ? `${args.scalerConfigPath} (or the file under ${args.scalerConfigDir} that declares it)`
    : args.scalerConfigPath;
  const findings: AgentImageFinding[] = [];
  for (const entry of config.scalers) {
    if (entry.type !== ScalerBackendType.enum.container) continue;
    for (const ls of entry.labelSets) {
      if (!ls.image) continue;
      const ref = parseImageRef(ls.image);
      if (!isAgentImage(ref.repository)) continue;
      const pinned = targetVersion ? `${ref.repository}:${targetVersion}` : null;
      const prefix = `container scaler "${entry.name}", label set [${ls.labels.join(', ')}]: image ${ls.image}`;
      const finding = (issue: AgentImageIssue, message: string): AgentImageFinding => ({
        issue,
        scaler: entry.name,
        labels: ls.labels,
        image: ls.image!,
        message: `${prefix} ${message}`,
      });

      const policy = ls.imagePullPolicy ?? ImagePullPolicy.enum.IfNotPresent;
      const moving = (ref.tag === null || ref.tag === LATEST_TAG) && ref.digest === null;
      if (moving && policy === ImagePullPolicy.enum.IfNotPresent) {
        const pin = pinned
          ? `set "image: ${pinned}"`
          : `set image to the kici-agent release you upgrade to (${ref.repository}:<version>)`;
        findings.push(
          finding(
            AgentImageIssue.MovingTag,
            `with imagePullPolicy IfNotPresent keeps the agent image this host already pulled, ` +
              `so the upgrade does not change the container agents. In ${where}, ${pin} on ` +
              `this label set, or set "imagePullPolicy: Always" to pull ${LATEST_TAG} on every spawn.`,
          ),
        );
        continue;
      }

      if (!targetVersion || ref.tag === null) continue;
      if (compareReleases(ref.tag, targetVersion) === -1) {
        findings.push(
          finding(
            AgentImageIssue.OlderPin,
            `is older than the upgrade target ${targetVersion}, so the container agents keep ` +
              `running ${ref.tag}. In ${where}, set "image: ${pinned}" on this label set.`,
          ),
        );
      }
    }
  }
  return findings;
}

export interface WarnAgentImagesArgs {
  envFilePath: string;
  workingDirectory: string;
  /** The release the upgrade installs, or null when the caller does not know it. */
  targetVersion: string | null;
  warn: (line: string) => void;
}

/**
 * Print one warning per container label set whose agent image the upgrade
 * leaves unchanged. Never throws, and stays silent when the env file or the
 * scaler config cannot be read: the bare-metal `binaryPath` check, which runs
 * first on the same files, already reports that.
 */
export async function warnAboutContainerAgentImages(args: WarnAgentImagesArgs): Promise<void> {
  let location: ReturnType<typeof scalerConfigLocation>;
  let config: ScalerConfig;
  try {
    location = scalerConfigLocation(
      fs.readFileSync(args.envFilePath, 'utf-8'),
      args.workingDirectory,
    );
    if (!location) return;
    config = await loadScalerConfig(location.configPath, location.configDir);
  } catch {
    return;
  }
  const findings = checkContainerAgentImages({
    config,
    targetVersion: args.targetVersion,
    scalerConfigPath: location.configPath,
    ...(location.configDir ? { scalerConfigDir: location.configDir } : {}),
  });
  for (const f of findings) args.warn(`Warning: ${f.message}`);
}
