const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const test = require('node:test');

process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/utsavfest_persist_test_${randomUUID().replace(/-/g, '')}`;
const { mongoose } = require('../Model/db');
const events = require('../Model/festivalModel1');
const { handleRequest } = require('./server');

test('event edits and deletions survive fresh sessions and database reloads', async () => {
    const server = http.createServer(handleRequest);
    try {
        await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
        await events.loadFestivals();
        assert.equal(events.getFestivals().length, 0, 'An empty database stays empty');
        const image = 'https://example.com/shared-cover.png';
        const first = (await events.addFestival({ eventName: 'First Event', eventLocation: 'Hall', image })).festival;
        const second = (await events.addFestival({ eventName: 'Second Event', eventLocation: 'Hall', image })).festival;
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        const cookie = role => `utsavfest_user=${encodeURIComponent(JSON.stringify({ id: 'coordinator-test', name: 'Coordinator', role }))}`;
        const post = (path, payload, role = 'event-coordinator') => fetch(base + path, {
            method: 'POST', headers: { Cookie: cookie(role), 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const edit = { festivalId: first.id, eventName: 'Edited Event', eventLocation: 'Updated Venue', image };
        assert.equal((await post('/edit-festival', edit)).status, 200);
        await events.loadFestivals();
        assert.equal(events.getFestivalById(first.id).name, 'Edited Event');
        assert.equal(events.getFestivalById(first.id).location, 'Updated Venue');
        assert.equal(events.getFestivalById(first.id).image, image, 'Shared cover images remain as chosen');
        assert.equal(events.getFestivalById(second.id).image, image);
        const freshPage = await (await fetch(base, { headers: { Cookie: cookie('event-coordinator') } })).text();
        assert.match(freshPage, /Edited Event/);
        assert.match(freshPage, /festival-delete-button/);
        assert.equal((await post('/delete-festival', { festivalId: first.id }, 'student')).status, 403);

        const originalUpdate = events.Festival.findOneAndUpdate;
        try {
            events.Festival.findOneAndUpdate = async () => { throw new Error('Test write failure'); };
            const failed = await post('/edit-festival', { ...edit, eventName: 'Unsaved Name' });
            assert.equal(failed.status, 400);
            assert.equal((await failed.json()).success, false);
            assert.equal(events.getFestivalById(first.id).name, 'Edited Event', 'Failed edits do not change the cache');
        } finally {
            events.Festival.findOneAndUpdate = originalUpdate;
        }
        assert.equal((await post('/delete-festival', { festivalId: first.id })).status, 200);
        assert.equal(await events.Festival.countDocuments({ id: first.id }), 0);
        await events.loadFestivals();
        const afterDelete = await (await fetch(base, { headers: { Cookie: cookie('event-coordinator') } })).text();
        assert.ok(!afterDelete.includes('Edited Event'));
        assert.equal((await fetch(`${base}/festival/${first.id}`)).status, 404);
        assert.equal((await post('/delete-festival', { festivalId: second.id })).status, 200);
        await events.loadFestivals();
        assert.equal(events.getFestivals().length, 0, 'Deleted events and sample events do not return');
        delete require.cache[require.resolve('../Model/festivalModel1')];
        const freshModel = require('../Model/festivalModel1');
        await freshModel.loadFestivals();
        assert.equal(freshModel.getFestivals().length, 0, 'A fresh model also loads the empty database');
    } finally {
        if (server.listening) await new Promise(resolve => server.close(resolve));
        try {
            if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
        } finally {
            await mongoose.disconnect();
        }
    }
});
