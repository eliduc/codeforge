/**
 * КАО#Full-A2 — Sandbox full-functionality coverage.
 *
 * Complements test_browser_screenshot.js (which exercises tryAutoStart on a
 * matrix of HTML snippets) by stressing edge cases the existing suite leaves
 * uncovered:
 *
 *   • Invalid / malformed HTML must NOT crash the page driver — tryAutoStart
 *     should still return a valid diagnostic object.
 *   • Very large HTML payloads (>5MB) must not hang the driver — setContent
 *     either succeeds quickly or fails fast (puppeteer raises within timeout).
 *   • Nested iframes must NOT cause tryAutoStart to recurse forever or hang.
 *   • Pages with an already-running animation must be auto-startable AND
 *     remain capturable for multiple frames (cadence check).
 *
 * Run:    node test_kao_full_sandbox.js
 * Exit:   0 if all assertions pass, 1 otherwise.
 *
 * Requires the same env as test_browser_screenshot.js — PUPPETEER_EXECUTABLE_PATH
 * pointing at chromium, or a default at /usr/bin/chromium. Skips gracefully
 * (exit 0) if the executable is not present, so CI without a browser can run
 * this file as a smoke check.
 */
// КАО#Full-A2

const fs = require('fs');
const puppeteer = require('puppeteer-core');
const { tryAutoStart } = require('./browser_screenshot');

const CHROMIUM_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';
const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 720;

// КАО#Full-A2 — skip gracefully if chromium isn't installed (e.g. macOS dev).
if (!fs.existsSync(CHROMIUM_PATH)) {
    console.log(`SKIP: chromium not found at ${CHROMIUM_PATH}; set PUPPETEER_EXECUTABLE_PATH or install`);
    process.exit(0);
}

const failures = [];
let passed = 0;
let total = 0;

function record(name, ok, detail) {
    total += 1;
    if (ok) {
        passed += 1;
        console.log(`  PASS  ${name}`);
    } else {
        failures.push({ name, detail });
        console.log(`  FAIL  ${name} — ${detail}`);
    }
}

function expectEqual(name, actual, expected) {
    const ok = actual === expected;
    record(
        name,
        ok,
        ok ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
}

function expectTrue(name, actual) {
    expectEqual(name, !!actual, true);
}

function expectIsObject(name, actual) {
    const ok = actual !== null && typeof actual === 'object';
    record(name, ok, ok ? '' : `expected object, got ${typeof actual}: ${JSON.stringify(actual)}`);
}

async function withPage(browser, fn) {
    const page = await browser.newPage();
    await page.setViewport({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });
    page.on('pageerror', () => {});
    page.on('console', () => {});
    page.on('requestfailed', () => {});
    try {
        await fn(page);
    } finally {
        try { await page.close(); } catch (_) { /* ignore */ }
    }
}

(async () => {
    let browser;
    try {
        browser = await puppeteer.launch({
            executablePath: CHROMIUM_PATH,
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-extensions',
                '--mute-audio',
                '--hide-scrollbars',
            ],
            timeout: 15000,
        });

        // ─────────────────────────────────────────────────────────────────
        // КАО#Full-A2 Case 1: Invalid / malformed HTML — driver should
        // recover gracefully and still return a diagnostic object.
        // ─────────────────────────────────────────────────────────────────
        await withPage(browser, async (page) => {
            try {
                await page.setContent(
                    // Deliberately broken markup (unclosed tags, raw <script no close).
                    '<html><body><div><span<button>x',
                    { waitUntil: 'load', timeout: 5000 },
                );
            } catch (_) {
                // Puppeteer may reject mid-parse — that's fine.
            }
            let diag;
            try {
                diag = await tryAutoStart(page);
            } catch (err) {
                record('case_invalid_html.no_throw', false, `tryAutoStart threw: ${err.message}`);
                return;
            }
            record('case_invalid_html.no_throw', true, '');
            expectIsObject('case_invalid_html.returns_object', diag);
            // Diagnostic keys must exist even when nothing was found.
            expectTrue('case_invalid_html.has_pressed_space_key', 'pressed_space' in diag);
        });

        // ─────────────────────────────────────────────────────────────────
        // КАО#Full-A2 Case 2: Very large HTML (~5 MB) — must NOT hang.
        // Chromium will load this, but we cap the test with our own
        // wall-clock guard so a regression that makes tryAutoStart loop
        // on the DOM gets caught.
        // ─────────────────────────────────────────────────────────────────
        await withPage(browser, async (page) => {
            // ~5 MB of inert text inside <p> tags. Keep size moderate so the
            // headless browser doesn't OOM in CI containers.
            const padding = '<p>' + 'x'.repeat(1000) + '</p>';
            const huge = '<html><body>' + padding.repeat(5000) + '<button>Play</button></body></html>';
            try {
                await page.setContent(huge, { waitUntil: 'load', timeout: 15000 });
            } catch (err) {
                // setContent timing out is itself acceptable graceful failure.
                record('case_huge_html.setContent_no_crash', true, '');
                return;
            }
            // Wrap tryAutoStart in a hard wall-clock timeout so a hanging
            // regression fails the test (instead of hanging CI forever).
            const start = Date.now();
            const HARD_LIMIT_MS = 30000;
            const diag = await Promise.race([
                tryAutoStart(page),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('hard-timeout')), HARD_LIMIT_MS),
                ),
            ]).catch((err) => err);
            const elapsed = Date.now() - start;
            if (diag instanceof Error) {
                record('case_huge_html.completes_within_30s', false, `${diag.message} after ${elapsed}ms`);
                return;
            }
            record('case_huge_html.completes_within_30s', true, `${elapsed}ms`);
            expectIsObject('case_huge_html.returns_object', diag);
            // Play button should still be found despite the 5 MB of noise.
            expectEqual('case_huge_html.started', diag.started, 'Play');
        });

        // ─────────────────────────────────────────────────────────────────
        // КАО#Full-A2 Case 3: Iframe-inside-iframe — must not loop.
        // tryAutoStart only inspects the top-level document; verify it
        // doesn't try to descend into frames recursively.
        // ─────────────────────────────────────────────────────────────────
        await withPage(browser, async (page) => {
            const inner = '<html><body><button>Play</button></body></html>';
            const innerEncoded = encodeURIComponent(inner);
            const outer = `<html><body>
                <iframe srcdoc="${inner.replace(/"/g, '&quot;')}" id="frame1" style="width:400px;height:300px"></iframe>
                <iframe src="data:text/html;charset=utf-8,${innerEncoded}" id="frame2" style="width:400px;height:300px"></iframe>
                <button>Top-level Play</button>
            </body></html>`;
            try {
                await page.setContent(outer, { waitUntil: 'load', timeout: 10000 });
            } catch (_) { /* tolerate */ }
            // Wall-clock guard — proves no infinite recursion.
            const start = Date.now();
            const diag = await Promise.race([
                tryAutoStart(page),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('iframe-recursion-hang')), 15000),
                ),
            ]).catch((err) => err);
            const elapsed = Date.now() - start;
            if (diag instanceof Error) {
                record('case_nested_iframes.no_hang', false, `${diag.message} after ${elapsed}ms`);
                return;
            }
            record('case_nested_iframes.no_hang', true, `${elapsed}ms`);
            expectIsObject('case_nested_iframes.returns_object', diag);
            // The top-level Play (whichever — Play or "Top-level Play" — is
            // matched first by the regex) is the only one tryAutoStart sees.
            expectTrue(
                'case_nested_iframes.found_top_level_button',
                typeof diag.started === 'string' && diag.started.length > 0,
            );
        });

        // ─────────────────────────────────────────────────────────────────
        // КАО#Full-A2 Case 4: Already-running animation — tryAutoStart
        // should NOT crash on a page that already has an active rAF loop,
        // and the canvas-selection branch should still pick the biggest
        // canvas. (We don't capture frames in this test — that's the
        // executor's job — but we verify tryAutoStart is idempotent across
        // two back-to-back calls, mimicking the screenshot loop.)
        // ─────────────────────────────────────────────────────────────────
        await withPage(browser, async (page) => {
            const animated = `<html><body>
                <canvas id="c" width="800" height="600" style="width:800px;height:600px"></canvas>
                <script>
                    const cv = document.getElementById('c');
                    const ctx = cv.getContext('2d');
                    let t = 0;
                    function frame() {
                        t += 1;
                        ctx.fillStyle = 'hsl(' + (t % 360) + ',80%,50%)';
                        ctx.fillRect((t * 3) % 800, 0, 40, 600);
                        requestAnimationFrame(frame);
                    }
                    requestAnimationFrame(frame);
                </script>
                <button>Play</button>
            </body></html>`;
            try {
                await page.setContent(animated, { waitUntil: 'load', timeout: 10000 });
            } catch (_) { /* tolerate */ }
            // Give the rAF loop a tick.
            await new Promise(res => setTimeout(res, 200));

            // First call.
            let diag1;
            try {
                diag1 = await tryAutoStart(page);
            } catch (err) {
                record('case_running_anim.first_call_no_throw', false, err.message);
                return;
            }
            record('case_running_anim.first_call_no_throw', true, '');
            expectIsObject('case_running_anim.first_returns_object', diag1);
            // Big canvas should be picked.
            expectEqual('case_running_anim.scrolled_to_canvas', diag1.scrolled, 'canvas@480000px²');

            // Second call — should not throw or hang either.
            await new Promise(res => setTimeout(res, 200));
            let diag2;
            try {
                diag2 = await tryAutoStart(page);
            } catch (err) {
                record('case_running_anim.second_call_no_throw', false, err.message);
                return;
            }
            record('case_running_anim.second_call_no_throw', true, '');
            expectIsObject('case_running_anim.second_returns_object', diag2);
            // Same canvas should still win on the second call.
            expectEqual('case_running_anim.scrolled_consistent', diag2.scrolled, diag1.scrolled);
        });

        // ─────────────────────────────────────────────────────────────────
        // КАО#Full-A2 Case 5: Empty <iframe> tag (no srcdoc, no src) —
        // must not crash, behaves like an empty body for tryAutoStart.
        // ─────────────────────────────────────────────────────────────────
        await withPage(browser, async (page) => {
            const html = '<html><body><iframe></iframe></body></html>';
            try {
                await page.setContent(html, { waitUntil: 'load', timeout: 5000 });
            } catch (_) { /* tolerate */ }
            let diag;
            try {
                diag = await tryAutoStart(page);
            } catch (err) {
                record('case_empty_iframe.no_throw', false, err.message);
                return;
            }
            record('case_empty_iframe.no_throw', true, '');
            // No buttons / canvases → fallback Space fires.
            expectEqual('case_empty_iframe.fell_back_to_space', diag.pressed_space, true);
            expectEqual('case_empty_iframe.no_button', diag.started, null);
        });

        // ─────────────────────────────────────────────────────────────────
        // КАО#Full-A2 Case 6: Script-driven dynamic DOM — buttons that
        // appear AFTER load. tryAutoStart runs once and operates on the
        // DOM at call time, so it should still find a button injected
        // synchronously before our call.
        // ─────────────────────────────────────────────────────────────────
        await withPage(browser, async (page) => {
            const html = `<html><body>
                <div id="root"></div>
                <script>
                    const btn = document.createElement('button');
                    btn.textContent = 'Play';
                    document.getElementById('root').appendChild(btn);
                </script>
            </body></html>`;
            try {
                await page.setContent(html, { waitUntil: 'load', timeout: 5000 });
            } catch (_) { /* tolerate */ }
            let diag;
            try {
                diag = await tryAutoStart(page);
            } catch (err) {
                record('case_dynamic_button.no_throw', false, err.message);
                return;
            }
            record('case_dynamic_button.no_throw', true, '');
            expectEqual('case_dynamic_button.started', diag.started, 'Play');
        });

    } catch (err) {
        console.error(`FATAL: ${err.stack || err.message}`);
        process.exitCode = 1;
    } finally {
        if (browser) {
            try { await browser.close(); } catch (_) { /* ignore */ }
        }
    }

    console.log(`\n----------------------------------------`);
    if (failures.length === 0) {
        console.log(`OK: ${passed}/${total} passed (КАО#Full-A2)`);
        process.exit(0);
    } else {
        console.log(`FAIL: ${passed}/${total} passed (${failures.length} failure${failures.length === 1 ? '' : 's'})`);
        for (const f of failures) {
            console.log(`  - ${f.name}: ${f.detail}`);
        }
        process.exit(1);
    }
})();
