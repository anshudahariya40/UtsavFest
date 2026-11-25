const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { generateOtp, createPasswordResetService } = require('./password-reset');
const { sendPasswordOtp } = require('./httpsms');

function fixture(options = {}) {
    let time = 1000000;
    const deliveries = [];
    const updates = [];
    const service = createPasswordResetService({
        now: () => time,
        findAccount: async (mobileNumber, role) => ({ id: role, mobileNumber, role }),
        deliverOtp: async data => deliveries.push(data),
        updatePassword: async (...data) => updates.push(data),
        ...options
    });
    return { service, deliveries, updates, advance: ms => { time += ms; } };
}
const input = { mobileNumber: '9000000011', role: 'student' };

test('OTPs have seven cryptographically generated characters including letters and digits', () => {
    for (let i = 0; i < 1000; i++) {
        const otp = generateOtp();
        assert.match(otp, /^[A-Z0-9]{7}$/);
        assert.match(otp, /[A-Z]/);
        assert.match(otp, /[0-9]/);
    }
});

test('password changes require OTP verification and a one-time reset token', async () => {
    const f = fixture();
    const request = await f.service.request(input, 'ip1');
    assert.equal(request.success, true);
    assert.equal(request.otp, undefined);
    const data = { requestId: request.requestId, password: 'StrongPass1!', confirmPassword: 'StrongPass1!' };
    assert.equal((await f.service.reset(data)).success, false);
    assert.equal(f.service.verify({ requestId: data.requestId, otp: 'INVALID' }).success, false);
    const verified = f.service.verify({ requestId: data.requestId, otp: f.deliveries[0].otp.toLowerCase() });
    assert.equal(verified.success, true);
    assert.equal(f.service.verify({ requestId: data.requestId, otp: f.deliveries[0].otp }).success, false);
    assert.equal((await f.service.reset({ ...data, resetToken: '0'.repeat(64) })).success, false);
    assert.equal((await f.service.reset({ ...data, resetToken: verified.resetToken, confirmPassword: 'Wrong' })).success, false);
    assert.equal((await f.service.reset({ ...data, resetToken: verified.resetToken, password: 'weak', confirmPassword: 'weak' })).success, false);
    assert.equal((await f.service.reset({ ...data, resetToken: verified.resetToken })).success, true);
    assert.equal((await f.service.reset({ ...data, resetToken: verified.resetToken })).success, false);
    assert.equal(f.updates.length, 1);
});

test('expiry, guess limits, resend invalidation, and request limits are enforced', async () => {
    const f = fixture();
    let r = await f.service.request(input, 'ip1');
    for (let i = 0; i < 5; i++) assert.equal(f.service.verify({ requestId: r.requestId, otp: 'INVALID' }).success, false);
    assert.equal(f.service.verify({ requestId: r.requestId, otp: f.deliveries[0].otp }).success, false);
    assert.equal((await f.service.request(input, 'ip1')).success, false);
    f.advance(60001);
    r = await f.service.request(input, 'ip1');
    f.advance(60001);
    const newer = await f.service.request(input, 'ip2');
    assert.equal(f.service.verify({ requestId: r.requestId, otp: f.deliveries[1].otp }).success, false);
    f.advance(10 * 60 * 1000);
    assert.equal(f.service.verify({ requestId: newer.requestId, otp: f.deliveries[2].otp }).success, false);
    r = await f.service.request(input, 'ip3');
    const verified = f.service.verify({ requestId: r.requestId, otp: f.deliveries[3].otp });
    f.advance(5 * 60 * 1000);
    assert.equal((await f.service.reset({ requestId: r.requestId, resetToken: verified.resetToken, password: 'StrongPass1!', confirmPassword: 'StrongPass1!' })).success, false);
    const limited = fixture();
    for (let i = 0; i < 5; i++) {
        assert.equal((await limited.service.request(input, `ip${i}`)).success, true);
        limited.advance(60001);
    }
    assert.equal((await limited.service.request(input, 'another')).success, false);
});

test('unknown accounts cannot verify and failed delivery invalidates the request', async () => {
    const unknown = fixture({ findAccount: async () => null });
    const r = await unknown.service.request(input, 'ip1');
    assert.equal(r.success, false);
    assert.equal(r.message, 'No account is registered with this mobile number for the selected account type.');
    assert.equal(unknown.deliveries.length, 0);
    assert.equal(unknown.service.verify({ requestId: r.requestId, otp: 'ABC1234' }).success, false);
    const failed = fixture({ deliverOtp: async () => { throw new Error('SMS failed'); } });
    await assert.rejects(failed.service.request(input, 'ip2'), /SMS failed/);
});

test('httpSMS uses server credentials and international numbers; provider failures reject', async () => {
    const env = { HTTPSMS_API_KEY: 'test-key', HTTPSMS_FROM: '+919000000010', HTTPSMS_COUNTRY_CODE: '+91' };
    let sent;
    const fetchImpl = async (url, options) => {
        sent = { url, options, body: JSON.parse(options.body) };
        return { ok: true, json: async () => ({ status: 'success', data: { id: 'message-id', status: 'pending' } }) };
    };
    assert.deepEqual(await sendPasswordOtp({ mobileNumber: input.mobileNumber, otp: 'ABC1234' }, { env, fetchImpl }), { messageId: 'message-id' });
    assert.equal(sent.url, 'https://api.httpsms.com/v1/messages/send');
    assert.equal(sent.options.headers['x-api-key'], 'test-key');
    assert.equal(sent.body.from, env.HTTPSMS_FROM);
    assert.equal(sent.body.to, '+919000000011');
    assert.match(sent.body.content, /ABC1234/);
    await assert.rejects(sendPasswordOtp({ mobileNumber: input.mobileNumber, otp: 'ABC1234' }, { env, fetchImpl: async () => ({ ok: false, status: 401 }) }), /HTTP 401/);
    await assert.rejects(sendPasswordOtp({ mobileNumber: input.mobileNumber, otp: 'ABC1234' }, { env: {}, fetchImpl }), /Configure/);
});

test('local HTTP routes reset student and faculty passwords in MongoDB', async () => {
    const testDatabase = `utsavfest_reset_test_${randomUUID().replace(/-/g, '')}`;
    process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/${testDatabase}`;
    const users = require('../Model/userModel');
    const { mongoose } = require('../Model/db');
    const { handleRequest } = require('./server');
    const originalFetch = global.fetch;
    const originalEnv = { ...process.env };
    const messages = [];
    process.env.HTTPSMS_API_KEY = 'test-key';
    process.env.HTTPSMS_FROM = '+919000000010';
    global.fetch = async (url, options) => {
        if (url === 'https://api.httpsms.com/v1/messages/send') {
            messages.push(JSON.parse(options.body));
            return { ok: true, json: async () => ({ status: 'success', data: { id: randomUUID(), status: 'pending' } }) };
        }
        return originalFetch(url, options);
    };
    const server = http.createServer(handleRequest);
    try {
        await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        const post = async (route, body) => {
            const response = await originalFetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            assert.equal(response.headers.get('cache-control'), 'no-store');
            return response.json();
        };
        const bcrypt = require('bcryptjs');
        const roleAccounts = [];
        for (const [index, role] of ['student', 'faculty'].entries()) {
            const account = { id: randomUUID(), email: `${role}@test.example`, mobileNumber: `90000000${30 + index}`, role,
                password: await bcrypt.hash('OriginalPass1!', 4), enrollmentNumber: 'RESET001' };
            await (role === 'student' ? users.Student : users.Faculty).create(account);
            roleAccounts.push(account);
        }
        // Use one request and two verification/reset steps for each role. The request IP has a cooldown.
        const student = roleAccounts[0];
        const r = await post('/forgot-password', { mobileNumber: student.mobileNumber, role: student.role });
        assert.equal(r.success, true);
        const otp = messages[0].content.match(/OTP is ([A-Z0-9]{7})/)[1];
        assert.equal(JSON.stringify(r).includes(otp), false);
        const v = await post('/verify-password-otp', { requestId: r.requestId, otp });
        assert.equal(v.success, true);
        const resetData = { requestId: r.requestId, resetToken: v.resetToken, password: 'Updated+Pass2!&%', confirmPassword: 'Updated+Pass2!&%' };
        const resetResult = await post('/update-password', resetData);
        assert.equal(resetResult.success, true);
        assert.deepEqual(resetResult.login, { email: student.email, role: 'student' });
        const persistedStudent = await users.Student.findById((await users.Student.findOne({ id: student.id }))._id).lean();
        assert.equal(await bcrypt.compare(resetData.password, persistedStudent.password), true);
        assert.equal((await post('/update-password', resetData)).success, false);
        assert.equal((await users.loginUser(student.email, 'OriginalPass1!', 'student')).success, false);
        assert.equal((await users.loginUser(student.email, resetData.password, 'student')).success, true);
        const loginForm = new FormData();
        loginForm.set('role', 'student');
        loginForm.set('email', student.email);
        loginForm.set('password', resetData.password);
        const loginResponse = await originalFetch(base + '/login', { method: 'POST', body: loginForm });
        const loginPage = await loginResponse.text();
        assert.equal(loginResponse.status, 200, loginPage.slice(0, 500));
        assert.match(loginPage, /<title>Dashboard \| UtsavFest<\/title>/);
        assert.ok(loginResponse.headers.get('set-cookie'));
        const { chromium } = require('playwright');
        const browser = await chromium.launch({ headless: true });
        try {
            const page = await browser.newPage();
            await page.goto(base + '/login');
            await page.locator('#emailInput').fill(student.email);
            await page.locator('#passwordInput').fill(resetData.password);
            await Promise.all([
                page.waitForNavigation(),
                page.locator('.auth-card > form button[type="submit"]').click()
            ]);
            assert.equal(await page.title(), 'Dashboard | UtsavFest');
        } finally {
            await browser.close();
        }
        const faculty = roleAccounts[1];
        // Verify the same model storage path independently without bypassing the route cooldown.
        const facultyAccount = await users.findPasswordResetAccount(faculty.mobileNumber, 'faculty');
        await users.updatePasswordResetAccount(facultyAccount, 'FacultyPass2!');
        assert.equal((await users.loginUser(faculty.email, 'FacultyPass2!', 'faculty')).success, true);
        assert.equal((await users.loginUser(faculty.email, 'OriginalPass1!', 'faculty')).success, false);
        assert.equal(await users.findPasswordResetAccount(student.mobileNumber, 'faculty'), null);
        assert.match((await users.Student.findOne({ id: student.id }).lean()).password, /^\$2/);
        const page = await (await originalFetch(base + '/login')).text();
        assert.match(page, /passwordOtpForm/);
        assert.match(page, /updatePasswordForm/);
        assert.equal(page.includes(process.env.HTTPSMS_API_KEY), false);
        const vm = require('node:vm');
        for (const script of page.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
    } finally {
        global.fetch = originalFetch;
        process.env = originalEnv;
        if (mongoose.connection.name === testDatabase) await mongoose.connection.dropDatabase();
        await mongoose.disconnect();
        if (server.listening) await new Promise(resolve => server.close(resolve));
    }
});
