import { describe, it, expect } from 'vitest';
import {
  KICI_RUNTIME_MOUNT,
  KICI_RUNTIME_NODE,
  runnerLaunchArgv,
  resolveRuntimeSource,
} from './kici-runtime.js';

describe('kici-runtime', () => {
  it('mounts at /opt/kici and launches via the injected node', () => {
    expect(KICI_RUNTIME_MOUNT).toBe('/opt/kici');
    expect(runnerLaunchArgv('/opt/kici/workflow-runner.js')).toEqual([
      '/opt/kici/node/bin/node',
      '/opt/kici/workflow-runner.js',
    ]);
  });

  it('never launches via the image’s own node', () => {
    // The customer image need not ship Node, so the argv is absolute and rooted
    // in the mount, never a bare `node` from the image's PATH.
    const [exe] = runnerLaunchArgv('/opt/kici/workflow-runner.js');
    expect(exe).toBe(KICI_RUNTIME_NODE);
    expect(exe.startsWith(`${KICI_RUNTIME_MOUNT}/`)).toBe(true);
    expect(exe).not.toBe('node');
  });

  it('describes the runtime source per architecture', () => {
    const x64 = resolveRuntimeSource('x64');
    expect(x64.mountPath).toBe('/opt/kici');
    expect(x64.readOnly).toBe(true);
    expect(x64.sourceImagePath).toBe('/opt/kici');

    const arm = resolveRuntimeSource('arm64');
    expect(arm).toEqual({ ...x64, arch: 'arm64' });
  });

  it('refuses an architecture the published runtime does not cover', () => {
    // Rather than an x64 runtime failing in an arm64 container with `exec format error` mid-job.
    expect(() => resolveRuntimeSource('mips64' as never)).toThrow(/unsupported/i);
  });
});
