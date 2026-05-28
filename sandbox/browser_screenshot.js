/**
 * Browser Screenshot Capturer
 *
 * Loads an HTML page in headless Chromium and captures N stills at
 * specified time offsets (in seconds, relative to page-load).
 *
 * Usage:
 *   node browser_screenshot.js <html_file> <output_dir> <t1,t2,...> [overall_timeout_sec]
 *
 * Output:
 *   <output_dir>/frame_0.png, frame_1.png, ...
 *
 * Emits a single JSON line to stdout describing the captured frames:
 *   {"frames":[{"frame_index":0,"t_seconds":0.5,"path":"...","width":1280,"height":720}, ...]}
 *
 * Exits non-zero on fatal failure; partial captures still return the JSON
 * for whatever frames succeeded.
 */

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CHROMIUM_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';
const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 720;


function parseTimestamps(arg) {
    return arg.split(',')
        .map(s => parseFloat(s.trim()))
        .filter(n => !Number.isNaN(n) && n >= 0)
        .sort((a, b) => a - b);
}


/**
 * Best-effort attempt to "boot" the candidate page so the screenshot loop
 * captures the actual program, not a start splash.
 *
 * КАО#VR-24 — Some Coder agents produce pages gated behind a Start/Play
 * button: the simulation only runs after a human click. Worse, some gate
 * the demo behind "pick a sample THEN press Play" — clicking Play on an
 * empty grid runs the simulation but shows nothing because there's no
 * initial state. We handle both:
 *
 *   Pass 1 (seed): click a "random/sample/preset/pattern/demo/init/fill"
 *     element if one exists. Many candidates use these to populate state.
 *     We click the FIRST data-pattern button as a tie-breaker — for Conway
 *     etc. that usually drops a glider into the grid.
 *
 *   Pass 2 (start): click a "play/start/run/begin/launch" button to
 *     actually kick off animation.
 *
 *   Fallback: if neither pass clicked anything, press Space (toggles
 *     play/pause in many canvas demos).
 *
 * All failures are silent. Returns a brief diagnostic for stderr.
 */
async function tryAutoStart(page) {
    const diagnostic = { seeded: null, started: null, pressed_space: false };

    // Pass 1 — seed the world. Cheap pre-click that populates initial state
    // for candidates that start with a blank canvas. Two stages, in order:
    //   1a. data-pattern / data-preset / data-sample attributes (high
    //       confidence — these are PURPOSE-BUILT seed buttons).
    //   1b. button/input text matching positive seed vocabulary.
    // Skip zoom/fit/view words even when they say "pattern" — those are
    // navigation actions, not seed actions ("🔍 Fit to Pattern" в Coder 3
    // would otherwise win because it appears earlier in DOM order than the
    // real seed buttons).
    try {
        diagnostic.seeded = await page.evaluate(() => {
            const isClickable = (el) => {
                const rect = el.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) return false;
                const style = window.getComputedStyle(el);
                if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
                return true;
            };

            // 1a. data-* attributes — strongest seed signal.
            const dataAttrEls = Array.from(document.querySelectorAll(
                '[data-pattern], [data-preset], [data-sample], [data-demo], [data-seed]'
            ));
            for (const el of dataAttrEls) {
                if (!isClickable(el)) continue;
                const label = (el.getAttribute('data-pattern') ||
                               el.getAttribute('data-preset') ||
                               el.getAttribute('data-sample') ||
                               el.getAttribute('data-demo') ||
                               el.getAttribute('data-seed') || '') + '';
                el.click();
                return `[data-*]:${label.slice(0, 40)}`;
            }

            // 1b. text-matched buttons (but NOT zoom/fit/view actions).
            // VR-38 — extended vocab to cover more seed-button conventions
            // observed across coder candidates: "generate", "create",
            // "populate", "shuffle", "randomize", and emoji-only buttons.
            const positive = /(random|sample|preset|pattern|template|example|seed|fill|init|spawn|glider|generate|create|populate|shuffle|randomi[sz]e|new\s*game|новая\s*игра|случайн|пример|шаблон|заполни|создат|генери|перемеша)/i;
            const negative = /(reset|clear|cancel|delete|stop|pause|fit|zoom|center|focus|view|find|hide|show|toggle|settings|config|help|about|остан|сброс|очист|отмен|удал|показ|скрыт|центр|фит|увел|приблиз|настрой|помощь)/i;
            const els = Array.from(document.querySelectorAll(
                'button, [role=button], input[type=button], input[type=submit]'
            ));
            for (const el of els) {
                if (!isClickable(el)) continue;
                const text = ((el.innerText || el.value ||
                               el.getAttribute('aria-label') ||
                               el.title || el.id || '') + '').trim();
                if (!text) continue;
                if (negative.test(text)) continue;
                if (!positive.test(text)) continue;
                el.click();
                return text.slice(0, 50);
            }
            return null;
        });
    } catch (e) {
        // page.evaluate may throw on unstable pages — keep going.
    }

    // Pass 2 — actually start the simulation. Same matching strategy, but
    // for "play/start/run..." vocabulary.
    // VR-38 — extended vocab: "ok/apply/confirm/continue/next" cover
    // multi-step UIs where Start is gated behind a configuration confirm.
    try {
        diagnostic.started = await page.evaluate(() => {
            const positive = /(play|start|run|begin|launch|go\b|demo|simul|step|tick|next\s*generation|advance|evolve|continue|confirm|apply|ok\b|done|готов|применить|подтвер|продолжить|далее|старт|начать|пуск|запуск|начни|шаг)/i;
            const negative = /(stop|pause|reset|clear|cancel|delete|exit|close|back|остан|сброс|очист|отмен|удал|выход|закр|наза)/i;
            const els = Array.from(document.querySelectorAll(
                'button, [role=button], input[type=button], input[type=submit], a[href="#"]'
            ));
            for (const el of els) {
                const text = ((el.innerText || el.value ||
                               el.getAttribute('aria-label') ||
                               el.title || el.id || '') + '').trim();
                if (!text) continue;
                if (negative.test(text)) continue;
                if (!positive.test(text)) continue;
                const rect = el.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) continue;
                const style = window.getComputedStyle(el);
                if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;
                el.click();
                return text.slice(0, 50);
            }
            return null;
        });
    } catch (e) {
        // continue
    }

    if (!diagnostic.seeded && !diagnostic.started) {
        // Last-resort nudge: Space frequently toggles play/pause in canvas
        // demos. Only fired when no buttons were clickable — pressing it
        // AFTER a successful click would just immediately pause some demos.
        try {
            await page.keyboard.press('Space');
            diagnostic.pressed_space = true;
        } catch (e) { /* ignore */ }

        // VR-38 — canvas-click fallback. Some demos respond only to a
        // click on the canvas itself (toggle play, drop a glider, etc.).
        // Only attempted when buttons + Space yielded nothing, so we
        // don't accidentally pause an already-running demo by clicking
        // its surface. Picks the largest canvas to avoid icon-size noise.
        try {
            diagnostic.canvas_clicked = await page.evaluate(() => {
                const canvases = Array.from(document.querySelectorAll('canvas'));
                let best = null;
                let bestArea = 0;
                for (const c of canvases) {
                    const r = c.getBoundingClientRect();
                    const area = r.width * r.height;
                    if (area > bestArea) { best = c; bestArea = area; }
                }
                if (best && bestArea > 10000) {
                    const r = best.getBoundingClientRect();
                    const cx = r.left + r.width / 2;
                    const cy = r.top + r.height / 2;
                    best.dispatchEvent(new MouseEvent('click', {
                        bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0,
                    }));
                    return `${best.tagName.toLowerCase()}@${Math.round(bestArea)}px²`;
                }
                return null;
            });
        } catch (e) { /* ignore */ }
    }

    // Pass 3 — make the canvas visible. Some candidates pack a tall column
    // of UI controls above the canvas; with a 720px viewport the canvas
    // ends up below the fold and the screenshot shows only controls. We
    // scroll the largest visible canvas into view. Falls back to scrolling
    // the page bottom if there's no canvas (e.g. SVG- or DIV-based demos).
    try {
        diagnostic.scrolled = await page.evaluate(() => {
            const canvases = Array.from(document.querySelectorAll('canvas, svg'));
            // Pick the largest one — common idiom is one big render surface
            // plus tiny icon canvases.
            let best = null;
            let bestArea = 0;
            for (const c of canvases) {
                const rect = c.getBoundingClientRect();
                const area = rect.width * rect.height;
                if (area > bestArea) { best = c; bestArea = area; }
            }
            if (best && bestArea > 10000) {  // ignore icon-size surfaces
                best.scrollIntoView({ block: 'center', inline: 'center' });
                return `${best.tagName.toLowerCase()}@${Math.round(bestArea)}px²`;
            }
            return null;
        });
    } catch (e) { /* ignore */ }

    return diagnostic;
}

async function captureScreenshots(htmlPath, outDir, timestamps, overallTimeoutSec) {
    const frames = [];
    let browser;
    const overallDeadline = Date.now() + overallTimeoutSec * 1000;

    try {
        if (!fs.existsSync(htmlPath)) {
            console.error(`File not found: ${htmlPath}`);
            process.exit(2);
        }
        fs.mkdirSync(outDir, { recursive: true });

        const htmlContent = fs.readFileSync(htmlPath, 'utf8');

        browser = await puppeteer.launch({
            executablePath: CHROMIUM_PATH,
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-extensions',
                '--mute-audio',
                '--enable-unsafe-swiftshader',
                '--enable-webgl',
                '--ignore-gpu-blocklist',
                '--disable-software-rasterizer',
                '--hide-scrollbars',
            ],
            timeout: 15000,
        });

        const page = await browser.newPage();
        await page.setViewport({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });

        // Don't fail on console errors — we want screenshots even if the
        // page logs warnings. Just swallow them.
        page.on('pageerror', () => {});
        page.on('console', () => {});
        page.on('requestfailed', () => {});

        // Load the page. Don't wait for networkidle — visual demos commonly
        // keep an animation loop running forever which would never idle.
        try {
            await page.setContent(htmlContent, {
                waitUntil: 'load',
                timeout: 10000,
            });
        } catch (err) {
            // Continue anyway; we may still get a usable render.
        }

        // КАО#VR-24 — two-pass nudge so the screenshot loop sees the actual
        // demo, not an intro menu or a played-but-empty grid. Best-effort:
        // silent on failure.
        const autoStart = await tryAutoStart(page);
        if (autoStart.seeded || autoStart.started || autoStart.pressed_space || autoStart.scrolled) {
            const parts = [];
            if (autoStart.seeded) parts.push(`seeded=${autoStart.seeded}`);
            if (autoStart.started) parts.push(`started=${autoStart.started}`);
            if (autoStart.pressed_space) parts.push('space');
            if (autoStart.scrolled) parts.push(`scrolled=${autoStart.scrolled}`);
            console.error(`Auto-start: ${parts.join(' | ')}`);
        }
        // Give event handlers a moment to actually kick off animation before
        // t0 starts ticking. 100ms is enough for setTimeout/RAF chains to fire
        // without meaningfully shifting the t_seconds anchor.
        await new Promise(r => setTimeout(r, 100));

        const t0 = Date.now();
        for (let i = 0; i < timestamps.length; i++) {
            const targetMs = timestamps[i] * 1000;
            const remainingDeadline = overallDeadline - Date.now();
            if (remainingDeadline <= 0) {
                console.error(`Overall timeout exceeded before frame ${i}`);
                break;
            }

            const waitMs = Math.max(0, targetMs - (Date.now() - t0));
            // Cap wait to the remaining overall deadline.
            const cappedWait = Math.min(waitMs, remainingDeadline);
            if (cappedWait > 0) {
                await new Promise(r => setTimeout(r, cappedWait));
            }

            const framePath = path.join(outDir, `frame_${i}.png`);
            try {
                await page.screenshot({
                    path: framePath,
                    type: 'png',
                    fullPage: false,
                });
                frames.push({
                    frame_index: i,
                    t_seconds: timestamps[i],
                    path: framePath,
                    width: VIEWPORT_WIDTH,
                    height: VIEWPORT_HEIGHT,
                });
            } catch (err) {
                console.error(`Failed to capture frame ${i}: ${err.message}`);
            }
        }
    } catch (err) {
        console.error(`Capture error: ${err.message}`);
    } finally {
        if (browser) {
            try { await browser.close(); } catch (e) { /* ignore */ }
        }
    }

    // Single JSON line on stdout for the parent to parse.
    process.stdout.write(JSON.stringify({ frames }) + '\n');
    process.exit(frames.length > 0 ? 0 : 1);
}


// КАО#VR-24 — export tryAutoStart for regression tests
// (sandbox/test_browser_screenshot.js). When this file is require()-d
// instead of executed as a CLI we skip argv parsing entirely.
module.exports = { tryAutoStart };

if (require.main === module) {
    const htmlPath = process.argv[2];
    const outDir = process.argv[3];
    const timestampsArg = process.argv[4];
    const overallTimeoutSec = parseInt(process.argv[5]) || 20;

    if (!htmlPath || !outDir || !timestampsArg) {
        console.error('Usage: node browser_screenshot.js <html_file> <output_dir> <t1,t2,...> [timeout_sec]');
        process.exit(2);
    }

    const timestamps = parseTimestamps(timestampsArg);
    if (timestamps.length === 0) {
        console.error('No valid timestamps provided');
        process.exit(2);
    }

    captureScreenshots(htmlPath, outDir, timestamps, overallTimeoutSec);
}
