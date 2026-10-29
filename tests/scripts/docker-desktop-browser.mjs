/** Real noVNC/Xvfb check. Requires a disposable desktop fixture, not a game. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

if (!process.env.SAB_QA_DEPS || !process.env.SAB_QA_PASSWORD_FILE) {
    throw new Error('Set SAB_QA_DEPS (playwright + ws installation) and SAB_QA_PASSWORD_FILE.');
}
const require = createRequire(path.join(path.resolve(process.env.SAB_QA_DEPS), 'package.json'));
const { chromium } = require('playwright');
const WebSocket = require('ws');
const base = process.env.SAB_DESKTOP_QA_URL ?? 'http://127.0.0.1:18680';
const checks = [];
function check(ok, name) { if (!ok) throw new Error(name); checks.push(name); }
async function refused(origin) {
    return await new Promise((resolve, reject) => {
        const socket = new WebSocket(base.replace('http:', 'ws:') + '/websockify', {
            headers: origin ? { Origin: origin } : {}, handshakeTimeout: 5000
        });
        socket.once('unexpected-response', (_, response) => { response.resume(); resolve(response.statusCode === 403); });
        socket.once('open', () => { socket.close(); resolve(false); });
        socket.once('error', reject);
    });
}
let browser;
try {
    check((await fetch(base + '/vnc.html', { signal: AbortSignal.timeout(10000) })).status === 200, 'real noVNC HTML through gateway');
    check((await fetch(base + '/', { headers: { Origin: 'https://example.invalid' } })).status === 403, 'HTTP cross-origin rejected');
    check(await refused('https://example.invalid'), 'real WebSocket cross-origin rejected');
    check(await refused(null), 'real WebSocket without Origin rejected');
    await new Promise((resolve, reject) => {
        const socket = new WebSocket(base.replace('http:', 'ws:') + '/websockify', { headers: { Origin: base }, handshakeTimeout: 5000 });
        let phase = 0, received = Buffer.alloc(0);
        const timer = setTimeout(() => { socket.terminate(); reject(new Error('RFB handshake timeout')); }, 10000);
        socket.on('error', error => { clearTimeout(timer); reject(error); });
        socket.on('message', data => {
            try {
                received = Buffer.concat([received, Buffer.from(data)]);
                if (phase === 0 && received.length >= 12) {
                    check(received.subarray(0, 12).toString().startsWith('RFB 003.'), 'actual X11 VNC server handshake');
                    received = received.subarray(12);
                    socket.send(Buffer.from('RFB 003.008\n'));
                    phase = 1;
                }
                if (phase === 1 && received.length >= 2 && received.length >= received[0] + 1) {
                    check(received[0] === 1 && received[1] === 2, 'VNC requires password; anonymous access absent');
                    phase = 2; clearTimeout(timer); socket.close(); resolve();
                }
            } catch (error) { clearTimeout(timer); socket.terminate(); reject(error); }
        });
    });
    const password = fs.readFileSync(process.env.SAB_QA_PASSWORD_FILE, 'utf8').trim();
    browser = await chromium.launch({
        ...(process.env.SAB_CHROMIUM_EXECUTABLE ? { executablePath: process.env.SAB_CHROMIUM_EXECUTABLE } : { channel: 'chrome' }),
        headless: true, args: ['--disable-gpu']
    });
    const page = await browser.newPage({ viewport: { width: 1365, height: 900 } }), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/vnc.html?autoconnect=true&resize=scale');
    await page.locator('#noVNC_password_input').waitFor({ state: 'visible', timeout: 20000 });
    await page.locator('#noVNC_password_input').fill(password);
    await page.locator('#noVNC_credentials_button').click();
    await page.waitForFunction(() => document.documentElement.classList.contains('noVNC_connected'), null, { timeout: 20000 });
    check(await page.locator('#noVNC_container canvas').isVisible(), 'browser authenticates and renders actual Xvfb/Openbox desktop');
    check(errors.length === 0, 'no browser JavaScript errors');
    if (process.env.SAB_QA_SCREENSHOT) await page.screenshot({ path: process.env.SAB_QA_SCREENSHOT, fullPage: true });
    const result = { ok: true, count: checks.length, checks, errors, scope: 'Xvfb/Openbox/noVNC only; no game was started' };
    if (process.env.SAB_QA_OUTPUT) fs.writeFileSync(process.env.SAB_QA_OUTPUT, JSON.stringify(result, null, 2) + '\n');
    process.stdout.write(JSON.stringify(result) + '\n');
} finally { if (browser) await browser.close(); }
