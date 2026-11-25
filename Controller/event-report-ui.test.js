const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ejs = require('ejs');
const JSZip = require('jszip');
const { chromium } = require('@playwright/test');
const { createEventContentStore } = require('../Model/event-content');
const { createEventContentHandler } = require('./event-content');

test('admin selects fest and event, downloads ZIP, and sees missing-report feedback', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'utsav-report-ui-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const store = createEventContentStore(root);
    const events = [
        { id: 'music', name: 'Music', festName: 'Campus Fest', createdBy: 'coordinator' },
        { id: 'dance', name: 'Dance', festName: 'Other Fest', createdBy: 'coordinator' }
    ];
    await store.saveReport('music', 'coordinator', { title: 'Music report', body: 'Students performed at the campus celebration.' });
    const handler = createEventContentHandler({ store, getEvents: () => events, isCoordinator: () => false, isAdmin: () => true, validSession: () => true, allowedOrigin: () => true });
    const view = path.join(__dirname, '../View');
    const html = ejs.render(await fs.readFile(path.join(view, 'AdminDash.ejs'), 'utf8'), {
        dashboardData: { page: 'reports', events, participationEvents: events, accounts: [] }
    });
    const assets = new Map([['/fest.css', 'text/css'], ['/admin-dashboard.css', 'text/css'], ['/responsive-images.css', 'text/css'], ['/image.png', 'image/png'], ['/admin-users.js', 'application/javascript'], ['/admin-approvals.js', 'application/javascript']]);
    const server = http.createServer(async (request, response) => {
        try {
            const url = new URL(request.url, 'http://localhost');
            if (handler.matches(url.pathname)) return await handler.handle(request, response, { id: 'admin', role: 'admin' }, url);
            if (url.pathname === '/') { response.writeHead(200, { 'Content-Type': 'text/html' }); return response.end(html); }
            if (assets.has(url.pathname)) {
                response.writeHead(200, { 'Content-Type': assets.get(url.pathname) });
                return response.end(await fs.readFile(path.join(view, url.pathname.slice(1))));
            }
            response.writeHead(404); response.end();
        } catch (error) { response.writeHead(500); response.end(error.message); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://**/*', route => route.abort());
    for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`http://127.0.0.1:${server.address().port}/`);
        await page.locator('[data-open-event-report]').click();
        const dialog = page.locator('#event-report-download-dialog');
        await dialog.waitFor({ state: 'visible' });
        const fest = page.locator('#event-report-fest');
        const event = page.locator('#event-report-event');
        const button = page.locator('#event-report-download-button');
        assert.equal(await button.isDisabled(), true);
        await fest.selectOption('Campus Fest');
        assert.deepEqual(await event.locator('option').allTextContents(), ['Select event', 'Music']);
        await event.selectOption('music');
        const downloaded = page.waitForEvent('download');
        await button.click();
        const download = await downloaded;
        assert.equal(download.suggestedFilename(), 'Music-report.zip');
        const zip = await JSZip.loadAsync(await fs.readFile(await download.path()));
        assert.match(await zip.file('report.txt').async('string'), /Students performed/);
        await page.waitForFunction(() => !document.getElementById('event-report-download-button').disabled);
        await fest.selectOption('Other Fest');
        assert.equal(await button.isDisabled(), true);
        assert.deepEqual(await event.locator('option').allTextContents(), ['Select event', 'Dance']);
        await event.selectOption('dance');
        await button.click();
        await page.waitForFunction(() => document.getElementById('event-report-download-status').textContent.includes('has not written a report'));
        assert.equal(await dialog.evaluate(el => el.scrollWidth > el.clientWidth), false);
        await page.keyboard.press('Escape');
        assert.equal(await dialog.evaluate(el => el.open), false);
    }
    assert.deepEqual(errors, []);
});
