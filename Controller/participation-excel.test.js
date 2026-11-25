const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const test = require('node:test');
const ExcelJS = require('exceljs');
const { chromium } = require('playwright');

process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/utsavfest_excel_test_${randomUUID().replace(/-/g, '')}`;
const { mongoose } = require('../Model/db');
const users = require('../Model/userModel');
const events = require('../Model/festivalModel1');
const { handleRequest } = require('./server');

test('admin Excel import selects fest/event, matches students, saves registrations and previews all outcomes', async () => {
    const server = http.createServer(handleRequest);
    let browser;
    try {
        await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
        await users.EventCoordinator.create({ id: 'coordinator', name: 'Coordinator', email: 'coordinator@example.test', role: 'event-coordinator', password: 'test-password' });
        for (const [id, name, enrollmentNumber, mobileNumber, semester] of [
            ['student1', '<img src=x onerror=alert(1)>', 'ENR001', '9000000011', '2'],
            ['student2', 'Second Student', '001234', '9000000012', '3'],
            ['student3', 'Incomplete Student', 'ENR003', '9000000013', '']
        ]) {
            await users.Student.create({ id, name, enrollmentNumber, mobileNumber, semester, email: `${id}@example.test`, role: 'student', password: 'test-password', department: 'Arts', collegeName: 'Test College' });
        }
        await events.loadFestivals();
        const first = (await events.addFestival({ eventName: 'Dance', festName: 'Fest A', eventLocation: 'Hall', createdBy: 'coordinator' })).festival;
        const second = (await events.addFestival({ eventName: 'Music', festName: 'Fest B', eventLocation: 'Hall', createdBy: 'coordinator' })).festival;
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        const cookie = role => `utsavfest_user=${encodeURIComponent(JSON.stringify({ id: 'admin-test', role }))}`;
        const payload = { eventId: first.id, rows: [{ sheet: 'Students', rowNumber: 2, identifiers: ['ENR001'] }] };
        const post = (data, role = 'admin') => fetch(`${base}/admin-dashboard/participation/import`, { method: 'POST', headers: { Cookie: cookie(role), 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
        assert.equal((await post(payload, 'student')).status, 403);
        assert.equal((await post(payload, 'event-coordinator')).status, 403);
        assert.equal((await post({ ...payload, eventId: 'missing' })).status, 400);
        assert.equal((await post({ ...payload, rows: [] })).status, 400);

        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Students');
        sheet.addRow(['Enrollment No.', 'Mobile No.', 'Name']);
        sheet.addRow(['enr001', '', 'Ignored Excel name']);
        sheet.addRow(['001234', '+91 90000 00012', 'Ignored']);
        sheet.addRow(['', '9000000011', 'Duplicate']);
        sheet.addRow(['UNKNOWN', '', 'Missing']);
        sheet.addRow(['ENR001', '9000000012', 'Conflicting']);
        sheet.addRow(['ENR003', '', 'Incomplete']);
        sheet.addRow(['', '', 'No identifier']);
        for (let index = 0; index < 100; index++) sheet.addRow(['ENR001', '', 'Duplicate']);
        const extra = workbook.addWorksheet('More students');
        extra.addRow(['Mobile number']);
        extra.addRow(['9000000011']);
        workbook.addWorksheet('Notes').addRows([['Name', 'Email'], ['Ignored', 'ignored@example.test']]);
        const file = { name: 'students.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(await workbook.xlsx.writeBuffer()) };

        browser = await chromium.launch();
        const context = await browser.newContext();
        await context.addCookies([{ name: 'utsavfest_user', value: encodeURIComponent(JSON.stringify({ id: 'admin-test', role: 'admin' })), url: base }]);
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.route('https://**/*', route => route.abort());
        await page.goto(`${base}/admin-dashboard/participation`);
        assert.ok(await page.locator('#student-excel-file').isDisabled());
        await page.locator('#participation-fest').selectOption('Fest A');
        assert.deepEqual(await page.locator('#participation-event option').allTextContents(), ['Select event', 'Dance']);
        await page.locator('#participation-event').selectOption(first.id);
        await page.locator('#student-excel-file').setInputFiles(file);
        await page.waitForFunction(() => document.querySelector('#student-excel-status').textContent.includes('2 added'));
        assert.equal(await events.EventParticipation.countDocuments({ eventId: first.id }), 2);
        assert.equal(await page.locator('#student-excel-table tbody tr').count(), 100);
        assert.equal(await page.locator('#student-excel-table tbody tr').first().locator('td').nth(2).textContent(), '<img src=x onerror=alert(1)>');
        assert.equal(await page.locator('#student-excel-table img').count(), 0);
        assert.equal(await page.locator('#student-excel-table tbody tr').nth(1).locator('td').nth(3).textContent(), '001234');
        const previewText = await page.locator('#student-excel-table tbody').textContent();
        for (const outcome of ['Added', 'Already registered', 'Not found', 'Conflicting identifiers', 'Incomplete profile']) assert.ok(previewText.includes(outcome));
        await page.locator('#student-excel-next').click();
        assert.equal(await page.locator('#student-excel-table tbody tr').count(), 8);
        assert.equal(await page.locator('#student-excel-page').textContent(), '101–108 of 108 Excel rows');
        await page.waitForFunction(() => document.querySelector('.participation-results').textContent.includes('2 participation records'));
        for (const width of [1440, 390]) {
            await page.setViewportSize({ width, height: 1000 });
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `No overflow at ${width}px`);
        }
        await page.locator('#student-excel-clear').click();
        assert.ok(await page.locator('#student-excel-preview').isHidden());
        assert.equal(await events.EventParticipation.countDocuments({ eventId: first.id }), 2);
        await page.locator('#student-excel-file').setInputFiles(file);
        await page.waitForFunction(() => document.querySelector('#student-excel-status').textContent.includes('0 added'));
        assert.equal(await events.EventParticipation.countDocuments({ eventId: first.id }), 2);
        await page.locator('#participation-fest').selectOption('Fest B');
        assert.equal(await page.locator('#participation-event').inputValue(), '');
        assert.ok(await page.locator('#student-excel-file').isDisabled());
        await page.locator('#participation-event').selectOption(second.id);
        await page.locator('#student-excel-file').setInputFiles(file);
        await page.waitForFunction(() => document.querySelector('#student-excel-status').textContent.includes('2 added'));
        assert.equal(await events.EventParticipation.countDocuments({ eventId: second.id }), 2);
        await page.reload();
        assert.equal(await page.locator('#participation-fest').inputValue(), 'Fest B');
        assert.equal(await page.locator('#participation-event').inputValue(), second.id);
        assert.ok((await page.locator('.participation-results').textContent()).includes('2 participation records'));
        await page.locator('#student-excel-file').setInputFiles({ name: 'broken.xlsx', mimeType: file.mimeType, buffer: Buffer.from('invalid') });
        await page.waitForFunction(() => document.querySelector('#student-excel-status').textContent.includes('Could not read'));
        await page.locator('#student-excel-file').setInputFiles({ name: 'old.xls', mimeType: 'application/vnd.ms-excel', buffer: Buffer.from('xls') });
        assert.match(await page.locator('#student-excel-status').textContent(), /Save older .xls files as .xlsx/);
        await page.locator('#student-excel-file').setInputFiles({ name: 'large.xlsx', mimeType: file.mimeType, buffer: Buffer.alloc(5 * 1024 * 1024 + 1) });
        assert.match(await page.locator('#student-excel-status').textContent(), /smaller than 5 MB/);
        assert.deepEqual(errors, []);
    } finally {
        if (browser) await browser.close();
        if (server.listening) await new Promise(resolve => server.close(resolve));
        try { if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase(); }
        finally { await mongoose.disconnect(); }
    }
});
