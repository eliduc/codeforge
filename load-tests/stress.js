import http from 'k6/http'
import { check, sleep } from 'k6'

export const options = {
  scenarios: {
    ramp: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: 50 },
        { duration: '2m', target: 100 },
        { duration: '1m', target: 100 },
        { duration: '1m', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<1500', 'p(99)<5000'],
    http_req_failed: ['rate<0.05'],
  },
}

const BASE = __ENV.BASE_URL || 'http://localhost:8300'
const TOKEN = __ENV.TOKEN
const headers = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}

export default function () {
  // Always hit health (cheap, public)
  http.get(`${BASE}/health`)

  if (TOKEN) {
    http.get(`${BASE}/api/sessions/?limit=50`, { headers })
    http.get(`${BASE}/api/code/dashboard/stats?days=7`, { headers })
  }

  sleep(0.1)
}
