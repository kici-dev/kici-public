import { describe, it, expect } from 'vitest';
import { KICI_RUNTIME_DOCKER_LABEL } from './container-routing.js';

describe('KICI_RUNTIME_DOCKER_LABEL', () => {
  it('follows the kici:<facet>:<value> shape of the other auto-labels', () => {
    expect(KICI_RUNTIME_DOCKER_LABEL).toMatch(/^kici:[a-z]+:[a-z]+$/);
  });
});
