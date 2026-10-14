const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5] as const;

interface Series {
  count: number;
  sum: number;
  buckets: number[];
}

export interface Metrics {
  observe(method: string, route: string, status: number, durationMs: number): void;
  render(): string;
}

const escapeLabel = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

const label = (method: string, route: string, status?: number): string =>
  'method="' +
  escapeLabel(method) +
  '",route="' +
  escapeLabel(route) +
  (status === undefined ? "" : ',status="' + String(status) + '"');

/**
 * Prometheus text exposition backed by in-process counters: enough to answer
 * "which route is slow or erroring" without a metrics dependency. Counters
 * reset on restart.
 */
export const makeMetrics = (): Metrics => {
  const requests = new Map<string, number>();
  const durations = new Map<string, Series>();

  const seriesFor = (key: string): Series => {
    let series = durations.get(key);
    if (series === undefined) {
      series = { count: 0, sum: 0, buckets: Array<number>(BUCKETS.length).fill(0) };
      durations.set(key, series);
    }
    return series;
  };

  return {
    observe: (method, route, status, durationMs) => {
      const requestKey = [method, route, String(status)].join(" ");
      requests.set(requestKey, (requests.get(requestKey) ?? 0) + 1);

      const seconds = durationMs / 1000;
      const series = seriesFor([method, route].join(" "));
      series.count += 1;
      series.sum += seconds;
      BUCKETS.forEach((bound, index) => {
        if (seconds <= bound) series.buckets[index] = (series.buckets[index] ?? 0) + 1;
      });
    },

    render: () => {
      const lines: string[] = [
        "# HELP elaion_http_requests_total Total HTTP requests by method, route and status.",
        "# TYPE elaion_http_requests_total counter",
      ];

      for (const [key, value] of [...requests.entries()].sort()) {
        const [method = "", route = "", status = ""] = key.split(" ");
        lines.push(
          "elaion_http_requests_total{" + label(method, route, Number(status)) + "} " + value,
        );
      }

      lines.push(
        "# HELP elaion_http_request_duration_seconds HTTP request duration in seconds.",
        "# TYPE elaion_http_request_duration_seconds histogram",
      );

      for (const [key, series] of [...durations.entries()].sort()) {
        const [method = "", route = ""] = key.split(" ");
        const seriesLabel = label(method, route);
        BUCKETS.forEach((bound, index) => {
          lines.push(
            "elaion_http_request_duration_seconds_bucket{" +
            seriesLabel +
            ',le="' +
            String(bound) +
            '"} ' +
            (series.buckets[index] ?? 0),
          );
        });
        lines.push(
          "elaion_http_request_duration_seconds_bucket{" +
          seriesLabel +
          ',le="+Inf"} ' +
          series.count,
          "elaion_http_request_duration_seconds_sum{" +
          seriesLabel +
          "} " +
          series.sum,
          "elaion_http_request_duration_seconds_count{" +
          seriesLabel +
          "} " +
          series.count,
        );
      }

      return lines.join("\n") + "\n";
    },
  };
};
