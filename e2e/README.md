# CodeForge E2E Tests

## Setup
```
cd e2e
npm install
npm run install-browsers
```

## Run

### Against local stage (default)
```
npm test                                    # all tests
npm run test:ui                             # interactive
npm run test:headed                         # see browser
```

### Against remote stage
```
E2E_BASE_URL=https://stage.gotcode.ai \
E2E_AUTH_TOKEN=xxx \
E2E_TEST_EMAIL=cf-test@example.com \
npm test
```

## Environment variables
- `E2E_BASE_URL` — base URL (default http://localhost:3300)
- `E2E_AUTH_TOKEN` — JWT for authenticated tests (skip auth tests if missing)
- `E2E_TEST_EMAIL` — email for OTP login flow tests

## Architecture
Tests use the running app — no mocks. Auth tests skip if E2E_AUTH_TOKEN not provided.
Tests are split by page/feature for parallel execution.

## Output
- `playwright-report/` — HTML report (open with `npm run report`)
- `test-results/` — videos, screenshots, traces on failure
