import { describe, it, expect } from 'vitest';
import { validateRequiredTools, type ToolRequirement } from './tool-check.js';
import { writeFileSync, unlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

describe('validateRequiredTools', () => {
  it('returns empty array when all path binaries exist', () => {
    const reqs: ToolRequirement[] = [
      { type: 'path-binary', name: 'node', reason: 'test' },
      { type: 'path-binary', name: 'git', reason: 'test' },
    ];
    expect(validateRequiredTools(reqs)).toEqual([]);
  });

  it('returns error for missing path binary', () => {
    const reqs: ToolRequirement[] = [
      { type: 'path-binary', name: 'nonexistent-binary-xyz-123', reason: 'needed for testing' },
    ];
    const errors = validateRequiredTools(reqs);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('nonexistent-binary-xyz-123');
    expect(errors[0]).toContain('needed for testing');
  });

  it('collects multiple errors (not fail-on-first)', () => {
    const reqs: ToolRequirement[] = [
      { type: 'path-binary', name: 'missing-tool-aaa', reason: 'reason a' },
      { type: 'path-binary', name: 'missing-tool-bbb', reason: 'reason b' },
    ];
    const errors = validateRequiredTools(reqs);
    expect(errors).toHaveLength(2);
  });

  it('deduplicates identical path-binary requirements', () => {
    const reqs: ToolRequirement[] = [
      { type: 'path-binary', name: 'missing-tool-ccc', reason: 'from scaler A' },
      { type: 'path-binary', name: 'missing-tool-ccc', reason: 'from scaler B' },
    ];
    const errors = validateRequiredTools(reqs);
    // Only one error even though it was listed twice
    expect(errors).toHaveLength(1);
  });

  it('validates file-access readable for existing file', () => {
    const tmpFile = join(tmpdir(), `kici-tool-check-${randomUUID()}.tmp`);
    writeFileSync(tmpFile, 'test');
    try {
      const reqs: ToolRequirement[] = [
        { type: 'file-access', path: tmpFile, mode: 'readable', reason: 'test file' },
      ];
      expect(validateRequiredTools(reqs)).toEqual([]);
    } finally {
      unlinkSync(tmpFile);
    }
  });

  it('returns error for non-existent file', () => {
    const reqs: ToolRequirement[] = [
      {
        type: 'file-access',
        path: '/nonexistent/path/to/binary',
        mode: 'executable',
        reason: 'agent binary',
      },
    ];
    const errors = validateRequiredTools(reqs);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('/nonexistent/path/to/binary');
    expect(errors[0]).toContain('executable');
  });

  it('validates file-access executable', () => {
    const tmpFile = join(tmpdir(), `kici-tool-check-exec-${randomUUID()}.tmp`);
    writeFileSync(tmpFile, '#!/bin/sh\necho ok');
    chmodSync(tmpFile, 0o755);
    try {
      const reqs: ToolRequirement[] = [
        { type: 'file-access', path: tmpFile, mode: 'executable', reason: 'test' },
      ];
      expect(validateRequiredTools(reqs)).toEqual([]);
    } finally {
      unlinkSync(tmpFile);
    }
  });

  it('deduplicates identical file-access requirements', () => {
    const reqs: ToolRequirement[] = [
      {
        type: 'file-access',
        path: '/nonexistent/binary',
        mode: 'executable',
        reason: 'scaler A',
      },
      {
        type: 'file-access',
        path: '/nonexistent/binary',
        mode: 'executable',
        reason: 'scaler B',
      },
    ];
    const errors = validateRequiredTools(reqs);
    expect(errors).toHaveLength(1);
  });

  it('mixes path-binary and file-access checks', () => {
    const reqs: ToolRequirement[] = [
      { type: 'path-binary', name: 'node', reason: 'exists' },
      { type: 'path-binary', name: 'missing-xyz', reason: 'does not exist' },
      {
        type: 'file-access',
        path: '/nonexistent/file',
        mode: 'readable',
        reason: 'missing file',
      },
    ];
    const errors = validateRequiredTools(reqs);
    expect(errors).toHaveLength(2);
  });

  it('returns empty array for empty requirements list', () => {
    expect(validateRequiredTools([])).toEqual([]);
  });

  describe('any-path-binary (alternatives)', () => {
    it('passes when at least one alternative is on PATH', () => {
      const reqs: ToolRequirement[] = [
        { type: 'any-path-binary', names: ['node', 'missing-xyz-1'], reason: 'a runtime' },
      ];
      expect(validateRequiredTools(reqs)).toEqual([]);
    });

    it('errors when none of the alternatives are on PATH', () => {
      const reqs: ToolRequirement[] = [
        {
          type: 'any-path-binary',
          names: ['docker', 'podman'],
          reason: 'a container runtime is required for the container scaler',
        },
      ];
      // Replace process.env.PATH so neither docker nor podman resolves.
      const originalPath = process.env.PATH;
      process.env.PATH = join(tmpdir(), `kici-empty-path-${randomUUID()}`);
      try {
        const errors = validateRequiredTools(reqs);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain('docker');
        expect(errors[0]).toContain('podman');
        expect(errors[0]).toContain('a container runtime is required');
      } finally {
        process.env.PATH = originalPath;
      }
    });

    it('deduplicates identical any-path-binary requirements', () => {
      const originalPath = process.env.PATH;
      process.env.PATH = join(tmpdir(), `kici-empty-path-${randomUUID()}`);
      try {
        const reqs: ToolRequirement[] = [
          { type: 'any-path-binary', names: ['docker', 'podman'], reason: 'scaler A' },
          { type: 'any-path-binary', names: ['docker', 'podman'], reason: 'scaler B' },
        ];
        expect(validateRequiredTools(reqs)).toHaveLength(1);
      } finally {
        process.env.PATH = originalPath;
      }
    });
  });
});
