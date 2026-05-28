/**
 * КАО#VR-38 — Regression tests for the extended auto-start vocabulary
 *  AND the canvas-click fallback in tryAutoStart().
 *
 * VR-38 expanded the positive regex sets:
 *   - SEED vocab: + generate / create / populate / shuffle / randomize /
 *                 randomise (British spelling) / new game / новая игра /
 *                 случайн / шаблон / создат / генери / перемеша
 *   - START vocab: + step / tick / next generation / advance / evolve /
 *                  continue / confirm / apply / ok / done / готов /
 *                  применить / подтвер / продолжить / далее / шаг
 *
 * VR-38 also added a *canvas-click fallback* that fires only when neither
 * a button match nor Space produced a click — to handle demos that only
 * respond to a click on the canvas surface itself.
 *
 * Each case mounts a synthetic page, runs tryAutoStart, and asserts the
 * diagnostic shape. PARALLEL-SAFE: each case creates a fresh page; no
 * shared module state.
 *
 * Run:    node test_kao_vr38.js
 * Exit:   0 if all assertions pass, 1 otherwise.
 */

const puppeteer = require('puppeteer-core');
const { tryAutoStart } = require('./browser_screenshot');

const CHROMIUM_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';
const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 720;

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
    record(name, ok, ok ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function expectNull(name, actual) { expectEqual(name, actual, null); }
function expectTrue(name, actual) { expectEqual(name, actual, true); }
function expectFalse(name, actual) { expectEqual(name, actual, false); }
function expectMatch(name, actual, pattern) {
    const ok = typeof actual === 'string' && pattern.test(actual);
    record(name, ok, ok ? '' : `expected ${actual} to match ${pattern}`);
}

async function runCase(browser, label, html, assertFn) {
    const page = await browser.newPage();
    await page.setViewport({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });
    page.on('pageerror', () => {});
    page.on('console', () => {});
    page.on('requestfailed', () => {});
    try {
        await page.setContent(html, { waitUntil: 'load', timeout: 10000 });
    } catch (err) {
        // best-effort
    }
    let diag;
    try {
        diag = await tryAutoStart(page);
    } catch (err) {
        record(label, false, `tryAutoStart threw: ${err.message}`);
        await page.close();
        return;
    }
    console.log(`\n[${label}] diagnostic = ${JSON.stringify(diag)}`);
    try {
        assertFn(diag);
    } catch (err) {
        record(label, false, `assertion threw: ${err.message}`);
    }
    await page.close();
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

        // ─── VR-38 seed vocab additions ───────────────────────────────────

        await runCase(
            browser,
            'vr38_seed_generate',
            '<html><body><button>Generate</button></body></html>',
            (d) => {
                expectMatch('vr38_seed_generate.seeded', d.seeded, /generate/i);
            },
        );

        await runCase(
            browser,
            'vr38_seed_create',
            '<html><body><button>Create board</button></body></html>',
            (d) => {
                expectMatch('vr38_seed_create.seeded', d.seeded, /create/i);
            },
        );

        await runCase(
            browser,
            'vr38_seed_populate',
            '<html><body><button>Populate grid</button></body></html>',
            (d) => {
                expectMatch('vr38_seed_populate.seeded', d.seeded, /populate/i);
            },
        );

        await runCase(
            browser,
            'vr38_seed_shuffle',
            '<html><body><button>Shuffle</button></body></html>',
            (d) => {
                expectMatch('vr38_seed_shuffle.seeded', d.seeded, /shuffle/i);
            },
        );

        await runCase(
            browser,
            'vr38_seed_randomize_us',
            '<html><body><button>Randomize</button></body></html>',
            (d) => {
                expectMatch('vr38_seed_randomize_us.seeded', d.seeded, /randomize/i);
            },
        );

        await runCase(
            browser,
            'vr38_seed_randomise_uk',
            '<html><body><button>Randomise</button></body></html>',
            (d) => {
                expectMatch('vr38_seed_randomise_uk.seeded', d.seeded, /randomise/i);
            },
        );

        await runCase(
            browser,
            'vr38_seed_new_game',
            '<html><body><button>New game</button></body></html>',
            (d) => {
                expectMatch('vr38_seed_new_game.seeded', d.seeded, /new\s*game/i);
            },
        );

        // Cyrillic seed vocab.
        await runCase(
            browser,
            'vr38_seed_novaya_igra',
            '<html><body><button>Новая игра</button></body></html>',
            (d) => {
                expectMatch('vr38_seed_novaya_igra.seeded', d.seeded, /Нов/);
            },
        );

        await runCase(
            browser,
            'vr38_seed_peremesh',
            '<html><body><button>Перемешать</button></body></html>',
            (d) => {
                expectMatch('vr38_seed_peremesh.seeded', d.seeded, /Перемеш/);
            },
        );

        // ─── VR-38 start vocab additions ──────────────────────────────────

        await runCase(
            browser,
            'vr38_start_step',
            '<html><body><button>Step</button></body></html>',
            (d) => {
                expectMatch('vr38_start_step.started', d.started, /step/i);
            },
        );

        await runCase(
            browser,
            'vr38_start_tick',
            '<html><body><button>Tick</button></body></html>',
            (d) => {
                expectMatch('vr38_start_tick.started', d.started, /tick/i);
            },
        );

        await runCase(
            browser,
            'vr38_start_next_generation',
            '<html><body><button>Next generation</button></body></html>',
            (d) => {
                expectMatch('vr38_start_next_generation.started', d.started, /next\s*generation/i);
            },
        );

        await runCase(
            browser,
            'vr38_start_advance',
            '<html><body><button>Advance</button></body></html>',
            (d) => {
                expectMatch('vr38_start_advance.started', d.started, /advance/i);
            },
        );

        await runCase(
            browser,
            'vr38_start_evolve',
            '<html><body><button>Evolve</button></body></html>',
            (d) => {
                expectMatch('vr38_start_evolve.started', d.started, /evolve/i);
            },
        );

        await runCase(
            browser,
            'vr38_start_continue',
            '<html><body><button>Continue</button></body></html>',
            (d) => {
                expectMatch('vr38_start_continue.started', d.started, /continue/i);
            },
        );

        await runCase(
            browser,
            'vr38_start_confirm',
            '<html><body><button>Confirm</button></body></html>',
            (d) => {
                expectMatch('vr38_start_confirm.started', d.started, /confirm/i);
            },
        );

        await runCase(
            browser,
            'vr38_start_apply',
            '<html><body><button>Apply</button></body></html>',
            (d) => {
                expectMatch('vr38_start_apply.started', d.started, /apply/i);
            },
        );

        await runCase(
            browser,
            'vr38_start_ok_word_boundary',
            '<html><body><button>OK</button></body></html>',
            (d) => {
                // /ok\b/ must match the standalone word "OK".
                expectMatch('vr38_start_ok_word_boundary.started', d.started, /ok/i);
            },
        );

        await runCase(
            browser,
            'vr38_start_done',
            '<html><body><button>Done</button></body></html>',
            (d) => {
                expectMatch('vr38_start_done.started', d.started, /done/i);
            },
        );

        // Cyrillic start vocab.
        await runCase(
            browser,
            'vr38_start_prodolzhit',
            '<html><body><button>Продолжить</button></body></html>',
            (d) => {
                expectMatch('vr38_start_prodolzhit.started', d.started, /Продолж/);
            },
        );

        await runCase(
            browser,
            'vr38_start_daleye',
            '<html><body><button>Далее</button></body></html>',
            (d) => {
                expectMatch('vr38_start_daleye.started', d.started, /Далее/);
            },
        );

        await runCase(
            browser,
            'vr38_start_shag',
            '<html><body><button>Шаг</button></body></html>',
            (d) => {
                expectMatch('vr38_start_shag.started', d.started, /Шаг/);
            },
        );

        // ─── VR-38 canvas-click fallback ──────────────────────────────────
        //
        // Fires only when both button-match passes AND Space yielded nothing
        // visible. With NO buttons present, Space still fires (it's the
        // first fallback) — but the canvas-click should ALSO trigger
        // because seeded/started are null.

        await runCase(
            browser,
            'vr38_canvas_click_fires_when_no_buttons',
            `<html><body>
                <canvas width="1200" height="800" style="width:1200px;height:800px"></canvas>
            </body></html>`,
            (d) => {
                expectNull('vr38_canvas_click_fires_when_no_buttons.seeded', d.seeded);
                expectNull('vr38_canvas_click_fires_when_no_buttons.started', d.started);
                expectTrue('vr38_canvas_click_fires_when_no_buttons.pressed_space', d.pressed_space);
                // canvas_clicked must be non-null and reference the canvas.
                expectMatch(
                    'vr38_canvas_click_fires_when_no_buttons.canvas_clicked',
                    d.canvas_clicked,
                    /^canvas@\d+px²$/,
                );
            },
        );

        // Tiny canvas (below 10000px²) must NOT trigger the fallback —
        // avoids clicking favicon-size noise.
        await runCase(
            browser,
            'vr38_canvas_click_skips_tiny_canvas',
            `<html><body>
                <canvas width="50" height="50" style="width:50px;height:50px"></canvas>
            </body></html>`,
            (d) => {
                expectTrue('vr38_canvas_click_skips_tiny_canvas.pressed_space', d.pressed_space);
                expectNull('vr38_canvas_click_skips_tiny_canvas.canvas_clicked', d.canvas_clicked);
            },
        );

        // When a button match DID fire (seeded/started set), Space + canvas
        // fallback must NOT fire. Pin all three.
        await runCase(
            browser,
            'vr38_canvas_click_skipped_when_button_matched',
            `<html><body>
                <button>Play</button>
                <canvas width="1200" height="800" style="width:1200px;height:800px"></canvas>
            </body></html>`,
            (d) => {
                expectMatch('vr38_canvas_click_skipped_when_button_matched.started', d.started, /play/i);
                expectFalse('vr38_canvas_click_skipped_when_button_matched.pressed_space', d.pressed_space);
                // canvas_clicked must be undefined OR null — never set.
                const noClick = d.canvas_clicked === undefined || d.canvas_clicked === null;
                record('vr38_canvas_click_skipped_when_button_matched.canvas_clicked_unset',
                       noClick,
                       `canvas_clicked should be unset, got ${JSON.stringify(d.canvas_clicked)}`);
            },
        );

        // Same negation but via the seed path (data-pattern seeds).
        await runCase(
            browser,
            'vr38_canvas_click_skipped_when_seeded_via_data_attr',
            `<html><body>
                <button data-pattern="glider">Glider</button>
                <canvas width="1200" height="800" style="width:1200px;height:800px"></canvas>
            </body></html>`,
            (d) => {
                expectEqual('vr38_canvas_click_skipped_when_seeded_via_data_attr.seeded',
                            d.seeded, '[data-*]:glider');
                expectFalse('vr38_canvas_click_skipped_when_seeded_via_data_attr.pressed_space',
                            d.pressed_space);
                const noClick = d.canvas_clicked === undefined || d.canvas_clicked === null;
                record('vr38_canvas_click_skipped_when_seeded_via_data_attr.canvas_clicked_unset',
                       noClick,
                       `canvas_clicked should be unset, got ${JSON.stringify(d.canvas_clicked)}`);
            },
        );

        // Negative-filter sanity: 'fit' / 'zoom' / 'reset' / 'остан' must
        // still be rejected by the seed/start scanners (the vocab expansion
        // must not have widened them into the negative set).
        await runCase(
            browser,
            'vr38_negative_filter_still_blocks_zoom_to_fit',
            '<html><body><button>🔍 Fit to Pattern</button></body></html>',
            (d) => {
                expectNull('vr38_negative_filter_still_blocks_zoom_to_fit.seeded', d.seeded);
            },
        );

        await runCase(
            browser,
            'vr38_negative_filter_still_blocks_pause',
            '<html><body><button>Pause</button></body></html>',
            (d) => {
                expectNull('vr38_negative_filter_still_blocks_pause.started', d.started);
            },
        );

    } catch (err) {
        console.error(`FATAL: ${err.stack || err.message}`);
        process.exitCode = 1;
    } finally {
        if (browser) {
            try { await browser.close(); } catch (e) { /* ignore */ }
        }
    }

    console.log(`\n----------------------------------------`);
    if (failures.length === 0) {
        console.log(`OK: ${passed}/${total} passed`);
        process.exit(0);
    } else {
        console.log(`FAIL: ${passed}/${total} passed (${failures.length} failure${failures.length === 1 ? '' : 's'})`);
        for (const f of failures) {
            console.log(`  - ${f.name}: ${f.detail}`);
        }
        process.exit(1);
    }
})();
