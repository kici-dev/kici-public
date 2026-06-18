import { Hono } from 'hono';

export interface MetricsRoutesDeps {
  /** Callback that returns the Prometheus metrics response. */
  getMetrics: () => Promise<{ contentType: string; body: string }>;
}

/**
 * Create Prometheus metrics route.
 *
 * The caller provides a getMetrics callback that returns the content type
 * and body. This decouples the route from any specific metrics library
 * (prom-client, OTel PrometheusExporter, etc.).
 *
 * @param deps - Dependencies (metrics callback)
 * @returns Hono app with /metrics endpoint
 */
export function createMetricsRoutes(deps: MetricsRoutesDeps): Hono {
  const app = new Hono();

  app.get('/metrics', async (c) => {
    const { contentType, body } = await deps.getMetrics();
    // Strip OpenMetrics directives (# UNIT, # EOF) that Prometheus 2.x can't parse.
    // The OTel PrometheusExporter emits these unconditionally with no config to disable them.
    // Also sanitize metric names: OTel uses dots (e.g. nodejs.eventloop.utilization)
    // but Prometheus requires underscores. Replace dots with underscores in metric
    // names on # TYPE, # HELP, and sample lines.
    const filteredBody = body
      .split('\n')
      .filter((line) => !line.startsWith('# UNIT ') && line !== '# EOF')
      .map((line) => {
        if (line.startsWith('# TYPE ') || line.startsWith('# HELP ')) {
          // # TYPE <metric_name> <type>  or  # HELP <metric_name> <text>
          const prefix = line.startsWith('# TYPE ') ? '# TYPE ' : '# HELP ';
          const rest = line.slice(prefix.length);
          const spaceIdx = rest.indexOf(' ');
          if (spaceIdx > 0) {
            const name = rest.slice(0, spaceIdx).replace(/\./g, '_');
            return prefix + name + rest.slice(spaceIdx);
          }
        } else if (line && !line.startsWith('#')) {
          // Sample line: <metric_name>{labels} value  or  <metric_name> value
          const match = line.match(/^([a-zA-Z_:.][a-zA-Z0-9_:.]*)/);
          if (match && match[1].includes('.')) {
            return line.replace(match[1], match[1].replace(/\./g, '_'));
          }
        }
        return line;
      })
      .join('\n');
    // Force standard Prometheus text format content type (not OpenMetrics)
    const safeContentType = contentType.includes('openmetrics')
      ? 'text/plain; version=0.0.4; charset=utf-8'
      : contentType;
    return c.text(filteredBody, 200, {
      'Content-Type': safeContentType,
    });
  });

  return app;
}
