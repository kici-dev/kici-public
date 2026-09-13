import { describe, it, expect } from 'vitest';
import { getHookTemplate, hasKiciHook, KICI_HOOK_MARKER } from './templates.js';

describe('KICI_HOOK_MARKER', () => {
  it('is a recognizable comment', () => {
    expect(KICI_HOOK_MARKER).toContain('KiCI');
    expect(KICI_HOOK_MARKER).toMatch(/^#/);
  });
});

describe('getHookTemplate', () => {
  describe('husky', () => {
    it('returns template with getCommand', () => {
      const template = getHookTemplate('husky');
      expect(template.getCommand).toBeDefined();
    });

    it('returns template with getFullScript', () => {
      const template = getHookTemplate('husky');
      expect(template.getFullScript).toBeDefined();
    });

    it('getCommand includes marker and command', () => {
      const template = getHookTemplate('husky');
      const result = template.getCommand('kici compile');
      expect(result).toContain(KICI_HOOK_MARKER);
      expect(result).toContain('kici compile');
    });

    it('getFullScript is a POSIX shell script (modern v9+ format)', () => {
      const template = getHookTemplate('husky');
      const result = template.getFullScript!('kici compile');
      expect(result).toMatch(/^#!/);
      expect(result).toContain('#!/usr/bin/env sh');
      expect(result).not.toContain('husky.sh');
      expect(result).toContain(KICI_HOOK_MARKER);
      expect(result).toContain('kici compile');
    });
  });

  describe('lefthook', () => {
    it('returns YAML config block', () => {
      const template = getHookTemplate('lefthook');
      const result = template.getCommand('kici compile');
      expect(result).toContain('kici-compile:');
      expect(result).toContain('run: kici compile');
    });

    it('does not have getFullScript (appends to existing YAML)', () => {
      const template = getHookTemplate('lefthook');
      expect(template.getFullScript).toBeUndefined();
    });
  });

  describe('pre-commit', () => {
    it('returns YAML repos/hooks structure', () => {
      const template = getHookTemplate('pre-commit');
      const result = template.getCommand('kici compile');
      expect(result).toContain('- repo: local');
      expect(result).toContain('id: kici-compile');
      expect(result).toContain('name: KiCI Compile');
      expect(result).toContain('entry: kici compile');
      expect(result).toContain('language: system');
      expect(result).toContain('pass_filenames: false');
      expect(result).toContain('always_run: true');
    });
  });

  describe('prek', () => {
    it('returns same format as pre-commit', () => {
      const template = getHookTemplate('prek');
      const result = template.getCommand('kici compile');
      expect(result).toContain('- repo: local');
      expect(result).toContain('id: kici-compile');
    });
  });

  describe('git (raw)', () => {
    it('returns template with getCommand', () => {
      const template = getHookTemplate('git');
      const result = template.getCommand('kici compile');
      expect(result).toContain(KICI_HOOK_MARKER);
      expect(result).toContain('kici compile');
    });

    it('getFullScript is a POSIX shell script', () => {
      const template = getHookTemplate('git');
      const result = template.getFullScript!('kici compile');
      expect(result).toMatch(/^#!/);
      expect(result).toContain('#!/bin/sh');
      expect(result).toContain('# pre-commit hook');
    });
  });
});

describe('hasKiciHook', () => {
  it('returns true when marker is present', () => {
    const content = `#!/bin/sh
${KICI_HOOK_MARKER}
kici compile`;
    expect(hasKiciHook(content)).toBe(true);
  });

  it('returns true when "kici compile" is present', () => {
    const content = `#!/bin/sh
# some hook
kici compile`;
    expect(hasKiciHook(content)).toBe(true);
  });

  it('returns true when "kici-compile" hook ID is present', () => {
    const content = `pre-commit:
  commands:
    kici-compile:
      run: npx -y kici@latest compile`;
    expect(hasKiciHook(content)).toBe(true);
  });

  it('returns true when @kici-dev/compiler is present', () => {
    const content = `#!/bin/sh
npx -y @kici-dev/compiler@latest compile`;
    expect(hasKiciHook(content)).toBe(true);
  });

  it('returns false when neither marker nor command present', () => {
    const content = `#!/bin/sh
npm test`;
    expect(hasKiciHook(content)).toBe(false);
  });
});
