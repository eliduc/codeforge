import http from 'k6/http'
import { check, sleep } from 'k6'
import { Trend } from 'k6/metrics'

export const options = {
  scenarios: {
    constant_load: {
      executor: 'constant-vus',
      vus: 50,
      duration: '2m',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<500', 'p(99)<2000'],
    http_req_failed: ['rate<0.01'],
  },
}

const BASE = __ENV.BASE_URL || 'http://localhost:8300'
const TOKEN = __ENV.TOKEN
const headers = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}

const sessionsListTrend = new Trend('sessions_list_duration')
const dashboardTrend = new Trend('dashboard_duration')

export default function () {
  if (!TOKEN) {
    // Without token, just hit public endpoints
    const r = http.get(`${BASE}/health`)
    check(r, { '200': (r) => r.status === 200 })
    sleep(1)
    return
  }

  // Sessions list
  let res = http.get(`${BASE}/api/sessions/?limit=50`, { headers, tags: { name: 'sessions-list' } })
  sessionsListTrend.add(res.timings.duration)
  check(res, { 'sessions list 200': (r) => r.status === 200 })

  // Dashboard
  res = http.get(`${BASE}/api/code/dashboard/stats?days=30`, { headers, tags: { name: 'dashboard' } })
  dashboardTrend.add(res.timings.duration)
  check(res, { 'dashboard 200': (r) => r.status === 200 })

  // Auth/me
  res = http.get(`${BASE}/api/auth/me`, { headers, tags: { name: 'me' } })
  check(res, { 'me 200': (r) => r.status === 200 })

  // Templates list
  res = http.get(`${BASE}/api/templates/`, { headers, tags: { name: 'templates' } })
  check(res, { 'templates 200': (r) => r.status === 200 })

  sleep(0.2)
}
