const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const users = require('../Model/userModel');
const { handleRequest } = require('./server');

test('reports route renders for admins and preserves dashboard access restrictions', async t => {
    t.mock.method(users, 'listUsersForAdmin', async () => []);
    const server = http.createServer(handleRequest);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = (pathname, role) => fetch(base + pathname, {
        redirect: 'manual',
        headers: role ? { Cookie: `utsavfest_user=${encodeURIComponent(JSON.stringify({ id: 'test-user', role }))}` } : {}
    });

    const guest = await request('/admin-dashboard/reports');
    assert.equal(guest.status, 302);
    assert.equal(guest.headers.get('location'), '/login?returnTo=%2Fadmin-dashboard%2Freports');
    assert.equal((await request('/admin-dashboard/reports', 'student')).status, 403);
    assert.equal((await request('/admin-dashboard/reports', 'event-coordinator')).status, 403);
    for (const pathname of ['/admin-dashboard/reports', '/admin-dashboard/reports/']) {
        const response = await request(pathname, 'admin');
        assert.equal(response.status, 200);
        const html = await response.text();
        assert.match(html, /<title>Reports \| UtsavFest<\/title>/);
        assert.match(html, /data-open-event-report/);
        assert.match(html, /data-open-participation-report/);
    }
});
