import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { installerImageName, pinnedImageVersion, resolveImageRef } from './image-digests.js';

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
