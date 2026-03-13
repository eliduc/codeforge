/**
 * Browser Code Validator
 *
 * Validates HTML/browser code by loading it in headless Chromium
 * and capturing console errors, WebGL errors, and unhandled exceptions.
 *
 * Usage: node browser_validator.js <html_file_path> [timeout_seconds]
 */

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CHROMIUM_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';
const DEFAULT_TIMEOUT = 8; // seconds to wait for errors after page load

async function validateBrowserCode(htmlPath, timeoutSec) {
    const errors = [];
    const warnings = [];
    const logs = [];
    let browser;

    try {
        // Read the HTML file
        if (!fs.existsSync(htmlPath)) {
            console.error(`File not found: ${htmlPath}`);
            process.exit(1);
        }

        const htmlContent = fs.readFileSync(htmlPath, 'utf8');

        // Basic HTML structure check
        if (!htmlContent.trim()) {
            errors.push('HTML file is empty');
        }

        // Launch headless Chromium
        browser = await puppeteer.launch({
            executablePath: CHROMIUM_PATH,
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-extensions',
                '--disable-background-networking',
                '--disable-default-apps',
                '--disable-sync',
                '--disable-translate',
                '--hide-scrollbars',
                '--mute-audio',
                '--no-first-run',
                // Enable WebGL via SwiftShader (software GPU in Docker)
                '--enable-unsafe-swiftshader',
                '--enable-webgl',
                '--ignore-gpu-blocklist',
                '--disable-software-rasterizer',
            ],
            timeout: 15000,
        });

        const page = await browser.newPage();

        // Set viewport for consistent rendering
        await page.setViewport({ width: 1280, height: 720 });

        // Capture console messages
        page.on('console', msg => {
            const type = msg.type();
            const text = msg.text();

            // Skip noisy browser warnings
            if (text.includes('DevTools') || text.includes('Third-party cookie')) return;

            if (type === 'error') {
                errors.push(text);
            } else if (type === 'warning') {
                warnings.push(text);
            } else {
                logs.push(text);
            }
        });

        // Capture uncaught exceptions
        page.on('pageerror', error => {
            errors.push(`Uncaught Error: ${error.message}`);
        });

        // Capture failed resource loads (CDN scripts, images, etc.)
        page.on('requestfailed', request => {
            const url = request.url();
            const failure = request.failure();
            // Only report external resource failures, not file:// issues
            if (url.startsWith('http')) {
                warnings.push(`Failed to load resource: ${url} (${failure?.errorText || 'unknown'})`);
            }
        });

        // Load the HTML content
        // Use setContent with data URI for proper file:// context
        try {
            await page.setContent(htmlContent, {
                waitUntil: 'networkidle2',
                timeout: Math.max(timeoutSec * 1000, 15000),
            });
        } catch (navErr) {
            if (navErr.message.includes('timeout')) {
                warnings.push(`Page load timed out after ${timeoutSec}s (CDN resources may be slow)`);
            } else {
                errors.push(`Page load error: ${navErr.message}`);
            }
        }

        // Wait for async initialization (requestAnimationFrame, setTimeout, etc.)
        await new Promise(resolve => setTimeout(resolve, Math.min(timeoutSec * 1000, 5000)));

        // Check for WebGL-specific errors
        const webglStatus = await page.evaluate(() => {
            const results = [];
            const canvases = document.querySelectorAll('canvas');

            canvases.forEach((canvas, i) => {
                // Check for WebGL context
                const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
                if (gl) {
                    // Check context lost
                    if (gl.isContextLost()) {
                        results.push({ type: 'error', msg: `Canvas #${i}: WebGL context lost` });
                    }

                    // Check for shader compilation errors in the GL error log
                    const glError = gl.getError();
                    if (glError !== gl.NO_ERROR) {
                        const errorNames = {
                            [gl.INVALID_ENUM]: 'INVALID_ENUM',
                            [gl.INVALID_VALUE]: 'INVALID_VALUE',
                            [gl.INVALID_OPERATION]: 'INVALID_OPERATION',
                            [gl.OUT_OF_MEMORY]: 'OUT_OF_MEMORY',
                            [gl.INVALID_FRAMEBUFFER_OPERATION]: 'INVALID_FRAMEBUFFER_OPERATION',
                        };
                        results.push({
                            type: 'error',
                            msg: `Canvas #${i}: WebGL error: ${errorNames[glError] || glError}`
                        });
                    }
                }
            });

            // Check if page has any visible content
            const body = document.body;
            if (body && body.innerHTML.trim().length < 10 && canvases.length === 0) {
                results.push({ type: 'warning', msg: 'Page appears to have no visible content' });
            }

            return results;
        }).catch(() => []);

        for (const item of webglStatus) {
            if (item.type === 'error') errors.push(item.msg);
            else warnings.push(item.msg);
        }

    } catch (launchErr) {
        errors.push(`Browser launch error: ${launchErr.message}`);
    } finally {
        if (browser) {
            try { await browser.close(); } catch (e) { /* ignore */ }
        }
    }

    // Output results
    if (logs.length > 0) {
        console.log('=== Console Output ===');
        logs.slice(0, 30).forEach(l => console.log(l));
        if (logs.length > 30) console.log(`... and ${logs.length - 30} more log entries`);
    }

    if (warnings.length > 0) {
        console.log('\n=== Warnings ===');
        warnings.forEach(w => console.log(`WARNING: ${w}`));
    }

    if (errors.length > 0) {
        console.error('\n=== ERRORS ===');
        errors.forEach(e => console.error(`ERROR: ${e}`));
        console.error(`\nBrowser validation FAILED: ${errors.length} error(s) detected`);
        process.exit(1);
    } else {
        console.log(`\nBrowser validation PASSED${warnings.length > 0 ? ` (${warnings.length} warning(s))` : ''}`);
        process.exit(0);
    }
}

// Main
const htmlPath = process.argv[2];
const timeoutSec = parseInt(process.argv[3]) || DEFAULT_TIMEOUT;

if (!htmlPath) {
    console.error('Usage: node browser_validator.js <html_file_path> [timeout_seconds]');
    process.exit(1);
}

validateBrowserCode(htmlPath, timeoutSec);
