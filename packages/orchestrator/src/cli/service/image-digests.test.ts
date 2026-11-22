import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  installerImageName,
  normalizeImageRegistry,
  pinnedImageVersion,
  resolveImageRef,
} from './image-digests.js';

function fixture(rec: unknown): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kici-imgdig-'));
  const file = path.join(dir, 'installer-image-digests.json');
  writeFileSync(file, JSON.stringify(rec));
  return file;
}

describe('resolveImageRef', () => {
  it('emits :<version>@sha256:<digest> when the record has the image', () => {
    const file = fixture({
      version: '0.1.15',
      images: { 'kici-orchestrator': 'sha256:' + 'a'.repeat(64) },
    });
    const ref = resolveImageRef('kici-orchestrator', { filePath: file });
    expect(ref).toBe(`quay.io/kici-dev/kici-orchestrator:0.1.15@sha256:${'a'.repeat(64)}`);
  });

  it('falls back to :latest when the record lacks the image', () => {
    const file = fixture({ version: '0.1.15', images: {} });
    const ref = resolveImageRef('kici-agent', { filePath: file });
    expect(ref).toBe('quay.io/kici-dev/kici-agent:latest');
  });

  it('falls back to :latest when no record file is found', () => {
    const ref = resolveImageRef('kici-orchestrator', {
      filePath: '/nonexistent/installer-image-digests.json',
    });
    expect(ref).toBe('quay.io/kici-dev/kici-orchestrator:latest');
  });

  it('falls back to :latest when the record file is corrupt', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'kici-imgdig-'));
    const file = path.join(dir, 'installer-image-digests.json');
    writeFileSync(file, 'not json{');
    const ref = resolveImageRef('kici-orchestrator', { filePath: file });
    expect(ref).toBe('quay.io/kici-dev/kici-orchestrator:latest');
  });
});

describe('resolveImageRef with a registry', () => {
  const DIGEST = 'sha256:' + 'b'.repeat(64);
  const record = () =>
    fixture({ version: '0.30.0', images: { 'kici-orchestrator': DIGEST, 'kici-agent': DIGEST } });

  it('--image-registry replaces only the quay prefix and keeps the digest', () => {
    // fails-when: a customer registry gets the image without the digest, so it can substitute it
    const file = record();
    for (const registry of [
      'registry.internal.example/kici-dev',
      'registry.internal.example/kici-dev/',
      'registry.internal:5000/mirror/kici-dev',
    ]) {
      const prefix = registry.replace(/\/+$/, '');
      expect(resolveImageRef('kici-orchestrator', { filePath: file, registry })).toBe(
        `${prefix}/kici-orchestrator:0.30.0@${DIGEST}`,
      );
    }
  });

  it('no registry keeps quay.io/kici-dev', () => {
    // breaks-if-wrong: an install with no --image-registry must keep pulling from quay.io
    const file = record();
    for (const registry of [undefined, '', '  ']) {
      expect(resolveImageRef('kici-agent', { filePath: file, registry })).toBe(
        `quay.io/kici-dev/kici-agent:0.30.0@${DIGEST}`,
      );
    }
  });

  it('the :latest fallback also goes to the registry', () => {
    const ref = resolveImageRef('kici-orchestrator', {
      filePath: '/nonexistent/installer-image-digests.json',
      registry: 'registry.internal.example/kici-dev',
    });
    expect(ref).toBe('registry.internal.example/kici-dev/kici-orchestrator:latest');
  });

  it('every prefix of the reference grammar is accepted', () => {
    // breaks-if-wrong: a valid prefix a real registry uses is refused
    for (const ok of [
      'registry.internal.example/kici-dev',
      'Registry.Internal.Example:5000/mirror/kici-dev',
      'localhost:5000/kici_dev/a.b/c__d/e--f',
      'kici-dev',
    ]) {
      expect(normalizeImageRegistry(ok), ok).toBe(ok);
    }
  });

  it('a registry that is not an image prefix is refused', () => {
    // fails-when: a URL, a tag or a digest in the prefix renders an image ref no runtime pulls
    for (const bad of [
      'https://registry.internal.example/kici-dev',
      'registry.internal.example/kici-dev:1.0',
      'registry.internal.example/kici-dev@sha256:abc',
      'registry internal/kici-dev',
      '/kici-dev',
      'registry.internal.example/*',
      'registry.internal.example/&anchor',
      'registry.internal.example/{kici}',
      'registry.internal.example/kici#dev',
      'registry.internal.example/Kici-Dev',
      'registry.internal.example//kici-dev',
      '-registry.example/kici-dev',
      'registry.example:port/kici-dev',
    ]) {
      expect(() => normalizeImageRegistry(bad), bad).toThrow(/--image-registry/);
    }
  });
});

describe('installerImageName', () => {
  it('names the published image of each component', () => {
    expect(installerImageName('orchestrator')).toBe('kici-orchestrator');
    expect(installerImageName('agent')).toBe('kici-agent');
  });
});

describe('pinnedImageVersion', () => {
  // fails-when: it reports a version for an image the record does not hold,
  // which resolveImageRef pins to the moving :latest tag instead.
  it('returns the release the record pins the image at', () => {
    const file = fixture({
      version: '0.1.15',
      images: { 'kici-orchestrator': 'sha256:' + 'a'.repeat(64) },
    });
    expect(pinnedImageVersion('kici-orchestrator', { filePath: file })).toBe('0.1.15');
  });

  it('returns null when the record lacks the image', () => {
    const file = fixture({ version: '0.1.15', images: {} });
    expect(pinnedImageVersion('kici-agent', { filePath: file })).toBeNull();
  });

  it('returns null when no record file is found', () => {
    expect(
      pinnedImageVersion('kici-orchestrator', {
        filePath: '/nonexistent/installer-image-digests.json',
      }),
    ).toBeNull();
  });

  it('returns null when the record file is corrupt', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'kici-imgdig-'));
    const file = path.join(dir, 'installer-image-digests.json');
    writeFileSync(file, 'not json{');
    expect(pinnedImageVersion('kici-orchestrator', { filePath: file })).toBeNull();
  });
});
