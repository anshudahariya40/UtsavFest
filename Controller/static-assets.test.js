const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { handleRequest } = require('./server');

test('logo keeps its PNG bytes on initial and cached requests; styles remain text', async () => {
    const server = http.createServer(handleRequest);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const expected = fs.readFileSync(path.join(__dirname, '../View/image.png'));
        for (let attempt = 0; attempt < 2; attempt++) {
            const response = await fetch(`${base}/image.png`);
            assert.equal(response.status, 200);
            assert.equal(response.headers.get('content-type'), 'image/png');
            assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
        }
        const stylesheet = await fetch(`${base}/fest.css`);
        assert.equal(stylesheet.headers.get('content-type'), 'text/css');
        assert.equal(await stylesheet.text(), fs.readFileSync(path.join(__dirname, '../View/fest.css'), 'utf8'));
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});
