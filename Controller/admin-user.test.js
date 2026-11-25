const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const test = require('node:test');

// Always use a separate local database; never change application accounts.
const testDatabase = `utsavfest_admin_user_test_${randomUUID().replace(/-/g, '')}`;
process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/${testDatabase}`;
const { mongoose } = require('../Model/db');
const users = require('../Model/userModel');
const { handleRequest, createSessionCookie } = require('./server');
const bcrypt = require('bcryptjs');

test('admin account management validates, creates, edits, and deletes each role', async () => {
    const server = http.createServer(handleRequest);
    try {
        await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
        await Promise.all([users.Student.init(), users.Faculty.init(), users.EventCoordinator.init()]);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        const previousCoordinatorLoginId = process.env.EVENT_COORDINATOR_LOGIN_ID;
        const previousCoordinatorPassword = process.env.EVENT_COORDINATOR_PASSWORD;
        const bootstrapLoginId = `co-${randomUUID().slice(0, 8)}@e.test`;
        const bootstrapPassword = 'StrongPass1!';
        try {
            delete process.env.EVENT_COORDINATOR_LOGIN_ID;
            delete process.env.EVENT_COORDINATOR_PASSWORD;
            assert.equal(await users.ensureDefaultEventCoordinator(), false, 'Do not seed a coordinator from hard-coded credentials');
            process.env.EVENT_COORDINATOR_LOGIN_ID = bootstrapLoginId;
            process.env.EVENT_COORDINATOR_PASSWORD = bootstrapPassword;
            assert.equal(await users.ensureDefaultEventCoordinator(), true);
            const bootstrappedCoordinator = await users.EventCoordinator.findOne({ loginId: bootstrapLoginId }).lean();
            assert.ok(bootstrappedCoordinator.password.startsWith('$2'));
            assert.equal((await users.loginUser(bootstrapLoginId, bootstrapPassword, 'event-coordinator')).success, true);
            assert.equal((await users.loginUser(bootstrapLoginId, 'WrongPass1!', 'event-coordinator')).success, false);
            await users.EventCoordinator.deleteOne({ loginId: bootstrapLoginId });
        } finally {
            if (previousCoordinatorLoginId === undefined) delete process.env.EVENT_COORDINATOR_LOGIN_ID;
            else process.env.EVENT_COORDINATOR_LOGIN_ID = previousCoordinatorLoginId;
            if (previousCoordinatorPassword === undefined) delete process.env.EVENT_COORDINATOR_PASSWORD;
            else process.env.EVENT_COORDINATOR_PASSWORD = previousCoordinatorPassword;
        }
        const cookie = role => createSessionCookie({ id: 'test-session', role });
        const submit = (data, role = 'admin', origin = base, method = 'POST') => fetch(`${base}/admin-dashboard/users`, {
            method, headers: { 'Content-Type': 'application/json', Cookie: cookie(role), Origin: origin }, body: JSON.stringify(data)
        });
        const edit = data => submit(data, 'admin', base, 'PATCH');
        const remove = data => submit(data, 'admin', base, 'DELETE');
        const common = { name: 'Test User', password: 'StrongPass1!', confirmPassword: 'StrongPass1!', collegeName: 'Test College', department: 'Computer Science' };
        assert.equal((await submit({}, 'student')).status, 403);
        assert.equal((await submit({}, 'faculty')).status, 403);
        assert.equal((await submit({}, 'event-coordinator')).status, 403);
        assert.equal((await submit({}, 'admin', 'http://other.example')).status, 403);
        assert.equal((await submit({ ...common, role: 'admin' })).status, 400);
        assert.equal((await submit({ ...common, role: 'faculty', email: 'invalid', mobileNumber: '123' })).status, 400);

        const student = { ...common, role: 'student', email: 'student@example.com', mobileNumber: '9000000001', semester: '2', gender: 'female', enrollmentNumber: 'ENR-1', picture: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7uoAAAAASUVORK5CYII=' };
        const faculty = { ...common, role: 'faculty', email: 'faculty@example.com', mobileNumber: '9000000002', gender: 'female' };
        const coordinator = { ...common, role: 'event-coordinator', email: 'coordinator@example.com', mobileNumber: '9000000003', instituteName: 'Test Institute', gender: 'other' };
        assert.equal((await submit({ ...student, picture: '' })).status, 400);
        assert.equal((await submit({ ...student, semester: '9' })).status, 400);
        assert.equal((await submit({ ...faculty, confirmPassword: 'WrongPass1!' })).status, 400);
        assert.equal((await submit({ ...coordinator, instituteName: '' })).status, 400);

        for (const [data, model] of [[student, users.Student], [faculty, users.Faculty], [coordinator, users.EventCoordinator]]) {
            const response = await submit(data);
            assert.equal(response.status, 201);
            const result = await response.json();
            assert.equal(result.success, true);
            assert.equal(result.user, undefined, 'Do not return credentials to the browser');
            const stored = await model.findOne({ email: data.email }).lean();
            assert.equal(stored.name, data.name);
            assert.equal(stored.mobileNumber, data.mobileNumber);
            assert.equal(stored.role, data.role);
            assert.equal(stored.gender, data.gender);
            assert.notEqual(stored.password, data.password);
            assert.equal(await bcrypt.compare(data.password, stored.password), true);
            assert.equal(stored.confirmPassword, undefined);
        }
        const storedCoordinator = await users.EventCoordinator.findOne({ email: coordinator.email }).lean();
        assert.equal(storedCoordinator.instituteName, coordinator.instituteName);
        assert.equal(storedCoordinator.gender, coordinator.gender);
        assert.equal(storedCoordinator.loginId, coordinator.email);
        assert.equal((await users.loginUser(coordinator.email, coordinator.password, 'event-coordinator')).success, true);
        assert.equal((await users.loginUser(student.email, student.password, 'student')).success, true);
        assert.equal((await users.loginUser(faculty.email, faculty.password, 'faculty')).success, true);
        assert.equal((await submit(student)).status, 409);
        assert.equal((await submit({ ...faculty, email: 'new@example.com', mobileNumber: student.mobileNumber })).status, 409);
        assert.equal((await submit({ ...student, email: 'newstudent@example.com', mobileNumber: '9000000004' })).status, 400);
        const accounts = await users.listUsersForAdmin();
        assert.equal(accounts.length, 3);
        assert.equal(accounts.find(account => account.role === 'faculty').gender, 'female');
        const response = await fetch(`${base}/admin-dashboard`, { headers: { Cookie: cookie('admin') } });
        const overview = await response.text();
        assert.equal(response.status, 200);
        assert.ok(overview.includes('id="add-user-button"'));
        assert.ok(overview.includes('/admin-users.js'));
        assert.ok(overview.includes('&quot;count&quot;:1') || overview.includes('&#34;count&#34;:1'));
        assert.ok(overview.includes('Account Management'));
        assert.ok(overview.includes('id="account-mobile-search"'));
        assert.equal((overview.match(/class="admin-account-row"/g) || []).length, 3);
        assert.equal((overview.match(/data-account-group=/g) || []).length, 3);
        assert.equal(accounts.find(account => account.role === 'student').enrollmentNumber, student.enrollmentNumber);
        assert.equal(accounts.find(account => account.role === 'event-coordinator').mobileNumber, coordinator.mobileNumber);
        assert.equal(accounts.find(account => account.role === 'event-coordinator').instituteName, coordinator.instituteName);
        for (const method of ['PATCH', 'DELETE']) {
            assert.equal((await submit({}, 'faculty', base, method)).status, 403);
            assert.equal((await submit({}, 'admin', 'http://other.example', method)).status, 403);
        }
        assert.equal((await remove({ role: 'admin', userId: 'protected' })).status, 400);
        assert.equal((await remove({ role: 'student', userId: 'missing' })).status, 404);
        assert.equal((await edit({ ...student, userId: 'missing' })).status, 404);
        const facultyRecord = await users.Faculty.findOne({ email: faculty.email }).lean();
        assert.equal((await edit({ ...faculty, userId: facultyRecord.id, mobileNumber: student.mobileNumber })).status, 409);
        assert.equal((await edit({ ...faculty, userId: facultyRecord.id, gender: 'invalid' })).status, 400);
        assert.equal((await remove({ role: 'student', userId: facultyRecord.id })).status, 404);

        for (const [index, [data, model]] of [[student, users.Student], [faculty, users.Faculty], [coordinator, users.EventCoordinator]].entries()) {
            const before = await model.findOne({ email: data.email }).lean();
            const changes = { ...data, userId: before.id, name: `Updated ${data.role}`, email: `u${index}@example.test`, mobileNumber: `900000010${index + 1}`, gender: 'male', password: '', confirmPassword: '' };
            delete changes.picture;
            if (data.role === 'faculty') {
                changes.password = 'NewStrongPass2!';
                changes.confirmPassword = changes.password;
            }
            if (data.role === 'student') changes.semester = '5';
            if (data.role === 'event-coordinator') changes.instituteName = 'Updated Institute';
            assert.equal((await edit(changes)).status, 200);
            const after = await model.findOne({ id: before.id }).lean();
            assert.equal(after.name, changes.name);
            assert.equal(after.email, changes.email);
            assert.equal(after.mobileNumber, changes.mobileNumber);
            assert.equal(after.gender, changes.gender);
            if (data.role === 'faculty') assert.equal(await bcrypt.compare(changes.password, after.password), true);
            else assert.equal(after.password, before.password, 'Blank password preserves the stored hash');
            if (data.role === 'student') { assert.equal(after.picture, before.picture); assert.equal(after.semester, '5'); }
            if (data.role === 'event-coordinator') { assert.equal(after.instituteName, 'Updated Institute'); assert.equal(after.loginId, changes.email); }
            assert.equal((await users.loginUser(changes.email, changes.password || data.password, data.role)).success, true);
            assert.equal((await remove({ role: data.role, userId: before.id })).status, 200);
            assert.equal(await model.countDocuments({ id: before.id }), 0);
            assert.equal((await remove({ role: data.role, userId: before.id })).status, 404);
        }
        assert.equal((await users.listUsersForAdmin()).length, 0);
    } finally {
        if (server.listening) await new Promise(resolve => server.close(resolve));
        if (mongoose.connection.readyState === 1) {
            assert.equal(mongoose.connection.name, testDatabase);
            await mongoose.connection.dropDatabase();
        }
        await mongoose.disconnect();
    }
});
