import http from 'k6/http'
import { check, sleep } from 'k6'

export const options = {
  vus: 10,
  duration: '30s',
  thresholds: {
    http_req_duration: ['p(95)<1000', 'p(99)<3000'],
    http_req_failed: ['rate<0.01'],
  },
}

const BASE = __ENV.BASE_URL || 'http://localhost:8300'

export default function () {
  // Public endpoint (no auth needed)
  const r1 = http.get(`${BASE}/health`)
  check(r1, {
    'health status 200': (r) => r.status === 200,
    'health body has status': (r) => JSON.parse(r.body).status === 'healthy',
  })

  // OpenAPI spec
  const r2 = http.get(`${BASE}/openapi.json`)
  check(r2, {
    'openapi 200': (r) => r.status === 200,
  })

  sleep(1)
}
