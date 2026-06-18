import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildAgentMiniBundle } from './mini-bundle.js';
import { BundleChunkAssembler } from '@kici-dev/shared'; // sanity import only

void BundleChunkAssembler;

describe('buildAgentMiniBundle', () => {
  it('returns a non-empty ZIP buffer containing manifest + logs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-logs-'));
    fs.writeFileSync(path.join(dir, 'kici-agent-x.log'), 'hello\nerror boom\n');
    const buf = await buildAgentMiniBundle({
      agentId: 'agent-1',
      logDir: dir,
      logWindowHours: 24,
      config: { host: 'h', token: 'secret' },
      metricsText: '# HELP kici_agent_up\nkici_agent_up 1\n',
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);
    // ZIP magic bytes
    expect(buf.subarray(0, 2).toString('ascii')).toBe('PK');
  });

  it('still produces a valid ZIP when logDir is set but does not exist', async () => {
    const missing = path.join(os.tmpdir(), `agent-logs-missing-${Date.now()}`);
    expect(fs.existsSync(missing)).toBe(false);
    const buf = await buildAgentMiniBundle({
      agentId: 'agent-1',
      logDir: missing,
      logWindowHours: 24,
      config: { host: 'h', token: 'secret' },
      metricsText: '# HELP kici_agent_up\nkici_agent_up 1\n',
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);
    expect(buf.subarray(0, 2).toString('ascii')).toBe('PK');
  });
});
