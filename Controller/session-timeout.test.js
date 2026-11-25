const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { handleRequest, createSessionCookie } = require('./server');

test('sessions refresh on activity and expire after two idle minutes', async () => {
    const server = http.createServer(handleRequest);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

    try {
        const base = `http://127.0.0.1:${server.address().port}`;
        const activeCookie = createSessionCookie({ id: 'active-test', role: 'student' });
        const activeResponse = await fetch(`${base}/session-activity`, {
            method: 'POST',
            headers: { Cookie: activeCookie }
        });
        assert.equal(activeResponse.status, 204);
        assert.match(activeResponse.headers.get('set-cookie'), /Max-Age=120/);
        const authenticatedPage = await fetch(`${base}/about`, {
            headers: { Cookie: activeCookie }
        });
        assert.equal(authenticatedPage.status, 200);
        assert.match(await authenticatedPage.text(), /session-timeout\.js/);
        const timeoutScript = await fetch(`${base}/session-timeout.js`);
        assert.equal(timeoutScript.status, 200);
        assert.match(await timeoutScript.text(), /2 \* 60 \* 1000/);

        const expiredCookie = createSessionCookie({ id: 'expired-test', role: 'student' }, Date.now() - 120001);
        const expiredResponse = await fetch(`${base}/session-activity`, {
            method: 'POST',
            headers: { Cookie: expiredCookie }
        });
        assert.equal(expiredResponse.status, 401);
        assert.match(expiredResponse.headers.get('set-cookie'), /max-age=0/i);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});
