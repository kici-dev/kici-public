import { describe, it, expect } from 'vitest';
import { composeFilePath } from './compose-path.js';

describe('composeFilePath', () => {
  it('places the compose file beside the env file, named for the service', () => {
    expect(composeFilePath('/etc/kici/orch1.env', 'orch1')).toBe('/etc/kici/orch1-compose.yaml');
  });

  it('uses the service name, not the env file name', () => {
    expect(composeFilePath('/etc/kici/custom.env', 'orch1')).toBe('/etc/kici/orch1-compose.yaml');
  });
});
