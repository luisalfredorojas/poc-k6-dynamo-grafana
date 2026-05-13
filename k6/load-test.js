import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const errorRate = new Rate('errors');
const errorCount = new Counter('error_count');
const customDuration = new Trend('custom_duration', true);

const BASE_URL = __ENV.TARGET_URL || 'https://httpbin.test.k6.io';

export const options = {
  stages: [
    { duration: '30s', target: 10 },
    { duration: '1m',  target: 10 },
    { duration: '30s', target: 0  },
  ],
  thresholds: {
    http_req_duration:        ['p(95)<800', 'p(99)<1500'],
    http_req_failed:          ['rate<0.05'],
    errors:                   ['rate<0.05'],
    http_reqs:                ['count>10'],
  },
};

export default function () {
  const start = Date.now();

  const res = http.get(`${BASE_URL}/get`, {
    tags: { run_id: __ENV.RUN_ID || 'run-local' },
  });

  const ok = check(res, {
    'status is 200':      (r) => r.status === 200,
    'response has json':  (r) => r.headers['Content-Type'] && r.headers['Content-Type'].includes('json'),
    'duration < 1000ms':  (r) => r.timings.duration < 1000,
  });

  errorRate.add(!ok);
  if (!ok) errorCount.add(1);
  customDuration.add(Date.now() - start);

  sleep(Math.random() * 2 + 0.5);
}

export function handleSummary(data) {
  const runId = __ENV.RUN_ID || 'run-local';

  const summary = {
    run_id:                   runId,
    test_name:                'load-test',
    environment:              __ENV.ENVIRONMENT || 'local',
    started_at:               new Date().toISOString(),
    vus_max:                  data.metrics.vus_max?.values?.value ?? 0,
    http_reqs:                data.metrics.http_reqs?.values?.count ?? 0,
    http_req_failed_rate:     data.metrics.http_req_failed?.values?.rate ?? 0,
    http_req_duration_p95:    data.metrics.http_req_duration?.values?.['p(95)'] ?? 0,
    http_req_duration_p99:    data.metrics.http_req_duration?.values?.['p(99)'] ?? 0,
    http_req_duration_avg:    data.metrics.http_req_duration?.values?.avg ?? 0,
    http_req_duration_med:    data.metrics.http_req_duration?.values?.med ?? 0,
    errors_rate:              data.metrics.errors?.values?.rate ?? 0,
    data_sent_bytes:          data.metrics.data_sent?.values?.count ?? 0,
    data_received_bytes:      data.metrics.data_received?.values?.count ?? 0,
    iterations:               data.metrics.iterations?.values?.count ?? 0,
    thresholds: Object.entries(data.thresholds ?? {}).map(([metric, thr]) =>
      Object.entries(thr).map(([expression, passed]) => ({
        metric,
        expression,
        passed,
      }))
    ).flat(),
  };

  return {
    '/out/summary.json': JSON.stringify(summary, null, 2),
  };
}
