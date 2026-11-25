const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const ejs = require('ejs');
const { chromium } = require('@playwright/test');
const { createEventContentStore } = require('../Model/event-content');
const { createEventContentHandler } = require('./event-content');

test('coordinator saves winners and admin reports show the chosen rankings', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'utsav-winners-ui-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const events = [{ id: 'music', name: 'Music Night', festName: 'Campus Fest', createdBy: 'coordinator' }];
    const participants = [{ _id: 'p1', id: 'p1', studentName: 'Student One', enrollmentNumber: 'EN001' }, { _id: 'p2', id: 'p2', studentName: 'Student Two', enrollmentNumber: 'EN002' }];
    const store = createEventContentStore(root);
    const handler = createEventContentHandler({ store, getEvents: () => events, getParticipants: async () => participants, isCoordinator: user => user.role === 'event-coordinator', isAdmin: user => user.role === 'admin', validSession: () => true, allowedOrigin: () => true });
    const view = path.join(__dirname, '../View');
    const coordinator = ejs.render(await fs.readFile(path.join(view, 'user-dashboard.ejs'), 'utf8'), { user: { id: 'coordinator', name: 'Coordinator', role: 'event-coordinator' }, isEventCoordinator: true, isSystemAdmin: false, adminUsers: [], festivals: events, coordinatorEvents: events, studentForms: [], facultyForms: [], studentFormResults: [] });
    const admin = ejs.render(await fs.readFile(path.join(view, 'AdminDash.ejs'), 'utf8'), { dashboardData: { page: 'reports', accounts: [], events, participationEvents: events } });
    const assets = new Map([['/fest.css', 'text/css'], ['/responsive-images.css', 'text/css'], ['/admin-dashboard.css', 'text/css'], ['/coordinator-participants.js', 'application/javascript'], ['/admin-users.js', 'application/javascript'], ['/admin-approvals.js', 'application/javascript'], ['/image.png', 'image/png']]);
    const server = http.createServer(async (request, response) => {
        try {
            const url = new URL(request.url, 'http://localhost');
            const user = request.headers['x-test-role'] === 'admin' ? { id: 'admin', role: 'admin' } : { id: 'coordinator', role: 'event-coordinator' };
            if (handler.matches(url.pathname)) return await handler.handle(request, response, user, url);
            response.setHeader('Content-Type', 'text/html');
            if (url.pathname === '/') return response.end(coordinator);
            if (url.pathname === '/admin') return response.end(admin);
            if (url.pathname === '/coordinator/participants') { response.setHeader('Content-Type', 'application/json'); return response.end(JSON.stringify({ success: true, participants })); }
            if (url.pathname === '/admin-dashboard/participation') return response.end('<section class="participation-results"><table><tbody><tr><td>Student One</td><td>EN001</td><td>one@test</td><td></td><td></td><td>Arts</td><td>1</td><td>CPU</td></tr><tr><td>Student Two</td><td>EN002</td><td>two@test</td><td></td><td></td><td>Arts</td><td>1</td><td>CPU</td></tr></tbody></table></section>');
            if (assets.has(url.pathname)) { response.setHeader('Content-Type', assets.get(url.pathname)); return response.end(await fs.readFile(path.join(view, url.pathname.slice(1)))); }
            response.writeHead(404); response.end();
        } catch (error) { response.writeHead(500); response.end(error.message); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://**/*', route => route.abort());
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 950 });
        await page.goto(base);
        await page.locator('#open-view-participants').click();
        await page.locator('#view-participant-fest').selectOption('Campus Fest');
        await page.locator('#view-participant-event').selectOption('music');
        await page.locator('#event-winners-form').waitFor({ state: 'visible' });
        await page.locator('select[name=first]').selectOption('p2');
        await page.locator('select[name=second]').selectOption('p2');
        await page.locator('#event-winners-form button').click();
        assert.match(await page.locator('#event-winners-status').textContent(), /different participant/);
        await page.locator('select[name=second]').selectOption('p1');
        await page.locator('#event-winners-form button').click();
        await page.waitForFunction(() => document.getElementById('event-winners-status').textContent.includes('Winners saved'));
        assert.deepEqual((await store.getWinners('music')).map(winner => winner.participantId), ['p2', 'p1']);
    }
    await page.setExtraHTTPHeaders({ 'x-test-role': 'admin' });
    await page.goto(`${base}/admin`);
    await page.locator('[data-open-participation-report]').click();
    await page.locator('#report-fest-select').selectOption('Campus Fest');
    await page.locator('#report-event-select').selectOption('music');
    await page.locator('.participation-winner').first().waitFor();
    assert.deepEqual(await page.locator('.participation-winner strong').allTextContents(), ['Student Two', 'Student One']);
    await page.goto(`${base}/event-reports`);
    await page.locator('#content-fest').selectOption('Campus Fest');
    await page.locator('#content-event').selectOption('music');
    await page.locator('#report-panel').waitFor({ state: 'visible' });
    assert.match(await page.locator('#report-winners').textContent(), /Student Two.*Student One/);
    assert.deepEqual(errors, []);
});

