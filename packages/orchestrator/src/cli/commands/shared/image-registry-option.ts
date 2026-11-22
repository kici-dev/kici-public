/**
 * `--image-registry <prefix>` (env `KICI_IMAGE_REGISTRY`) on `orchestrator install` and
 * `agent install`: a compose install pulls its image from this registry prefix in place of
 * `quay.io/kici-dev`, pinned to the same manifest-list digest.
 */

import { Option } from 'commander';
import { IMAGE_REGISTRY_ENV, normalizeImageRegistry } from '../../service/image-digests.js';
import type { ServicePlatform } from '../../service/index.js';

/** The option, for a command to add with `.addOption(imageRegistryOption())`. */
export function imageRegistryOption(): Option {
  return new Option(
    '--image-registry <prefix>',
    'Compose only: pull the image from this registry prefix instead of quay.io/kici-dev, ' +
      'pinned to the same digest (e.g. registry.internal.example/kici-dev)',
  ).env(IMAGE_REGISTRY_ENV);
}

/** Where Commander read an option's value from (`Command.getOptionValueSource`). */
export type OptionValueSource = string | undefined;

/**
 * The registry prefix the install records, or `undefined` for `quay.io/kici-dev`.
 *
 * A non-compose platform runs no image, so the flag given on the command line is refused there
 * instead of being ignored; the same value read from `KICI_IMAGE_REGISTRY` is ignored, because a
 * shell-wide setting must not block an install on another platform.
 * @throws On a value that is not an image prefix, or on the flag with a non-compose platform.
 */
export function installImageRegistry(
  platform: ServicePlatform,
  value: string | undefined,
  source: OptionValueSource,
): string | undefined {
  const registry = normalizeImageRegistry(value);
  if (registry === undefined || platform === 'compose') return registry;
  // fails-when: the flag is given for a systemd install and silently does nothing
  if (source === 'cli') {
    throw new Error(
      `--image-registry applies only to --platform compose (this install: ${platform})`,
    );
  }
  // breaks-if-wrong: KICI_IMAGE_REGISTRY exported in a shell must not refuse a systemd install
  return undefined;
}
