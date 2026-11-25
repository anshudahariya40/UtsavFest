const assert = require('node:assert/strict');
const test = require('node:test');
const { getAdminDashboardPage } = require('./server');

test('admin dashboard routes include the reports page', () => {
	assert.equal(getAdminDashboardPage('/admin-dashboard/reports'), 'reports');
	assert.equal(getAdminDashboardPage('/admin-dashboard'), 'overview');
	assert.equal(getAdminDashboardPage('/not-an-admin-page'), null);
});
