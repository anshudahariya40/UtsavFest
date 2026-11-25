const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const test = require('node:test');

process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/utsavfest_co_part_test_${randomUUID().replace(/-/g, '')}`;
const { mongoose } = require('../Model/db');
const users = require('../Model/userModel');
const events = require('../Model/festivalModel1');
const { handleRequest } = require('./server');

test('coordinator adds registered students to their own events using stored profile details', async () => {
    const server = http.createServer(handleRequest);
    try {
        await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
        await users.Student.create({
            id: 'student-test', role: 'student', name: 'Test Student', email: 'student@example.test',
            password: 'test-password', mobileNumber: '9000000001', enrollmentNumber: 'TEST001',
            department: 'Engineering', semester: '3', collegeName: 'Test College', gender: 'female'
        });
        const own = (await events.addFestival({ eventName: 'Own Event', festName: 'First Fest', eventLocation: 'Hall', createdBy: 'coordinator-test' })).festival;
        const other = (await events.addFestival({ eventName: 'Other Event', festName: 'Other Fest', eventLocation: 'Hall', createdBy: 'other-coordinator' })).festival;
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        const cookie = role => `utsavfest_user=${encodeURIComponent(JSON.stringify({ id: 'coordinator-test', role }))}`;
        const post = (payload, role = 'event-coordinator') => fetch(`${base}/coordinator/add-participant`, {
            method: 'POST', headers: { Cookie: cookie(role), 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(payload)
        });
        const payload = { eventId: own.id, studentIdentifier: ' test001 ' };
        assert.equal((await post(payload, 'student')).status, 403);
        assert.equal((await post(payload, 'admin')).status, 403);
        assert.equal((await post({ ...payload, eventId: other.id })).status, 403);
        assert.equal((await post({ ...payload, studentIdentifier: 'missing' })).status, 404);
        assert.equal((await post({ ...payload, studentIdentifier: '' })).status, 400);
        const response = await post({ ...payload, studentName: 'Spoofed', department: 'Spoofed', email: 'spoof@example.test' });
        assert.equal(response.status, 200);
        const result = await response.json();
        assert.equal(result.success, true);
        const record = await events.EventParticipation.findOne({ eventId: own.id }).lean();
        assert.equal(record.studentId, 'student-test');
        assert.equal(record.studentName, 'Test Student');
        assert.equal(record.department, 'Engineering');
        assert.equal(record.email, 'student@example.test');
        assert.equal(record.semester, '3');
        assert.equal(record.fieldOfInterest, '');
        assert.equal(record.eventName, 'Own Event');
        assert.equal((await post(payload)).status, 409);
        assert.equal(await events.EventParticipation.countDocuments({ eventId: own.id }), 1);
        const dashboard = await (await fetch(base, { headers: { Cookie: cookie('event-coordinator') } })).text();
        assert.match(dashboard, /Add Participants/);
        assert.match(dashboard, /View Participants/);
        assert.match(dashboard, /Choose fest/);
        assert.match(dashboard, /studentIdentifier/);
        assert.ok(!dashboard.includes('participant-identifier-type'), 'One field identifies enrollment or mobile automatically');
        assert.ok(!dashboard.includes('student@example.test'), 'Student directory is not embedded in the dashboard');
        const getList = (eventId, role = 'event-coordinator') => fetch(`${base}/coordinator/participants?eventId=${eventId}`, { headers: { Cookie: cookie(role) } });
        assert.equal((await getList(own.id, 'student')).status, 403);
        assert.equal((await getList(other.id)).status, 403);
        const list = await (await getList(own.id)).json();
        assert.equal(list.participants.length, 1);
        assert.equal(list.participants[0].studentName, 'Test Student');
        assert.equal(list.participants[0].enrollmentNumber, 'TEST001');
        assert.ok(!JSON.stringify(list).includes('test-password'));
        const next = (await events.addFestival({ eventName: 'Next Event', festName: 'Second Fest', eventLocation: 'Hall', createdBy: 'coordinator-test' })).festival;
        assert.equal((await post({ eventId: next.id, studentIdentifier: '90000 00001' })).status, 200);
        assert.equal((await (await getList(next.id)).json()).participants.length, 1);
        assert.equal((await (await getList(own.id)).json()).participants.length, 1, 'Event lists remain separate');
        assert.equal((await post({ eventId: next.id, studentIdentifier: 'invalid9000000001' })).status, 404);
        assert.equal((await users.findStudentForParticipation('+91 90000 00001')).id, 'student-test');
        await users.Student.create({
            id: 'numeric-student', role: 'student', name: 'Numeric Enrollment', email: 'numeric@example.test',
            password: 'test-password', mobileNumber: '9000000002', enrollmentNumber: '001234567890123456',
            department: 'Arts', semester: '2', collegeName: 'Test College'
        });
        assert.equal((await users.findStudentForParticipation('001234567890123456')).id, 'numeric-student');
        await users.Student.create({
            id: 'ambiguous-student', role: 'student', name: 'Ambiguous Enrollment', email: 'ambiguous@example.test',
            password: 'test-password', mobileNumber: '9000000003', enrollmentNumber: '9000000001',
            department: 'Arts', semester: '2', collegeName: 'Test College'
        });
        const ambiguous = await post({ eventId: next.id, studentIdentifier: '9000000001' });
        assert.equal(ambiguous.status, 400);
        assert.match((await ambiguous.json()).message, /more than one student/);
        await events.loadFestivals();
        assert.equal((await (await getList(next.id)).json()).participants[0].department, 'Engineering');
    } finally {
        if (server.listening) await new Promise(resolve => server.close(resolve));
        try {
            if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
        } finally {
            await mongoose.disconnect();
        }
    }
});
