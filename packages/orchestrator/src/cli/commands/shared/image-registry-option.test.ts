import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { imageRegistryOption, installImageRegistry } from './image-registry-option.js';

describe('installImageRegistry', () => {
  it('a compose install records the normalized prefix', () => {
    for (const source of ['cli', 'env']) {
      expect(installImageRegistry('compose', 'registry.internal.example/kici-dev/', source)).toBe(
        'registry.internal.example/kici-dev',
      );
    }
  });

  it('no value records nothing', () => {
    // breaks-if-wrong: an install with no registry keeps quay.io/kici-dev
    expect(installImageRegistry('compose', undefined, undefined)).toBeUndefined();
    expect(installImageRegistry('systemd', '', 'cli')).toBeUndefined();
  });

  it('the flag on another platform is refused', () => {
    // fails-when: --image-registry on a systemd install is silently ignored
    expect(() =>
      installImageRegistry('systemd', 'registry.internal.example/kici-dev', 'cli'),
    ).toThrow('--image-registry applies only to --platform compose (this install: systemd)');
  });

  it('the setting from the environment on another platform is ignored', () => {
    // breaks-if-wrong: a shell-wide KICI_IMAGE_REGISTRY must not refuse a systemd install
    expect(
      installImageRegistry('systemd', 'registry.internal.example/kici-dev', 'env'),
    ).toBeUndefined();
  });

  it('a value that is not an image prefix is refused on any platform', () => {
    expect(() => installImageRegistry('compose', 'https://r.example/kici-dev', 'cli')).toThrow(
      /must be an image prefix/,
    );
  });
});

describe('imageRegistryOption', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('reads KICI_IMAGE_REGISTRY when the flag is absent, and the flag wins', () => {
    vi.stubEnv('KICI_IMAGE_REGISTRY', 'env.example/kici-dev');
    const parse = (argv: string[]) => {
      const cmd = new Command()
        .exitOverride()
        .addOption(imageRegistryOption())
        .action(() => {});
      cmd.parse(argv, { from: 'user' });
      return [cmd.opts().imageRegistry, cmd.getOptionValueSource('imageRegistry')];
    };
    expect(parse([])).toEqual(['env.example/kici-dev', 'env']);
    expect(parse(['--image-registry', 'cli.example/kici-dev'])).toEqual([
      'cli.example/kici-dev',
      'cli',
    ]);
  });
});
