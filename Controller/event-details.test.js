const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const test = require('node:test');

// Use a disposable database so application events remain untouched.
process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/utsavfest_event_details_test_${randomUUID().replace(/-/g, '')}`;
const { mongoose } = require('../Model/db');
const events = require('../Model/festivalModel1');
const { handleRequest } = require('./server');

test('coordinator event fields validate, persist, display, and survive edits', async () => {
    const server = http.createServer(handleRequest);
    try {
        await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        const Cookie = `utsavfest_user=${encodeURIComponent(JSON.stringify({ id: 'coordinator-test', role: 'event-coordinator' }))}`;
        const post = (path, data) => fetch(base + path, {
            method: 'POST', headers: { Cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(data)
        });
        const payload = {
            festName: 'Campus Fest', eventName: 'Music Night', eventLocation: 'Main Hall',
            eventDate: '2026-12-20', time: '18:30', chiefGuest: 'Guest Speaker',
            description: 'An evening of student performances.', image: 'https://example.com/cover.png'
        };
        for (const field of Object.keys(payload)) {
            const incomplete = { ...payload };
            delete incomplete[field];
            assert.equal((await post('/add-event', incomplete)).status, 400, `${field} is required`);
        }
        assert.equal((await post('/add-event', { ...payload, time: '25:00' })).status, 400);
        assert.equal((await post('/add-event', { ...payload, eventDate: '2026-02-30' })).status, 400);
        assert.equal((await post('/add-event', { ...payload, notification: 'x'.repeat(501) })).status, 400);
        const response = await post('/add-event', payload);
        assert.equal(response.status, 200);
        const { festival } = await response.json();
        const saved = await events.Festival.findOne({ id: festival.id }).lean();
        for (const field of ['festName', 'time', 'chiefGuest', 'description', 'image']) assert.equal(saved[field], payload[field]);
        assert.equal(saved.name, payload.eventName);
        assert.equal(saved.location, payload.eventLocation);
        assert.equal(saved.createdBy, 'coordinator-test');

        const update = await post('/edit-festival', {
            festivalId: festival.id, eventName: payload.eventName, eventLocation: payload.eventLocation,
            chiefGuest: 'Updated Guest', notification: '<Please arrive early>'
        });
        assert.equal((await update.json()).success, true);
        await events.loadFestivals();
        const reloaded = events.getFestivalById(festival.id);
        assert.equal(reloaded.festName, payload.festName);
        assert.equal(reloaded.time, payload.time);
        assert.equal(reloaded.description, payload.description);
        assert.equal(reloaded.chiefGuest, 'Updated Guest');
        assert.equal(reloaded.notification, '<Please arrive early>');
        const details = await (await fetch(`${base}/festival/${festival.id}`)).text();
        assert.match(details, /Campus Fest/);
        assert.match(details, /18:30/);
        assert.match(details, /Updated Guest/);
        assert.match(details, /An evening of student performances/);
        assert.match(details, /&lt;Please arrive early&gt;/);
        await post('/edit-festival', {
            festivalId: festival.id, eventName: payload.eventName,
            eventLocation: payload.eventLocation, notification: ''
        });
        assert.equal((await events.Festival.findOne({ id: festival.id }).lean()).notification, '');
    } finally {
        if (server.listening) await new Promise(resolve => server.close(resolve));
        if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
        await mongoose.disconnect();
    }
});
