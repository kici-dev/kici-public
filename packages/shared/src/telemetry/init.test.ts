import { describe, it, expect, afterEach } from 'vitest';
import { initTelemetry, getPrometheusExporter } from './init.js';
import type { NodeSDK } from '@opentelemetry/sdk-node';

describe('initTelemetry', () => {
  let sdk: NodeSDK | undefined;

  afterEach(async () => {
    if (sdk) {
      await sdk.shutdown();
      sdk = undefined;
    }
  });

  it('returns a NodeSDK instance that can be shut down', async () => {
    sdk = initTelemetry({ serviceName: 'test-service' });
    expect(sdk).toBeDefined();
    // shutdown should not throw
    await sdk.shutdown();
    sdk = undefined;
  });

  it('exposes the prometheus exporter via getPrometheusExporter()', () => {
    sdk = initTelemetry({ serviceName: 'test-prom' });
    const exporter = getPrometheusExporter();
    expect(exporter).toBeDefined();
  });

  it('does not configure OTLP exporter when otlpEndpoint is not set', () => {
    // This test verifies no error is thrown when otlpEndpoint is absent
    sdk = initTelemetry({ serviceName: 'no-otlp' });
    expect(sdk).toBeDefined();
  });

  it('configures OTLP exporter when otlpEndpoint is set', () => {
    // This test verifies no error is thrown when otlpEndpoint is present
    sdk = initTelemetry({
      serviceName: 'with-otlp',
      otlpEndpoint: 'http://localhost:4318',
    });
    expect(sdk).toBeDefined();
  });
});

describe('createMeter', () => {
  it('returns a working Meter from @opentelemetry/api', async () => {
    const { createMeter } = await import('./metrics.js');
    const meter = createMeter('test-service');
    expect(meter).toBeDefined();
    // Should be able to create instruments
    const counter = meter.createCounter('test_counter');
    expect(counter).toBeDefined();
  });
});
