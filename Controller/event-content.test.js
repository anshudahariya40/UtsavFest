const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const JSZip = require('jszip');
const { createEventContentStore, decodePhoto, MAX_PHOTO_BYTES } = require('../Model/event-content');
const { createEventContentHandler } = require('./event-content');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=';
const photo = { name: 'campus.png', data: `data:image/png;base64,${PNG}` };

test('photo validation rejects unsupported, mismatched and oversized files', () => {
    assert.equal(decodePhoto(photo.data).type, 'image/png');
    assert.throws(() => decodePhoto('data:image/svg+xml;base64,PHN2Zy8+'));
    assert.throws(() => decodePhoto('data:image/png;base64,aGVsbG8='));
    assert.throws(() => decodePhoto(`data:image/png;base64,${Buffer.alloc(MAX_PHOTO_BYTES + 1).toString('base64')}`), /8 MB/);
});

test('event photo and report HTTP workflow persists records and enforces roles and event ownership', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'utsav-event-content-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const store = createEventContentStore(root);
    const events = [{ id: 'first', name: 'Music', festName: 'Campus Fest', createdBy: 'coordinator' }, { id: 'second', name: 'Dance', festName: 'Other Fest', createdBy: 'another-coordinator' }];
    const handler = createEventContentHandler({ store, getEvents: () => events, getParticipants: async event => event.id === 'first' ? [{ _id: 'p1', studentName: 'Student One', enrollmentNumber: 'EN001', collegeName: 'CPU' }, { _id: 'p2', studentName: 'Student Two', enrollmentNumber: 'EN002' }] : [], isCoordinator: user => user?.role === 'event-coordinator', isAdmin: user => user?.role === 'admin', validSession: user => Boolean(user?.id), allowedOrigin: request => !request.headers.origin || request.headers.origin === 'http://localhost' });
    const server = http.createServer((request, response) => {
        const role = request.headers['x-test-role'];
        const user = role ? { role, id: role === 'event-coordinator' ? 'coordinator' : role } : null;
        handler.handle(request, response, user, new URL(request.url, 'http://localhost')).catch(error => { response.writeHead(500); response.end(error.message); });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = (route, role) => fetch(base + route, { redirect: 'manual', headers: role ? { 'x-test-role': role } : {} });
    const post = (route, data, role = 'event-coordinator', origin = 'http://localhost') => fetch(base + route, { method: 'POST', headers: { 'x-test-role': role, 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(data) });
    assert.equal((await get('/event-photos')).status, 302);
    assert.equal((await get('/event-content/photos?eventId=first')).status, 401);
    assert.equal((await post('/event-content/photos?eventId=first', photo, 'student')).status, 403);
    assert.equal((await post('/event-content/photos?eventId=second', photo)).status, 403);
    assert.equal((await post('/event-content/photos?eventId=missing', photo)).status, 404);
    assert.equal((await post('/event-content/photos?eventId=first', photo, 'event-coordinator', 'https://other.example')).status, 403);
    assert.equal((await post('/event-content/photos?eventId=first', { name: 'bad.png', data: 'data:image/png;base64,aGVsbG8=' })).status, 400);
    const uploaded = await post('/event-content/photos?eventId=first', photo);
    assert.equal(uploaded.status, 201);
    const saved = (await uploaded.json()).photo;
    await post('/event-content/photos?eventId=first', photo);
    assert.equal((await createEventContentStore(root).listPhotos('first')).length, 2, 'Photos survive store restart');
    assert.equal((await store.listPhotos('second')).length, 0, 'Albums stay separate');
    for (const role of ['student', 'faculty', 'admin', 'event-coordinator']) {
        assert.equal((await get('/event-photos', role)).status, 200);
        const response = await get(`/event-content/photo?eventId=first&photoId=${saved.id}&download=1`, role);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-disposition'), /^attachment/);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(PNG, 'base64'));
        const zipResponse = await get('/event-content/photos.zip?eventId=first', role);
        assert.equal(zipResponse.status, 200);
        const zip = await JSZip.loadAsync(await zipResponse.arrayBuffer());
        assert.equal(Object.keys(zip.files).length, 2);
    }
    assert.equal((await get('/event-content/photos.zip?eventId=second', 'student')).status, 404);
    assert.equal((await get('/event-content/photo?eventId=first&photoId=../../.env', 'student')).status, 404);
    assert.equal((await get('/event-content/photo?eventId=second&photoId=' + saved.id, 'student')).status, 404);
    assert.equal((await get('/event-photos?mode=upload', 'student')).status, 403);
    const uploadPage = await (await get('/event-photos?mode=upload', 'event-coordinator')).text();
    assert.ok(uploadPage.includes('Campus Fest'));
    assert.ok(!uploadPage.includes('Other Fest'), 'Upload selector only includes owned events');
    assert.equal((await post('/event-content/report?eventId=first', { title: '', body: '' })).status, 400);
    assert.equal((await post('/event-content/report?eventId=second', { title: 'Event', body: 'Report' })).status, 403);
    assert.equal((await post('/event-content/report?eventId=first', { title: 'Music report', body: 'An excellent campus event.' })).status, 200);
    assert.equal((await createEventContentStore(root).getReport('first')).title, 'Music report');
    await post('/event-content/report?eventId=first', { title: 'Updated report', body: '<script>plain text only</script>' });
    const report = await (await get('/event-content/report?eventId=first', 'admin')).json();
    assert.equal(report.report.title, 'Updated report');
    assert.equal((await get('/event-content/report?eventId=first', 'student')).status, 403);
    assert.equal((await get('/event-content/report?eventId=second', 'event-coordinator')).status, 403);

    assert.equal((await get('/event-content/winners?eventId=first')).status, 401);
    for (const role of ['student', 'faculty', 'admin']) {
        assert.equal((await post('/event-content/winners?eventId=first', { winners: [] }, role)).status, 403);
    }
    assert.equal((await post('/event-content/winners?eventId=second', { winners: [] })).status, 403);
    assert.equal((await post('/event-content/winners?eventId=first', { winners: [] }, 'event-coordinator', 'https://other.example')).status, 403);
    for (const winners of [null, [{ rank: 4, participantId: 'p1' }], [{ rank: 1, participantId: 'stranger' }], [{ rank: 1, participantId: 'p1' }, { rank: 2, participantId: 'p1' }], [{ rank: 1, participantId: 'p1' }, { rank: 1, participantId: 'p2' }]]) {
        assert.equal((await post('/event-content/winners?eventId=first', { winners })).status, 400);
    }
    assert.equal((await post('/event-content/winners?eventId=first', { winners: [{ rank: 2, participantId: 'p1' }, { rank: 1, participantId: 'p2', studentName: 'Spoofed name' }] })).status, 200);
    const persistedWinners = await createEventContentStore(root).getWinners('first');
    assert.deepEqual(persistedWinners.map(winner => [winner.rank, winner.studentName]), [[1, 'Student Two'], [2, 'Student One']]);
    assert.deepEqual((await (await get('/event-content/winners?eventId=first', 'admin')).json()).winners, persistedWinners);
    assert.equal((await (await get('/event-content/report?eventId=first', 'admin')).json()).winners.length, 2);
    assert.deepEqual(await store.getWinners('second'), []);
    await post('/event-content/winners?eventId=first', { winners: [] });
    assert.deepEqual(await store.getWinners('first'), []);
    await post('/event-content/winners?eventId=first', { winners: [{ rank: 1, participantId: 'p2' }] });

    assert.ok(handler.matches('/event-content/report.zip'));
    assert.equal((await get('/event-content/report.zip?eventId=first')).status, 401);
    for (const role of ['student', 'faculty', 'event-coordinator']) {
        assert.equal((await get('/event-content/report.zip?eventId=first', role)).status, 403);
    }
    assert.equal((await post('/event-content/report.zip?eventId=first', {}, 'admin')).status, 405);
    assert.equal((await get('/event-content/report.zip?eventId=missing', 'admin')).status, 404);
    const missingReport = await get('/event-content/report.zip?eventId=second', 'admin');
    assert.equal(missingReport.status, 404);
    assert.match((await missingReport.json()).message, /has not written a report/);

    // The bundle must contain only this event's latest report and original photos.
    await store.addPhoto('second', 'another-coordinator', { ...photo, name: 'other-event.png' });
    const bundle = await get('/event-content/report.zip?eventId=first', 'admin');
    assert.equal(bundle.status, 200);
    assert.equal(bundle.headers.get('content-type'), 'application/zip');
    assert.match(bundle.headers.get('content-disposition'), /Music-report.zip/);
    const zip = await JSZip.loadAsync(await bundle.arrayBuffer());
    const text = await zip.file('report.txt').async('string');
    assert.match(text, /Updated report/);
    assert.match(text, /Event winners\n1\. Student Two \(EN002\)/);
    assert.ok(!text.includes('Student One'), 'Updated winner selections replace old winners');
    assert.match(text, /Fest: Campus Fest\nEvent: Music/);
    assert.match(text, /<script>plain text only<\/script>/);
    const photos = Object.values(zip.files).filter(file => !file.dir && file.name.startsWith('photos/'));
    assert.equal(photos.length, 2);
    for (const entry of photos) {
        assert.ok(!entry.name.includes('other-event'));
        assert.deepEqual(await entry.async('nodebuffer'), Buffer.from(PNG, 'base64'));
    }
    events.push({ id: 'report-only', name: 'Report only', createdBy: 'coordinator' });
    await store.saveReport('report-only', 'coordinator', { title: 'No album yet', body: 'Written report without photos.' });
    const reportOnly = await get('/event-content/report.zip?eventId=report-only', 'admin');
    assert.equal(reportOnly.status, 200);
    const reportZip = await JSZip.loadAsync(await reportOnly.arrayBuffer());
    assert.match(await reportZip.file('report.txt').async('string'), /Written report without photos/);
    assert.match(await reportZip.file('photos/README.txt').async('string'), /No photos/);
});
