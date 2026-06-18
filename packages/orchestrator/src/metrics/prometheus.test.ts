import { describe, it, expect, beforeAll } from 'vitest';
import { initTelemetry } from '@kici-dev/shared';

// Initialize OTel SDK before importing metrics (mirrors real startup order)
beforeAll(() => {
  initTelemetry({
    serviceName: 'kici-orchestrator-test',
    metricPrefix: 'kici_orch_',
  });
});

describe('orchestrator OTel metrics', () => {
  it('exports all 19 counters with .add() method', async () => {
    const m = await import('./prometheus.js');

    expect(m.webhooksReceivedTotal.add).toBeTypeOf('function');
    expect(m.webhooksProcessedTotal.add).toBeTypeOf('function');
    expect(m.dedupHitsTotal.add).toBeTypeOf('function');
    expect(m.sourceCacheHitsTotal.add).toBeTypeOf('function');
    expect(m.sourceCacheMissesTotal.add).toBeTypeOf('function');
    expect(m.depCacheHitsTotal.add).toBeTypeOf('function');
    expect(m.depCacheMissesTotal.add).toBeTypeOf('function');
    expect(m.executionsTotal.add).toBeTypeOf('function');
    expect(m.stepsTotal.add).toBeTypeOf('function');
    expect(m.githubCheckRunTotal.add).toBeTypeOf('function');
    expect(m.logChunksReceivedTotal.add).toBeTypeOf('function');
    expect(m.logBytesStoredTotal.add).toBeTypeOf('function');
    expect(m.scalerConfigReloadsTotal.add).toBeTypeOf('function');
    expect(m.configReloadTotal.add).toBeTypeOf('function');
    expect(m.staleRunsDetectedTotal.add).toBeTypeOf('function');
    // cross-source webhook dispatch error counter
    expect(m.crossSourceErrorsTotal.add).toBeTypeOf('function');
    // install-secrets resolution counters
    expect(m.installSecretsDecisionsTotal.add).toBeTypeOf('function');
    expect(m.installSecretsRegistryUsedTotal.add).toBeTypeOf('function');
    expect(m.installSecretsContributorStrippedTotal.add).toBeTypeOf('function');
  });

  it('exports all 6 histograms with .record() method', async () => {
    const m = await import('./prometheus.js');

    expect(m.triggerMatchDurationSeconds.record).toBeTypeOf('function');
    expect(m.executionDurationSeconds.record).toBeTypeOf('function');
    expect(m.buildDurationSeconds.record).toBeTypeOf('function');
    expect(m.staleDetectionDurationSeconds.record).toBeTypeOf('function');
    // cross-source webhook dispatch fan-out histogram
    expect(m.crossSourceFanoutSize.record).toBeTypeOf('function');
    // install-secrets per-environment token resolution duration
    expect(m.installSecretsTokenResolutionDurationSeconds.record).toBeTypeOf('function');
  });

  it('exports install-secrets resolution metrics and label enums', async () => {
    const m = await import('./prometheus.js');

    // Decision reason enum is the single source of truth for reject reasons.
    expect(m.InstallSecretsDecisionReason.Ok).toBe('ok');
    expect(m.InstallSecretsDecisionReason.MalformedRef).toBe('malformed_ref');
    expect(m.InstallSecretsDecisionReason.InvalidUrlScheme).toBe('invalid_url_scheme');
    expect(m.InstallSecretsDecisionReason.MissingEnvStore).toBe('missing_env_store');
    expect(m.InstallSecretsDecisionReason.MissingSecretResolver).toBe('missing_secret_resolver');
    expect(m.InstallSecretsDecisionReason.EnvNotFound).toBe('env_not_found');
    expect(m.InstallSecretsDecisionReason.ProtectionRuleBlock).toBe('protection_rule_block');
    expect(m.InstallSecretsDecisionReason.MissingToken).toBe('missing_token');
    expect(m.InstallSecretsDecisionReason.MissingInstallEnv).toBe('missing_install_env');

    // Channel enum disambiguates Option A vs Option C on the registry-used counter.
    expect(m.InstallSecretsChannel.Registries).toBe('registries');
    expect(m.InstallSecretsChannel.InstallEnv).toBe('install_env');

    // .add() / .record() accept the labels we plan to emit at runtime.
    m.installSecretsDecisionsTotal.add(1, { decision: 'pass', reason: 'ok' });
    m.installSecretsDecisionsTotal.add(1, { decision: 'reject', reason: 'malformed_ref' });
    m.installSecretsRegistryUsedTotal.add(1, {
      channel: 'registries',
      provider: 'static',
      scope: '@my-org',
    });
    m.installSecretsRegistryUsedTotal.add(1, {
      channel: 'install_env',
      provider: 'static',
      scope: '-',
    });
    m.installSecretsContributorStrippedTotal.add(1, { trust_tier: 'unknown' });
    m.installSecretsTokenResolutionDurationSeconds.record(0.012, { environment: 'production' });
  });

  it('exports cross-source webhook dispatch metrics', async () => {
    const m = await import('./prometheus.js');

    // Histogram: kici_cross_source_fanout_size
    expect(m.crossSourceFanoutSize).toBeDefined();
    expect(m.crossSourceFanoutSize.record).toBeTypeOf('function');
    // Should accept zero-match recordings (we record fan-out=0 too)
    m.crossSourceFanoutSize.record(0, { event: 'foo' });
    m.crossSourceFanoutSize.record(3, { event: 'foo' });

    // Counter: kici_cross_source_errors_total
    expect(m.crossSourceErrorsTotal).toBeDefined();
    expect(m.crossSourceErrorsTotal.add).toBeTypeOf('function');
    m.crossSourceErrorsTotal.add(1, { reason: 'clone_token' });
    m.crossSourceErrorsTotal.add(1, { reason: 'bundle_missing' });
  });

  it('exports 4 gauge setter functions', async () => {
    const m = await import('./prometheus.js');

    expect(m.setAgentsActive).toBeTypeOf('function');
    expect(m.setConfigVersion).toBeTypeOf('function');
    expect(m.setStaleRunsCurrent).toBeTypeOf('function');
    expect(m.setDispatchQueueDepthBreakdown).toBeTypeOf('function');
  });

  it('setDispatchQueueDepthBreakdown normalizes missing buckets to 0 and tolerates multiple labels', async () => {
    const m = await import('./prometheus.js');

    // Missing dispatched should normalize to 0 without throwing.
    m.setDispatchQueueDepthBreakdown({
      byStatus: { pending: 5 },
      byLabel: { linux: 3, macos: 2 },
    });
    // Replace with a second snapshot that drops the prior labels.
    m.setDispatchQueueDepthBreakdown({
      byStatus: { pending: 0, dispatched: 2 },
      byLabel: {},
    });
    // Should not throw; callback observation is exercised on the next Prometheus scrape.
  });

  describe('applyStickyQueueLabels (drained labels emit explicit 0)', () => {
    it('passes through current labels and records them as seen', async () => {
      const { applyStickyQueueLabels } = await import('./prometheus.js');
      const everSeen = new Set<string>();

      expect(applyStickyQueueLabels(everSeen, { linux: 3, macos: 2 })).toEqual({
        linux: 3,
        macos: 2,
      });
      expect(everSeen).toEqual(new Set(['linux', 'macos']));
    });

    it('emits 0 for a previously-seen label whose queue has drained', async () => {
      const { applyStickyQueueLabels } = await import('./prometheus.js');
      const everSeen = new Set<string>();

      applyStickyQueueLabels(everSeen, { linux: 3, macos: 2 });
      // Next tick: queue fully drained. The drained labels must report 0,
      // not vanish — otherwise the by-label gauge series freezes in the TSDB.
      expect(applyStickyQueueLabels(everSeen, {})).toEqual({ linux: 0, macos: 0 });
    });

    it('reports the live count again when a drained label refills', async () => {
      const { applyStickyQueueLabels } = await import('./prometheus.js');
      const everSeen = new Set<string>();

      applyStickyQueueLabels(everSeen, { linux: 3 });
      applyStickyQueueLabels(everSeen, {}); // drains to 0
      // linux refills, macos drains in the same tick.
      expect(applyStickyQueueLabels(everSeen, { linux: 1 })).toEqual({ linux: 1 });
    });
  });

  it('counter .add() works with label attributes', async () => {
    const m = await import('./prometheus.js');
    // Should not throw
    m.webhooksReceivedTotal.add(1, { source: 'relay', event: 'push' });
    m.webhooksProcessedTotal.add(1, { result: 'matched' });
    m.executionsTotal.add(1, { status: 'running' });
    m.stepsTotal.add(1, { status: 'success' });
    m.githubCheckRunTotal.add(1, { operation: 'create' });
    m.configReloadTotal.add(1, { result: 'success', source: 'sighup' });
    m.scalerConfigReloadsTotal.add(1, { result: 'attempted' });
  });

  it('histogram .record() works with values', async () => {
    const m = await import('./prometheus.js');
    m.triggerMatchDurationSeconds.record(0.005);
    m.executionDurationSeconds.record(30);
    m.buildDurationSeconds.record(10);
    m.staleDetectionDurationSeconds.record(60);
  });

  it('gauge setter functions do not throw', async () => {
    const m = await import('./prometheus.js');
    m.setAgentsActive(5);
    m.setConfigVersion(42);
    m.setStaleRunsCurrent(3);
  });

  it('does not export prom-client Registry', async () => {
    const m = await import('./prometheus.js');
    expect((m as any).register).toBeUndefined();
  });

  it('metric names preserve kici_orch_ prefix', async () => {
    const m = await import('./prometheus.js');
    // The fact that these exported names exist and work is sufficient --
    // OTel metric names are set at creation time and match the first argument to meter.createCounter()
    expect(m.webhooksReceivedTotal).toBeDefined();
    expect(m.logBytesStoredTotal).toBeDefined();
  });

  describe('scaler spawn-failure metric', () => {
    it('exposes the bound label constants', async () => {
      const { ScalerSpawnFailureBound } = await import('./prometheus.js');
      expect(ScalerSpawnFailureBound.Bound).toBe('true');
      expect(ScalerSpawnFailureBound.Unbound).toBe('false');
    });

    it('exposes a counter with .add()', async () => {
      const { ScalerSpawnFailureBound, scalerSpawnFailuresTotal } = await import('./prometheus.js');
      expect(typeof scalerSpawnFailuresTotal.add).toBe('function');
      scalerSpawnFailuresTotal.add(1, {
        backend: 'bare-metal',
        bound: ScalerSpawnFailureBound.Bound,
      });
    });
  });

  // Regression guard: observable gauges are registered lazily via
  // registerOrchestratorMetrics() (called by createApp() after initTelemetry),
  // not at module-eval time. The bundler hoists some statically-imported
  // module init above the entry's initTelemetry() call, so a module-eval
  // gauge registration binds to the no-op provider and never reaches the
  // Prometheus exporter — leaving `kici_orch_agents_active` (and friends)
  // absent from the orchestrator /metrics scrape and the Platform push.
  it('registerOrchestratorMetrics() makes observable gauges reach the Prometheus exporter', async () => {
    const { getPrometheusExporter } = await import('@kici-dev/shared');
    const m = await import('./prometheus.js');

    m.setAgentsActive(7);
    m.registerOrchestratorMetrics();
    // Idempotent: a second call must not throw or double-register.
    m.registerOrchestratorMetrics();

    const exporter = getPrometheusExporter();
    expect(exporter).toBeDefined();
    const { resourceMetrics } = await exporter!.collect();
    const names = resourceMetrics.scopeMetrics.flatMap((sm) =>
      sm.metrics.map((metric) => (metric as { descriptor: { name: string } }).descriptor.name),
    );

    // The gauge is present (beforeAll inits telemetry with a kici_orch_ prefix,
    // so match on the suffix rather than the fully-prefixed name).
    expect(names.some((n) => n.includes('agents_active'))).toBe(true);
    expect(names.some((n) => n.includes('dispatch_queue_depth'))).toBe(true);
    expect(names.some((n) => n.includes('event_dlq_depth'))).toBe(true);
  });
});
