const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const bcrypt = require('bcryptjs');

const testDatabase = `utsavfest_approval_test_${randomUUID().replace(/-/g, '')}`;
process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/${testDatabase}`;
const { mongoose } = require('../Model/db');
const users = require('../Model/userModel');
const { handleRequest, createSessionCookie } = require('./server');

test('self registration requires approval; Approve enables login; Stay revokes login and sessions', async () => {
    const server = http.createServer(handleRequest);
    try {
        await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
        await Promise.all([users.Student.init(), users.Faculty.init()]);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        const adminCookie = createSessionCookie({ id: 'test-admin', role: 'admin' });
        const tooLongEmail = 'faculty.registration.address.too.long@example.com';
        const tooLongRegistration = await fetch(`${base}/register`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ role: 'faculty', teacherName: 'Too Long Email', email: tooLongEmail, mobileNumber: '9000000020', password: 'StrongPass1!', confirmPassword: 'StrongPass1!' }) });
        assert.ok((await tooLongRegistration.text()).includes('valid email address up to 30 characters.'));

        const publicFaculty = { role: 'faculty', teacherName: 'Self Registered Faculty', email: 'pending.faculty@example.com', mobileNumber: '9000000011', adminCollege: 'Test College', adminDepartment: 'Computing', gender: 'other', password: 'StrongPass1!', confirmPassword: 'StrongPass1!', approvalStatus: 'approved', registrationSource: 'admin', adminCreated: 'true' };
        const register = await fetch(`${base}/register`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(publicFaculty) });
        assert.ok((await register.text()).includes('Approval Pending From Admin'));
        const faculty = await users.Faculty.findOne({ email: publicFaculty.email }).lean();
        assert.equal(faculty.approvalStatus, 'pending');
        assert.equal(faculty.registrationSource, 'self', 'Public request cannot grant its own approval');
        assert.equal(faculty.gender, publicFaculty.gender, 'Faculty gender should be persisted in MongoDB');
        assert.equal((await users.loginUser(publicFaculty.email, publicFaculty.password, 'faculty')).message, 'Approval Pending From Admin');
        assert.equal((await users.loginUser(publicFaculty.mobileNumber, publicFaculty.password, 'faculty')).message, 'Approval Pending From Admin');
        assert.equal((await users.loginUserByPhone(publicFaculty.mobileNumber, 'faculty')).message, 'Approval Pending From Admin');
        assert.equal((await users.loginUser(publicFaculty.email, 'Incorrect1!', 'faculty')).success, false);
        const login = () => fetch(`${base}/login`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ role: 'faculty', email: publicFaculty.email, password: publicFaculty.password }) });
        const blockedLogin = await login();
        assert.ok((await blockedLogin.text()).includes('Approval Pending From Admin'));
        assert.equal(blockedLogin.headers.get('set-cookie'), null);
        const approve = (approvalStatus, cookie = adminCookie, userId = faculty.id, origin = base) => fetch(`${base}/admin-dashboard/approvals`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: origin }, body: JSON.stringify({ userId, approvalStatus }) });
        assert.equal((await approve('approved', '')).status, 403);
        assert.equal((await approve('approved', adminCookie, faculty.id, 'http://other.example')).status, 403);
        assert.equal((await approve('invalid')).status, 400);
        assert.equal((await approve('approved', adminCookie, 'missing')).status, 404);
        const pendingPage = await fetch(`${base}/admin-dashboard/approvals`, { headers: { Cookie: adminCookie } });
        const pendingHtml = await pendingPage.text();
        assert.equal(pendingPage.status, 200);
        assert.ok(pendingHtml.includes('Pending Faculties'));
        assert.ok(pendingHtml.includes('Approved Faculties'));
        assert.ok(pendingHtml.includes('Self registered'));
        assert.ok(pendingHtml.includes('data-approval-next="approved"'));
        assert.equal((await approve('approved')).status, 200);
        assert.equal((await users.loginUser(publicFaculty.email, publicFaculty.password, 'faculty')).success, true);
        const approvedLogin = await login();
        assert.ok(approvedLogin.headers.get('set-cookie'));
        const facultyCookie = approvedLogin.headers.get('set-cookie').split(';')[0];
        const approvedAccess = await fetch(`${base}/`, { headers: { Cookie: facultyCookie } });
        assert.ok(!(await approvedAccess.text()).includes('Approval Pending From Admin'));
        assert.equal((await approve('pending')).status, 200);
        assert.equal((await users.loginUser(publicFaculty.email, publicFaculty.password, 'faculty')).message, 'Approval Pending From Admin');
        assert.equal((await users.loginUserByPhone(publicFaculty.mobileNumber, 'faculty')).success, false);
        const revokedAccess = await fetch(`${base}/`, { headers: { Cookie: facultyCookie } });
        assert.ok((await revokedAccess.text()).includes('Approval Pending From Admin'));
        assert.ok(revokedAccess.headers.get('set-cookie').includes('max-age=0'));
        const revokedAction = await fetch(`${base}/save-custom-form`, { method: 'POST', headers: { Cookie: facultyCookie, 'Content-Type': 'application/json' }, body: '{}' });
        assert.equal(revokedAction.status, 403);
        assert.equal((await revokedAction.json()).message, 'Approval Pending From Admin');
        assert.equal((await approve('approved')).status, 200, 'A stayed faculty can be approved again');

        const adminAdded = await users.createManagedUser({ role: 'faculty', name: 'Admin Added Faculty', email: 'admin-added@example.com', mobileNumber: '9000000012', collegeName: 'Test College', department: 'Computing', password: 'StrongPass1!', confirmPassword: 'StrongPass1!' });
        assert.equal(adminAdded.success, true);
        const activeFaculty = await users.Faculty.findOne({ email: 'admin-added@example.com' }).lean();
        assert.equal(activeFaculty.approvalStatus, 'approved');
        assert.equal(activeFaculty.registrationSource, 'admin');
        assert.equal((await users.loginUser(activeFaculty.email, 'StrongPass1!', 'faculty')).success, true);
        const legacyId = randomUUID();
        await users.Faculty.collection.insertOne({ id: legacyId, role: 'faculty', name: 'Existing Faculty', email: 'legacy@example.com', mobileNumber: '9000000013', password: await bcrypt.hash('StrongPass1!', 12) });
        assert.equal((await users.loginUser('legacy@example.com', 'StrongPass1!', 'faculty')).success, true, 'Existing faculty remain active');
        assert.equal((await approve('pending', adminCookie, legacyId)).status, 200);
        assert.equal((await users.loginUser('legacy@example.com', 'StrongPass1!', 'faculty')).message, 'Approval Pending From Admin');
        assert.equal((await users.listUsersForAdmin()).find(account => account.id === legacyId).approvalStatus, 'pending');
    } finally {
        if (server.listening) await new Promise(resolve => server.close(resolve));
        try {
            if (mongoose.connection.readyState === 1) {
                assert.equal(mongoose.connection.name, testDatabase);
                await mongoose.connection.dropDatabase();
            }
        } finally {
            await mongoose.disconnect();
        }
    }
});
