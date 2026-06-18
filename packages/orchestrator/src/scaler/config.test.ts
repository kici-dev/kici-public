import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  loadScalerConfig,
  parseMemoryString,
  scalerFileSchema,
  firecrackerNetworkSchema,
  networkPolicySchema,
} from './config.js';

/** Create a temp directory for test config files */
async function createTmpDir(): Promise<string> {
  const dir = join(tmpdir(), `kici-scaler-test-${randomUUID().slice(0, 8)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Write YAML string to a file in the given directory */
async function writeYaml(dir: string, filename: string, content: string): Promise<string> {
  const filepath = join(dir, filename);
  await writeFile(filepath, content, 'utf-8');
  return filepath;
}

describe('scalerFileSchema', () => {
  it('validates a minimal container scaler config', () => {
    const config = {
      version: 1,
      scalers: [
        {
          name: 'container-linux',
          type: 'container',
          maxAgents: 10,
          labelSets: [{ labels: ['linux', 'docker'], image: 'ghcr.io/my/agent:latest' }],
        },
      ],
    };

    const result = scalerFileSchema.parse(config);
    expect(result.version).toBe(1);
    expect(result.globalMaxAgents).toBe(50); // default
    expect(result.scalers).toHaveLength(1);
    expect(result.scalers[0].name).toBe('container-linux');
    expect(result.scalers[0].type).toBe('container');
    expect(result.scalers[0].labelSets[0].containerSocket).toBe(false); // default
  });

  it('validates config with two scalers (container + bare-metal)', () => {
    const config = {
      version: 1,
      globalMaxAgents: 30,
      defaults: { resources: { memory: '2g', cpus: 2 } },
      scalers: [
        {
          name: 'container-linux',
          type: 'container',
          maxAgents: 20,
          labelSets: [
            {
              labels: ['linux', 'docker'],
              image: 'ghcr.io/my/agent:latest',
              resources: { memory: '4g', cpus: 4 },
              containerSocket: true,
            },
          ],
        },
        {
          name: 'bare-metal-gpu',
          type: 'bare-metal',
          maxAgents: 3,
          labelSets: [
            {
              labels: ['linux', 'gpu'],
              binaryPath: '/opt/kici/kici-agent',
              resources: { memory: '16g', cpus: 8 },
            },
          ],
        },
      ],
    };

    const result = scalerFileSchema.parse(config);
    expect(result.scalers).toHaveLength(2);
    expect(result.scalers[0].type).toBe('container');
    expect(result.scalers[1].type).toBe('bare-metal');
    expect(result.globalMaxAgents).toBe(30);
  });

  it('rejects removed cleanable/cleanupScript fields', () => {
    const config = {
      version: 1,
      scalers: [
        {
          name: 'test',
          type: 'container',
          maxAgents: 1,
          cleanable: true,
          cleanupScript: '/opt/cleanup.sh',
          labelSets: [{ labels: ['linux'], image: 'test:latest' }],
        },
      ],
    };

    expect(() => scalerFileSchema.parse(config)).toThrow(/unrecognized_keys/);
  });

  it('rejects missing version', () => {
    const config = {
      scalers: [
        {
          name: 'test',
          type: 'container',
          maxAgents: 1,
          labelSets: [{ labels: ['linux'], image: 'test:latest' }],
        },
      ],
    };

    expect(() => scalerFileSchema.parse(config)).toThrow();
  });

  it('rejects container scaler without image in label set', () => {
    const config = {
      version: 1,
      scalers: [
        {
          name: 'container-missing-image',
          type: 'container',
          maxAgents: 5,
          labelSets: [{ labels: ['linux'] }],
        },
      ],
    };

    expect(() => scalerFileSchema.parse(config)).toThrow(/requires an 'image' field/);
  });

  it('rejects bare-metal scaler without binaryPath', () => {
    const config = {
      version: 1,
      scalers: [
        {
          name: 'bare-metal-missing-path',
          type: 'bare-metal',
          maxAgents: 2,
          labelSets: [{ labels: ['linux'] }],
        },
      ],
    };

    expect(() => scalerFileSchema.parse(config)).toThrow(/requires a 'binaryPath' field/);
  });

  it('validates globalMaxAgents must be positive', () => {
    const config = {
      version: 1,
      globalMaxAgents: 0,
      scalers: [
        {
          name: 'test',
          type: 'container',
          maxAgents: 1,
          labelSets: [{ labels: ['linux'], image: 'test:latest' }],
        },
      ],
    };

    expect(() => scalerFileSchema.parse(config)).toThrow();
  });

  it('preserves backpressureMode in label set config', () => {
    const config = {
      version: 1,
      scalers: [
        {
          name: 'container-bp',
          type: 'container',
          maxAgents: 5,
          labelSets: [{ labels: ['linux'], image: 'test:latest', backpressureMode: 'drop' }],
        },
      ],
    };

    const result = scalerFileSchema.parse(config);
    expect(result.scalers[0].labelSets[0].backpressureMode).toBe('drop');
  });

  it('accepts backpressureMode pause', () => {
    const config = {
      version: 1,
      scalers: [
        {
          name: 'container-bp',
          type: 'container',
          maxAgents: 5,
          labelSets: [{ labels: ['linux'], image: 'test:latest', backpressureMode: 'pause' }],
        },
      ],
    };

    const result = scalerFileSchema.parse(config);
    expect(result.scalers[0].labelSets[0].backpressureMode).toBe('pause');
  });

  it('rejects invalid backpressureMode', () => {
    const config = {
      version: 1,
      scalers: [
        {
          name: 'container-bp',
          type: 'container',
          maxAgents: 5,
          labelSets: [{ labels: ['linux'], image: 'test:latest', backpressureMode: 'invalid' }],
        },
      ],
    };

    expect(() => scalerFileSchema.parse(config)).toThrow();
  });

  it('validates warmPool defaults', () => {
    const config = {
      version: 1,
      scalers: [
        {
          name: 'container-warm',
          type: 'container',
          maxAgents: 10,
          labelSets: [{ labels: ['linux'], image: 'test:latest' }],
          warmPool: { enabled: true },
        },
      ],
    };

    const result = scalerFileSchema.parse(config);
    expect(result.scalers[0].warmPool).toEqual({
      enabled: true,
      size: 0,
      idleTimeoutSeconds: 300,
    });
  });

  it('validates a valid Firecracker scaler config', () => {
    const config = {
      version: 1,
      scalers: [
        {
          name: 'firecracker-linux',
          type: 'firecracker',
          maxAgents: 20,
          firecrackerPath: '/usr/bin/firecracker',
          jailerPath: '/usr/bin/jailer',
          kernelPath: '/opt/kici/vmlinux',
          uid: 1000,
          gid: 1000,
          labelSets: [
            {
              labels: ['linux', 'firecracker'],
              rootfsPath: '/opt/kici/rootfs-amd64.ext4',
            },
          ],
        },
      ],
      firecracker: {
        cidr: '10.0.0.0/24',
      },
    };

    const result = scalerFileSchema.parse(config);
    expect(result.scalers).toHaveLength(1);
    expect(result.scalers[0].type).toBe('firecracker');
    expect(result.scalers[0].firecrackerPath).toBe('/usr/bin/firecracker');
    expect(result.scalers[0].chrootBaseDir).toBe('/srv/jailer'); // default
    expect(result.scalers[0].vcpuCount).toBe(2); // default
    expect(result.scalers[0].memSizeMib).toBe(512); // default
    expect(result.firecracker?.cidr).toBe('10.0.0.0/24');
  });

  it('rejects Firecracker scaler missing rootfsPath on label set', () => {
    const config = {
      version: 1,
      scalers: [
        {
          name: 'fc-missing-rootfs',
          type: 'firecracker',
          maxAgents: 5,
          firecrackerPath: '/usr/bin/firecracker',
          jailerPath: '/usr/bin/jailer',
          kernelPath: '/opt/kici/vmlinux',
          uid: 1000,
          gid: 1000,
          labelSets: [{ labels: ['linux'] }],
        },
      ],
    };

    expect(() => scalerFileSchema.parse(config)).toThrow(/requires a 'rootfsPath' field/);
  });

  it('rejects Firecracker scaler missing firecrackerPath', () => {
    const config = {
      version: 1,
      scalers: [
        {
          name: 'fc-missing-binary',
          type: 'firecracker',
          maxAgents: 5,
          jailerPath: '/usr/bin/jailer',
          kernelPath: '/opt/kici/vmlinux',
          uid: 1000,
          gid: 1000,
          labelSets: [{ labels: ['linux'], rootfsPath: '/opt/kici/rootfs.ext4' }],
        },
      ],
    };

    expect(() => scalerFileSchema.parse(config)).toThrow(/requires a 'firecrackerPath' field/);
  });

  it('rejects Firecracker scaler missing jailerPath', () => {
    const config = {
      version: 1,
      scalers: [
        {
          name: 'fc-missing-jailer',
          type: 'firecracker',
          maxAgents: 5,
          firecrackerPath: '/usr/bin/firecracker',
          kernelPath: '/opt/kici/vmlinux',
          uid: 1000,
          gid: 1000,
          labelSets: [{ labels: ['linux'], rootfsPath: '/opt/kici/rootfs.ext4' }],
        },
      ],
    };

    expect(() => scalerFileSchema.parse(config)).toThrow(/requires a 'jailerPath' field/);
  });

  it('rejects Firecracker scaler missing kernelPath', () => {
    const config = {
      version: 1,
      scalers: [
        {
          name: 'fc-missing-kernel',
          type: 'firecracker',
          maxAgents: 5,
          firecrackerPath: '/usr/bin/firecracker',
          jailerPath: '/usr/bin/jailer',
          uid: 1000,
          gid: 1000,
          labelSets: [{ labels: ['linux'], rootfsPath: '/opt/kici/rootfs.ext4' }],
        },
      ],
    };

    expect(() => scalerFileSchema.parse(config)).toThrow(/requires a 'kernelPath' field/);
  });

  it('rejects Firecracker scaler missing uid and gid', () => {
    const config = {
      version: 1,
      scalers: [
        {
          name: 'fc-missing-uid-gid',
          type: 'firecracker',
          maxAgents: 5,
          firecrackerPath: '/usr/bin/firecracker',
          jailerPath: '/usr/bin/jailer',
          kernelPath: '/opt/kici/vmlinux',
          labelSets: [{ labels: ['linux'], rootfsPath: '/opt/kici/rootfs.ext4' }],
        },
      ],
    };

    expect(() => scalerFileSchema.parse(config)).toThrow(/requires a 'uid' field/);
  });

  it('validates Firecracker network config with defaults', () => {
    const result = firecrackerNetworkSchema.parse({});
    expect(result).toEqual({
      cidr: '10.0.0.0/24',
      bridgeName: 'kici-br0',
      gateway: '10.0.0.1',
      netmask: '255.255.255.0',
      table: 'kici',
    });
  });

  it('validates Firecracker network config with custom values', () => {
    const result = firecrackerNetworkSchema.parse({
      cidr: '192.168.100.0/24',
      bridgeName: 'my-bridge',
      gateway: '192.168.100.1',
      netmask: '255.255.255.0',
    });
    expect(result.cidr).toBe('192.168.100.0/24');
    expect(result.bridgeName).toBe('my-bridge');
    expect(result.gateway).toBe('192.168.100.1');
  });

  it('rejects old "docker" type name', () => {
    const config = {
      version: 1,
      scalers: [
        {
          name: 'old-docker',
          type: 'docker',
          maxAgents: 5,
          labelSets: [{ labels: ['linux'], image: 'test:latest' }],
        },
      ],
    };

    expect(() => scalerFileSchema.parse(config)).toThrow();
  });

  it('rejects old dockerHost field (strict schema)', () => {
    const config = {
      version: 1,
      scalers: [
        {
          name: 'old-field',
          type: 'container',
          maxAgents: 5,
          dockerHost: 'tcp://192.168.1.10:2376',
          labelSets: [{ labels: ['linux'], image: 'test:latest' }],
        },
      ],
    };

    expect(() => scalerFileSchema.parse(config)).toThrow(/unrecognized_keys/);
  });

  it('rejects old dockerSocket field on label set (strict schema)', () => {
    const config = {
      version: 1,
      scalers: [
        {
          name: 'old-socket',
          type: 'container',
          maxAgents: 5,
          labelSets: [{ labels: ['linux'], image: 'test:latest', dockerSocket: true }],
        },
      ],
    };

    expect(() => scalerFileSchema.parse(config)).toThrow(/unrecognized_keys/);
  });

  it('validates dual-arch Firecracker config (two label sets with different rootfs/kernel)', () => {
    const config = {
      version: 1,
      scalers: [
        {
          name: 'firecracker-multi-arch',
          type: 'firecracker',
          maxAgents: 30,
          firecrackerPath: '/usr/bin/firecracker',
          jailerPath: '/usr/bin/jailer',
          kernelPath: '/opt/kici/vmlinux-amd64',
          uid: 1000,
          gid: 1000,
          vcpuCount: 4,
          memSizeMib: 1024,
          labelSets: [
            {
              labels: ['linux', 'amd64'],
              rootfsPath: '/opt/kici/rootfs-amd64.ext4',
            },
            {
              labels: ['linux', 'arm64'],
              rootfsPath: '/opt/kici/rootfs-arm64.ext4',
              kernelPath: '/opt/kici/Image-arm64',
              vcpuCount: 2,
              memSizeMib: 512,
            },
          ],
        },
      ],
      firecracker: {
        cidr: '10.0.0.0/22',
        bridgeName: 'kici-br0',
        gateway: '10.0.0.1',
        netmask: '255.255.252.0',
      },
    };

    const result = scalerFileSchema.parse(config);
    expect(result.scalers).toHaveLength(1);
    expect(result.scalers[0].labelSets).toHaveLength(2);
    expect(result.scalers[0].labelSets[0].rootfsPath).toBe('/opt/kici/rootfs-amd64.ext4');
    expect(result.scalers[0].labelSets[1].rootfsPath).toBe('/opt/kici/rootfs-arm64.ext4');
    expect(result.scalers[0].labelSets[1].kernelPath).toBe('/opt/kici/Image-arm64');
    expect(result.scalers[0].labelSets[1].vcpuCount).toBe(2);
    expect(result.scalers[0].vcpuCount).toBe(4);
    expect(result.firecracker?.cidr).toBe('10.0.0.0/22');
  });
});

describe('networkPolicySchema', () => {
  it('returns undefined when not provided', () => {
    const result = networkPolicySchema.parse(undefined);
    expect(result).toBeUndefined();
  });

  it('validates a policy with allowlist', () => {
    const result = networkPolicySchema.parse({
      allowlist: ['10.0.1.0/24', '192.168.50.0/24'],
    });
    expect(result?.allowlist).toEqual(['10.0.1.0/24', '192.168.50.0/24']);
    expect(result?.denyAll).toBe(false); // default
  });

  it('validates a denyAll policy', () => {
    const result = networkPolicySchema.parse({ denyAll: true });
    expect(result?.denyAll).toBe(true);
    expect(result?.allowlist).toBeUndefined();
  });

  it('validates a policy with both allowlist and denyAll', () => {
    const result = networkPolicySchema.parse({
      allowlist: ['10.0.1.0/24'],
      denyAll: true,
    });
    expect(result?.allowlist).toEqual(['10.0.1.0/24']);
    expect(result?.denyAll).toBe(true);
  });
});

describe('labelSetConfigSchema with networkPolicy', () => {
  it('accepts a label set with networkPolicy', () => {
    const config = {
      version: 1,
      scalers: [
        {
          name: 'container-isolated',
          type: 'container',
          maxAgents: 5,
          labelSets: [
            {
              labels: ['linux'],
              image: 'test:latest',
              networkPolicy: {
                allowlist: ['10.0.1.0/24'],
                denyAll: false,
              },
            },
          ],
        },
      ],
    };

    const result = scalerFileSchema.parse(config);
    expect(result.scalers[0].labelSets[0].networkPolicy).toEqual({
      allowlist: ['10.0.1.0/24'],
      denyAll: false,
    });
  });

  it('accepts a label set without networkPolicy (optional)', () => {
    const config = {
      version: 1,
      scalers: [
        {
          name: 'container-open',
          type: 'container',
          maxAgents: 5,
          labelSets: [{ labels: ['linux'], image: 'test:latest' }],
        },
      ],
    };

    const result = scalerFileSchema.parse(config);
    expect(result.scalers[0].labelSets[0].networkPolicy).toBeUndefined();
  });
});

describe('roles validation', () => {
  it('parses scaler with no roles field (undefined, backward compat)', () => {
    const config = {
      version: 1,
      scalers: [
        {
          name: 'test',
          type: 'container',
          maxAgents: 5,
          labelSets: [{ labels: ['linux'], image: 'test:latest' }],
        },
      ],
    };
    const result = scalerFileSchema.parse(config);
    expect(result.scalers[0].roles).toBeUndefined();
  });

  it('parses roles: ["builder"] to ["builder"]', () => {
    const config = {
      version: 1,
      scalers: [
        {
          name: 'test',
          type: 'container',
          maxAgents: 5,
          labelSets: [{ labels: ['linux'], image: 'test:latest' }],
          roles: ['builder'],
        },
      ],
    };
    const result = scalerFileSchema.parse(config);
    expect(result.scalers[0].roles).toEqual(['builder']);
  });

  it('parses roles: [] to [] (execution only)', () => {
    const config = {
      version: 1,
      scalers: [
        {
          name: 'test',
          type: 'container',
          maxAgents: 5,
          labelSets: [{ labels: ['linux'], image: 'test:latest' }],
          roles: [],
        },
      ],
    };
    const result = scalerFileSchema.parse(config);
    expect(result.scalers[0].roles).toEqual([]);
  });

  it('normalizes roles: ["builder", "all"] to undefined', () => {
    const config = {
      version: 1,
      scalers: [
        {
          name: 'test',
          type: 'container',
          maxAgents: 5,
          labelSets: [{ labels: ['linux'], image: 'test:latest' }],
          roles: ['builder', 'all'],
        },
      ],
    };
    const result = scalerFileSchema.parse(config);
    expect(result.scalers[0].roles).toBeUndefined();
  });

  it('normalizes roles: ["all"] to undefined', () => {
    const config = {
      version: 1,
      scalers: [
        {
          name: 'test',
          type: 'container',
          maxAgents: 5,
          labelSets: [{ labels: ['linux'], image: 'test:latest' }],
          roles: ['all'],
        },
      ],
    };
    const result = scalerFileSchema.parse(config);
    expect(result.scalers[0].roles).toBeUndefined();
  });

  it('rejects roles: ["unknown"]', () => {
    const config = {
      version: 1,
      scalers: [
        {
          name: 'test',
          type: 'container',
          maxAgents: 5,
          labelSets: [{ labels: ['linux'], image: 'test:latest' }],
          roles: ['unknown'],
        },
      ],
    };
    expect(() => scalerFileSchema.parse(config)).toThrow();
  });

  it('rejects labels with kici: prefix in label sets', () => {
    const config = {
      version: 1,
      scalers: [
        {
          name: 'test',
          type: 'container',
          maxAgents: 5,
          labelSets: [{ labels: ['kici:role:builder'], image: 'test:latest' }],
        },
      ],
    };
    expect(() => scalerFileSchema.parse(config)).toThrow(/kici:/);
  });
});

describe('mandatoryLabels validation', () => {
  it('defaults mandatoryLabels to [] when omitted', () => {
    const config = {
      version: 1,
      scalers: [
        {
          name: 'no-gate',
          type: 'container',
          maxAgents: 5,
          labelSets: [{ labels: ['linux'], image: 'test:latest' }],
        },
      ],
    };
    const result = scalerFileSchema.parse(config);
    expect(result.scalers[0].mandatoryLabels).toEqual([]);
  });

  it('accepts a valid mandatoryLabels list when every label appears in every labelSet', () => {
    const config = {
      version: 1,
      scalers: [
        {
          name: 'gpu-pool',
          type: 'container',
          maxAgents: 5,
          mandatoryLabels: ['gpu'],
          labelSets: [
            { labels: ['linux', 'gpu'], image: 'gpu:latest' },
            { labels: ['linux', 'gpu', 'cuda'], image: 'cuda:latest' },
          ],
        },
      ],
    };
    const result = scalerFileSchema.parse(config);
    expect(result.scalers[0].mandatoryLabels).toEqual(['gpu']);
  });

  it('matches mandatoryLabels case-insensitively against labelSets', () => {
    const config = {
      version: 1,
      scalers: [
        {
          name: 'gpu-pool',
          type: 'container',
          maxAgents: 5,
          mandatoryLabels: ['GPU'],
          labelSets: [{ labels: ['linux', 'gpu'], image: 'gpu:latest' }],
        },
      ],
    };
    expect(() => scalerFileSchema.parse(config)).not.toThrow();
  });

  it('rejects kici: prefixed mandatoryLabels (reserved namespace)', () => {
    const config = {
      version: 1,
      scalers: [
        {
          name: 'bad',
          type: 'container',
          maxAgents: 5,
          mandatoryLabels: ['kici:role:builder'],
          labelSets: [{ labels: ['linux', 'kici:role:builder'], image: 'test:latest' }],
        },
      ],
    };
    expect(() => scalerFileSchema.parse(config)).toThrow(/kici:/);
  });

  it('rejects when mandatory label is missing from any labelSet (gate bypass guard)', () => {
    const config = {
      version: 1,
      scalers: [
        {
          name: 'leaky-gate',
          type: 'container',
          maxAgents: 5,
          mandatoryLabels: ['gpu'],
          labelSets: [
            { labels: ['linux', 'gpu'], image: 'gpu:latest' },
            // 'gpu' missing here — jobs could route through this labelSet
            // and bypass the gate. Schema must reject.
            { labels: ['linux', 'cpu'], image: 'cpu:latest' },
          ],
        },
      ],
    };
    expect(() => scalerFileSchema.parse(config)).toThrow(
      /mandatoryLabel.*gpu.*missing from labelSets/,
    );
  });

  it('reports the offending labelSet index in the error', () => {
    const config = {
      version: 1,
      scalers: [
        {
          name: 'leaky',
          type: 'container',
          maxAgents: 5,
          mandatoryLabels: ['mandatory'],
          labelSets: [
            { labels: ['linux', 'mandatory'], image: 'x:1' },
            { labels: ['linux', 'mandatory'], image: 'x:2' },
            { labels: ['linux'], image: 'x:3' }, // index 2 missing the gate
          ],
        },
      ],
    };
    expect(() => scalerFileSchema.parse(config)).toThrow(/labelSets\[2\]/);
  });
});

describe('loadScalerConfig', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('loads a valid YAML config file', async () => {
    const configPath = await writeYaml(
      tmpDir,
      'scalers.yaml',
      `
version: 1
globalMaxAgents: 25
scalers:
  - name: container-linux
    type: container
    maxAgents: 10
    labelSets:
      - labels: [linux, docker]
        image: "ghcr.io/my/agent:latest"
`,
    );

    const config = await loadScalerConfig(configPath);
    expect(config.version).toBe(1);
    expect(config.globalMaxAgents).toBe(25);
    expect(config.scalers).toHaveLength(1);
    expect(config.scalers[0].name).toBe('container-linux');
  });

  it('merges scalers.d/ directory files', async () => {
    const configPath = await writeYaml(
      tmpDir,
      'scalers.yaml',
      `
version: 1
globalMaxAgents: 50
scalers:
  - name: container-linux
    type: container
    maxAgents: 20
    labelSets:
      - labels: [linux, docker]
        image: "ghcr.io/my/agent:latest"
`,
    );

    const scalersDDir = join(tmpDir, 'scalers.d');
    await mkdir(scalersDDir, { recursive: true });

    await writeYaml(
      scalersDDir,
      '01-gpu.yaml',
      `
scalers:
  - name: bare-metal-gpu
    type: bare-metal
    maxAgents: 3
    labelSets:
      - labels: [linux, gpu]
        binaryPath: "/opt/kici/kici-agent"
`,
    );

    await writeYaml(
      scalersDDir,
      '02-arm.yml',
      `
scalers:
  - name: container-arm
    type: container
    maxAgents: 5
    labelSets:
      - labels: [linux, arm64]
        image: "ghcr.io/my/agent-arm:latest"
`,
    );

    const config = await loadScalerConfig(configPath, scalersDDir);
    expect(config.scalers).toHaveLength(3);
    expect(config.scalers.map((s) => s.name)).toEqual([
      'container-linux',
      'bare-metal-gpu',
      'container-arm',
    ]);
  });

  it('skips non-YAML files in scalers.d/', async () => {
    const configPath = await writeYaml(
      tmpDir,
      'scalers.yaml',
      `
version: 1
scalers:
  - name: main
    type: container
    maxAgents: 5
    labelSets:
      - labels: [linux]
        image: "test:latest"
`,
    );

    const scalersDDir = join(tmpDir, 'scalers.d');
    await mkdir(scalersDDir, { recursive: true });

    // This should be ignored (not .yaml or .yml)
    await writeFile(join(scalersDDir, 'README.md'), '# Not a config');

    const config = await loadScalerConfig(configPath, scalersDDir);
    expect(config.scalers).toHaveLength(1);
  });

  it('rejects invalid YAML config', async () => {
    const configPath = await writeYaml(
      tmpDir,
      'scalers.yaml',
      `
version: 2
scalers: []
`,
    );

    await expect(loadScalerConfig(configPath)).rejects.toThrow();
  });
});

describe('resource caps schema', () => {
  it('accepts globalResourceCap and machinePools and scaler-level resourceCap', () => {
    const config = {
      version: 1,
      globalResourceCap: { maxCpu: 16, maxMemory: '64g' },
      machinePools: [{ name: 'shared-host', cap: { maxCpu: 32, maxMemory: '128g' } }],
      scalers: [
        {
          name: 'c1',
          type: 'container',
          maxAgents: 10,
          resourceCap: { maxCpu: 8, maxMemory: '32g' },
          machinePool: 'shared-host',
          labelSets: [{ labels: ['linux'], image: 'a:latest' }],
        },
      ],
    };
    const result = scalerFileSchema.parse(config);
    expect(result.globalResourceCap?.maxCpu).toBe(16);
    expect(result.globalResourceCap?.maxMemoryBytes).toBe(64 * 1024 ** 3);
    expect(result.machinePools?.[0].cap.maxMemoryBytes).toBe(128 * 1024 ** 3);
    expect(result.scalers[0].resourceCap?.maxCpu).toBe(8);
    expect(result.scalers[0].machinePool).toBe('shared-host');
  });

  it('rejects unknown machinePool reference', () => {
    const config = {
      version: 1,
      machinePools: [{ name: 'a', cap: { maxCpu: 4 } }],
      scalers: [
        {
          name: 'c1',
          type: 'container',
          maxAgents: 10,
          machinePool: 'nope',
          labelSets: [{ labels: ['linux'], image: 'a:latest' }],
        },
      ],
    };
    expect(() => scalerFileSchema.parse(config)).toThrow(/unknown machinePool/);
  });

  it('rejects duplicate machinePool names', () => {
    const config = {
      version: 1,
      machinePools: [
        { name: 'p', cap: { maxCpu: 4 } },
        { name: 'p', cap: { maxCpu: 8 } },
      ],
      scalers: [
        {
          name: 'c1',
          type: 'container',
          maxAgents: 10,
          labelSets: [{ labels: ['linux'], image: 'a:latest' }],
        },
      ],
    };
    expect(() => scalerFileSchema.parse(config)).toThrow(/Duplicate machinePool/);
  });

  it('normalizes flat resources shorthand to nested limits at label-set level', () => {
    const config = {
      version: 1,
      scalers: [
        {
          name: 'c1',
          type: 'container',
          maxAgents: 10,
          labelSets: [
            {
              labels: ['linux'],
              image: 'a:latest',
              resources: { cpus: 2, memory: '4g' },
            },
          ],
        },
      ],
    };
    const result = scalerFileSchema.parse(config);
    expect(result.scalers[0].labelSets[0].resources).toEqual({
      requests: { cpus: 2, memory: '4g' },
      limits: { cpus: 2, memory: '4g' },
    });
  });

  it('accepts nested resources at label-set level', () => {
    const config = {
      version: 1,
      scalers: [
        {
          name: 'c1',
          type: 'container',
          maxAgents: 10,
          labelSets: [
            {
              labels: ['linux'],
              image: 'a:latest',
              resources: {
                requests: { cpus: 1, memory: '1g' },
                limits: { cpus: 2, memory: '4g' },
              },
            },
          ],
        },
      ],
    };
    const result = scalerFileSchema.parse(config);
    expect(result.scalers[0].labelSets[0].resources).toEqual({
      requests: { cpus: 1, memory: '1g' },
      limits: { cpus: 2, memory: '4g' },
    });
  });
});

describe('parseMemoryString', () => {
  it('parses megabytes', () => {
    expect(parseMemoryString('512m')).toBe(536870912);
    expect(parseMemoryString('512M')).toBe(536870912);
  });

  it('parses gigabytes', () => {
    expect(parseMemoryString('2g')).toBe(2147483648);
    expect(parseMemoryString('2G')).toBe(2147483648);
  });

  it('parses kilobytes', () => {
    expect(parseMemoryString('1024k')).toBe(1048576);
    expect(parseMemoryString('1024K')).toBe(1048576);
  });

  it('throws on invalid format', () => {
    expect(() => parseMemoryString('512')).toThrow(/Invalid memory format/);
    expect(() => parseMemoryString('abc')).toThrow(/Invalid memory format/);
    expect(() => parseMemoryString('')).toThrow(/Invalid memory format/);
    expect(() => parseMemoryString('512b')).toThrow(/Invalid memory format/);
  });
});
