const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const { chromium } = require('playwright');
const { handleRequest } = require('./server');

test('browser popup requests SMS, verifies OTP, and allows a password update', async () => {
    const server = http.createServer(handleRequest);
    let browser;
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        const calls = [];
        await page.route('**/forgot-password', async route => {
            calls.push(route.request().postDataJSON());
            await route.fulfill({ json: { success: true, requestId: 'test-request', message: 'OTP requested.' } });
        });
        await page.route('**/verify-password-otp', async route => {
            calls.push(route.request().postDataJSON());
            await route.fulfill({ json: { success: true, resetToken: 'verified-token', message: 'OTP verified.' } });
        });
        await page.route('**/update-password', async route => {
            calls.push(route.request().postDataJSON());
            await route.fulfill({ json: { success: true, login: { email: 'faculty@test.example', role: 'faculty' }, message: 'Password saved and verified.' } });
        });
        page.on('dialog', dialog => dialog.accept());
        await page.goto(`http://127.0.0.1:${server.address().port}/login`);
        assert.equal(await page.locator('nav .logo img').evaluate(image => image.complete && image.naturalWidth > 0), true);
        await page.locator('#roleSelect').selectOption('event-coordinator');
        assert.equal(await page.locator('#loginIdInput').getAttribute('maxlength'), '254');
        await page.locator('#roleSelect').selectOption('student');
        await page.locator('#forgotPasswordBtn').click();
        await page.locator('#forgotPasswordForm input[name="mobileNumber"]').fill('9000000011');
        await page.locator('#forgotPasswordForm button[type="submit"]').click();
        await page.locator('#passwordOtpForm').waitFor({ state: 'visible' });
        await page.locator('#passwordOtpForm input').fill('ABC1234');
        await page.locator('#passwordOtpForm button[type="submit"]').click();
        await page.locator('#updatePasswordForm').waitFor({ state: 'visible' });
        await page.locator('#updatePasswordForm input[name="password"]').fill('StrongPass2!');
        await page.locator('#updatePasswordForm input[name="confirmPassword"]').fill('WrongPass2!');
        await page.locator('#updatePasswordForm button[type="submit"]').click();
        assert.equal(await page.locator('#recoveryMessage').textContent(), 'Passwords do not match.');
        assert.equal(calls.length, 2);
        await page.locator('#updatePasswordForm input[name="confirmPassword"]').fill('StrongPass2!');
        await page.locator('#updatePasswordForm button[type="submit"]').click();
        await page.waitForFunction(() => !document.getElementById('forgotPasswordModal').classList.contains('active'));
        assert.deepEqual(calls[0], { role: 'student', mobileNumber: '9000000011' });
        assert.deepEqual(calls[1], { otp: 'ABC1234', requestId: 'test-request' });
        assert.equal(calls[2].resetToken, 'verified-token');
        assert.equal(await page.locator('#emailInput').inputValue(), 'faculty@test.example');
        assert.equal(await page.locator('#roleSelect').inputValue(), 'faculty');
        assert.equal(await page.locator('#passwordInput').inputValue(), '');
        assert.deepEqual(errors, []);
        await page.locator('#forgotPasswordBtn').click();
        assert.equal(await page.locator('#forgotPasswordForm').isVisible(), true);
        assert.equal(await page.locator('#updatePasswordForm').isVisible(), false);
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#forgotPasswordModal').isVisible(), false);
    } finally {
        if (browser) await browser.close();
        if (server.listening) await new Promise(resolve => server.close(resolve));
    }
});
