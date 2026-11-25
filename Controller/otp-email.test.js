const assert = require('assert');
const server = require('./server.js');
const db = require('../Model/db');
const userModel = require('../Model/userModel');
const festivalModel = require('../Model/festivalModel1');

assert.strictEqual(typeof server.createOtp, 'function', 'createOtp should be exported');
assert.strictEqual(typeof server.getSmtpConfig, 'function', 'getSmtpConfig should be exported');
assert.strictEqual(typeof db.connectDB, 'function', 'connectDB should be exported from the database module');

const config = server.getSmtpConfig();
assert.ok(config.host, 'SMTP host should be configured');
assert.ok(typeof config.port === 'number', 'SMTP port should be a number');

const otp = server.createOtp('user@example.com');
assert.strictEqual(otp.length, 6, 'OTP should be 6 digits long');
assert.ok(/^\d{6}$/.test(otp), 'OTP should contain only digits');

const normalizedFestivalDate = festivalModel.normalizeFestivalDate('2026-09-12');
assert.strictEqual(normalizedFestivalDate.year, 2026, 'Festival dates should preserve the source year');
assert.strictEqual(normalizedFestivalDate.month, 8, 'Festival date parsing should match the actual calendar month index');
assert.strictEqual(normalizedFestivalDate.day, 12, 'Festival date parsing should match the actual day number in a standard calendar');

(async () => {
  let uniqueTag;
  try {
    uniqueTag = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const testEmail = (label) => `${label}-${uniqueTag.slice(-6)}@e.co`;
    const randomPhone = () => `9${Math.floor(100000000 + Math.random() * 900000000)}`;

    const firstUserEmail = testEmail('s1');
    const firstUserMobile = randomPhone();

    const firstUser = await userModel.registerUser({
      name: 'UUID User One',
      email: firstUserEmail,
      mobileNumber: firstUserMobile,
      enrollmentNumber: `${uniqueTag}-ENR-1`,
      password: 'StrongPass1!',
      role: 'student'
    });

    const facultyEmail = testEmail('f1');
    const facultyMobile = randomPhone();
    const facultyUser = await userModel.registerUser({
      name: 'Faculty Test User',
      email: facultyEmail,
      mobileNumber: facultyMobile,
      password: 'StrongPass1!',
      role: 'faculty'
    });

    const duplicateFacultyEmailUser = await userModel.registerUser({
      name: 'Duplicate Faculty Email User',
      email: facultyEmail,
      mobileNumber: randomPhone(),
      password: 'StrongPass1!',
      role: 'faculty'
    });

    const duplicateFacultyMobileUser = await userModel.registerUser({
      name: 'Duplicate Faculty Mobile User',
      email: testEmail('fd'),
      mobileNumber: facultyMobile,
      password: 'StrongPass1!',
      role: 'faculty'
    });

    const weakPasswordUser = await userModel.registerUser({
      name: 'Weak Password User',
      email: testEmail('wp'),
      mobileNumber: randomPhone(),
      password: 'secret123',
      role: 'student'
    });

    const secondUser = await userModel.registerUser({
    name: 'UUID User Two',
    email: testEmail('s2'),
    mobileNumber: randomPhone(),
    enrollmentNumber: `${uniqueTag}-ENR-2`,
    password: 'StrongPass1!',
    role: 'student'
  });

  const duplicateEmailUser = await userModel.registerUser({
    name: 'Duplicate Email User',
    email: firstUserEmail,
    mobileNumber: randomPhone(),
    enrollmentNumber: `${uniqueTag}-ENR-3`,
    password: 'StrongPass1!',
    role: 'student'
  });

  const duplicateMobileUser = await userModel.registerUser({
    name: 'Duplicate Mobile User',
    email: testEmail('s3'),
    mobileNumber: firstUserMobile,
    enrollmentNumber: `${uniqueTag}-ENR-4`,
    password: 'StrongPass1!',
    role: 'student'
  });

  const crossRoleDuplicateEmail = await userModel.registerUser({
    name: 'Cross Role Duplicate Email User',
    email: firstUserEmail,
    mobileNumber: randomPhone(),
    password: 'StrongPass1!',
    role: 'faculty'
  });

  const duplicateEnrollmentUser = await userModel.registerUser({
    name: 'Duplicate Enrollment User',
    email: testEmail('s4'),
    mobileNumber: randomPhone(),
    enrollmentNumber: `${uniqueTag}-enr-1`,
    password: 'StrongPass1!',
    role: 'student'
  });

  assert.ok(firstUser.success, 'First user registration should succeed');
  assert.ok(facultyUser.success, 'Faculty registration should succeed');
  assert.strictEqual(duplicateFacultyEmailUser.success, false, 'Faculty email should be unique');
  assert.strictEqual(duplicateFacultyMobileUser.success, false, 'Faculty mobile number should be unique');
  assert.ok(secondUser.success, 'Second user registration should succeed');
  assert.ok(firstUser.user.id, 'First user should have a UUID id');
  assert.ok(secondUser.user.id, 'Second user should have a UUID id');
  assert.notStrictEqual(firstUser.user.id, secondUser.user.id, 'Each user should get a unique UUID id');
  assert.strictEqual(weakPasswordUser.success, false, 'Registration should reject a password without uppercase and special characters');
  assert.notStrictEqual(firstUser.user.password, 'StrongPass1!', 'Stored password should be password-hashed, not plain text');
  assert.ok(firstUser.user.password.startsWith('$2'), 'Password hash should be bcrypt format');
  assert.strictEqual(duplicateEmailUser.success, false, 'Same email should not be allowed to register again');
  assert.strictEqual(duplicateMobileUser.success, false, 'Same mobile number should not be allowed to register again');
  assert.strictEqual(duplicateEnrollmentUser.success, false, 'Same enrollment number should not be allowed to register again');
  assert.strictEqual(crossRoleDuplicateEmail.success, false, 'Same email should also be rejected across a different role');

  const loginByEmail = await userModel.loginUser(firstUserEmail, 'StrongPass1!', 'student');
  const loginByMobile = await userModel.loginUser(firstUserMobile, 'StrongPass1!', 'student');
  const loginByPhone = await userModel.loginUserByPhone(firstUserMobile, 'student');
  assert.strictEqual(loginByEmail.success, true, 'Existing user should be able to log in with email');
  assert.strictEqual(loginByMobile.success, true, 'Existing user should be able to log in with mobile number');
  assert.strictEqual(loginByPhone.success, true, 'Existing user should be able to log in with phone-only WhatsApp flow');

  const adminLoginId = `admin-${uniqueTag}`;
  const adminUser = await userModel.Admin.create({
    id: `admin-user-${uniqueTag}`,
    name: 'Admin Login Test',
    email: testEmail('a1'),
    loginId: adminLoginId,
    password: 'secret123',
    role: 'admin'
  });
  await userModel.Admin.updateOne({ _id: adminUser._id }, { $set: { password: 'secret123' } });
  const loginByAdminId = await userModel.loginUser(adminLoginId, 'secret123', 'admin');
  const adminLoginByEmail = await userModel.loginUser(adminUser.email, 'secret123', 'admin');
  const adminLoginWithWrongPassword = await userModel.loginUser(adminLoginId, 'wrong-password', 'admin');
  assert.strictEqual(loginByAdminId.success, true, 'Admin should be able to log in with a database login ID');
  assert.strictEqual(loginByAdminId.user.id, adminUser.id, 'Admin login should return the matching database user');
  assert.strictEqual(adminLoginByEmail.success, false, 'Admin login should not accept an email address instead of a login ID');
  assert.strictEqual(adminLoginWithWrongPassword.success, false, 'Admin login should reject an incorrect password');
  const upgradedAdmin = await userModel.Admin.findById(adminUser._id).select('password').lean();
  assert.ok(upgradedAdmin.password.startsWith('$2'), 'Legacy plaintext passwords should be upgraded to bcrypt after a successful database login');
  assert.strictEqual(userModel.Admin.collection.name, 'admins', 'Admins should use a dedicated collection');
  assert.strictEqual(userModel.EventCoordinator.collection.name, 'eventcoordinators', 'Event coordinators should use a dedicated collection');
  await userModel.Admin.deleteOne({ loginId: adminLoginId });

  const legacyCoordinatorLoginId = `legacy-coordinator-${uniqueTag}`;
  await userModel.User.create({
    id: `legacy-coordinator-${uniqueTag}`,
    name: 'Legacy Coordinator Test',
    email: testEmail('c1'),
    loginId: legacyCoordinatorLoginId,
    password: 'secret123',
    role: 'admin',
    adminCategory: 'tnp'
  });
  await userModel.migrateLegacyAdminAccounts();
  const migratedCoordinator = await userModel.EventCoordinator.findOne({ loginId: legacyCoordinatorLoginId }).lean();
  const migratedCoordinatorLogin = await userModel.loginUser(legacyCoordinatorLoginId, 'secret123', 'event-coordinator');
  assert.strictEqual(migratedCoordinator.role, 'event-coordinator', 'Legacy T&P admins should migrate to the coordinator collection');
  assert.strictEqual(migratedCoordinatorLogin.success, true, 'Migrated event coordinators should keep working credentials');
  assert.strictEqual(await userModel.User.findOne({ loginId: legacyCoordinatorLoginId }), null, 'Migrated coordinator should be removed from the shared users collection');
  await userModel.EventCoordinator.deleteOne({ loginId: legacyCoordinatorLoginId });

  const previousCoordinatorLoginId = process.env.EVENT_COORDINATOR_LOGIN_ID;
  const previousCoordinatorPassword = process.env.EVENT_COORDINATOR_PASSWORD;
  const coordinatorLoginId = `coord-${uniqueTag.slice(-8)}@e.co`;
  const coordinatorPassword = 'StrongPass1!';
  try {
    delete process.env.EVENT_COORDINATOR_LOGIN_ID;
    delete process.env.EVENT_COORDINATOR_PASSWORD;
    assert.strictEqual(await userModel.ensureDefaultEventCoordinator(), false, 'No coordinator should be seeded without configured credentials');

    process.env.EVENT_COORDINATOR_LOGIN_ID = coordinatorLoginId;
    process.env.EVENT_COORDINATOR_PASSWORD = coordinatorPassword;
    assert.strictEqual(await userModel.ensureDefaultEventCoordinator(), true, 'Configured coordinator credentials should be stored in MongoDB');
    const coordinatorRecord = await userModel.EventCoordinator.findOne({ loginId: coordinatorLoginId }).lean();
    const coordinatorLogin = await userModel.loginUser(coordinatorLoginId, coordinatorPassword, 'event-coordinator');
    assert.strictEqual(coordinatorRecord.role, 'event-coordinator', 'Event coordinator should be stored in its own collection');
    assert.ok(coordinatorRecord.password.startsWith('$2'), 'Coordinator password should be bcrypt-hashed in the database');
    assert.strictEqual(coordinatorLogin.success, true, 'Event coordinator login should authenticate using the stored database record');
    assert.strictEqual((await userModel.loginUser(coordinatorLoginId, 'WrongPass1!', 'event-coordinator')).success, false, 'Login should reject a password that does not match the stored record');
    await userModel.EventCoordinator.deleteOne({ loginId: coordinatorLoginId });
  } finally {
    if (previousCoordinatorLoginId === undefined) delete process.env.EVENT_COORDINATOR_LOGIN_ID;
    else process.env.EVENT_COORDINATOR_LOGIN_ID = previousCoordinatorLoginId;
    if (previousCoordinatorPassword === undefined) delete process.env.EVENT_COORDINATOR_PASSWORD;
    else process.env.EVENT_COORDINATOR_PASSWORD = previousCoordinatorPassword;
  }

  let dashboardHtml = '';
  let dashboardStatus;
  let dashboardHeaders;
  const studentSessionUser = {
    ...firstUser.user,
    role: 'student',
    name: 'Session User'
  };

  const facultySessionUser = {
    ...firstUser.user,
    role: 'faculty',
    name: 'Faculty User',
    email: testEmail('f2')
  };

  const dashboardResponse = {
    writeHead(status, headers) {
      dashboardStatus = status;
      dashboardHeaders = headers;
    },
    end(content) {
      dashboardHtml += content || '';
    }
  };

  server.handleRequest({
    method: 'GET',
    url: '/',
    headers: {
      host: 'localhost:3000',
      cookie: server.createSessionCookie(studentSessionUser)
    }
  }, dashboardResponse);

  assert.ok(dashboardHtml.includes('Welcome, Session User'), 'Returning student should see a welcome message on home page');
  assert.ok(dashboardHtml.includes('Account overview'), 'Student dashboard should retain the account overview card');
  assert.ok(dashboardHtml.includes('Explore celebrations'), 'Student dashboard should retain the explore celebrations card');
  assert.ok(!dashboardHtml.includes('Festival Registration'), 'Student dashboard should no longer show the old festival registration form');
  assert.ok(dashboardHtml.includes('Participate in Event'), 'Student dashboard should include the participation form');
  assert.ok(dashboardHtml.includes('Student name'), 'The participation form should include the student name field');
  assert.ok(dashboardHtml.includes('Field of interest'), 'The participation form should include the field of interest field');
  assert.ok(dashboardHtml.includes('Event name'), 'The participation form should include the event name field');

  const adminDashboardHtml = await new Promise((resolve) => {
    const adminDashboardResponse = {
      writeHead() {},
      end(content) {
        resolve(content || '');
      }
    };

    server.handleRequest({
      method: 'GET',
      url: '/',
      headers: {
        host: 'localhost:3000',
        cookie: server.createSessionCookie({
          id: 'dashboard-admin-test',
          name: 'Dashboard Admin',
          email: 'dashboard-admin@example.com',
          role: 'admin',
          adminCategory: 'facility'
        })
      }
    }, adminDashboardResponse);
  });

  assert.ok(adminDashboardHtml.includes('Account Management'), 'Admins should see the Admin 2.0 dashboard');
  assert.ok(adminDashboardHtml.includes('/admin-dashboard/students'), 'Admin dashboard should link to the student dashboard');
  assert.ok(!adminDashboardHtml.includes('Explore celebrations'), 'Admins should no longer see the original dashboard');

  const participationResult = await festivalModel.addParticipation({
    studentName: 'Participation Test User',
    department: 'Computer Science',
    fieldOfInterest: 'Web Development',
    semester: '6',
    collegeName: 'Test University',
    eventName: 'Ganesh Utsav'
  });

  assert.ok(participationResult.success, 'Student participation should be saved to MongoDB');

  dashboardHtml = '';
  server.handleRequest({
    method: 'GET',
    url: '/',
    headers: {
      host: 'localhost:3000',
      cookie: server.createSessionCookie(facultySessionUser)
    }
  }, dashboardResponse);

  assert.ok(dashboardHtml.includes('Add New Event'), 'Faculty dashboard should include the event creation entry');
  assert.ok(dashboardHtml.includes('href="/faculty/add-event"'), 'Faculty dashboard should link to the event form');

  dashboardHtml = '';
  server.handleRequest({
    method: 'GET',
    url: '/faculty/add-event',
    headers: {
      host: 'localhost:3000',
      cookie: server.createSessionCookie(facultySessionUser)
    }
  }, dashboardResponse);
  assert.strictEqual(dashboardStatus, 200, 'Faculty should be able to open the dedicated event form');
  assert.ok(dashboardHtml.includes('id="event-form"'), 'Dedicated event page should render the event form');
  assert.ok(dashboardHtml.includes('name="eventName"'), 'Dedicated event form should include an event name field');
  assert.ok(dashboardHtml.includes('name="eventDate"'), 'Dedicated event form should include an event date field');

  dashboardHtml = '';
  server.handleRequest({
    method: 'GET',
    url: '/faculty/add-event',
    headers: {
      host: 'localhost:3000',
      cookie: server.createSessionCookie(studentSessionUser)
    }
  }, dashboardResponse);
  assert.strictEqual(dashboardStatus, 403, 'Students should not be able to open the faculty event form');

  dashboardHtml = '';
  server.handleRequest({
    method: 'GET',
    url: '/login',
    headers: {
      host: 'localhost:3000',
      cookie: server.createSessionCookie(studentSessionUser)
    }
  }, dashboardResponse);
  assert.strictEqual(dashboardStatus, 302, 'Authenticated users should be redirected away from the login route');
  assert.strictEqual(dashboardHeaders.Location, '/', 'Authenticated login requests should redirect to the dashboard');

  dashboardHtml = '';
  server.handleRequest({
    method: 'GET',
    url: '/',
    headers: {
      host: 'localhost:3000',
      cookie: 'utsavfest_session=not-valid-session'
    }
  }, dashboardResponse);
  assert.ok(dashboardHtml.includes('UtsavFest'), 'Invalid or stale session cookies should not force the dashboard to show on the homepage');

  let logoutHtml = '';
  const logoutResponse = {
    setHeader(name, value) {
      if (name === 'Set-Cookie') {
        this.cookieHeader = value;
      }
    },
    writeHead() {},
    end(content) {
      logoutHtml += content || '';
    }
  };

  server.handleRequest({
    method: 'GET',
    url: '/logout',
    headers: { host: 'localhost:3000' }
  }, logoutResponse);

  assert.ok(logoutResponse.cookieHeader && logoutResponse.cookieHeader.includes('max-age=0'), 'Logout should clear the saved session cookie');
  assert.ok(logoutHtml.includes('logged out') || logoutHtml.includes('Logged out') || logoutHtml.includes('Sign In'), 'Logout page should confirm the user is signed out');

  let loginPageHtml = '';
  server.handleRequest({
    method: 'GET',
    url: '/login',
    headers: { host: 'localhost:3000' }
  }, {
    writeHead() {},
    end(content) {
      loginPageHtml += content || '';
    }
  });
  assert.ok(loginPageHtml.includes('id="emailInput"'), 'Login page should retain email login for non-admin roles');
  assert.ok(loginPageHtml.includes('id="loginIdInput"'), 'Login page should offer a separate login ID field for admins');
  assert.ok(!loginPageHtml.includes('<option value="admin">'), 'Login dropdown should no longer offer Admin');
  assert.ok(loginPageHtml.includes('<option value="admin-2.0"'), 'Login dropdown should retain Admin 2.0');

  const teacherSessionUser = {
    id: 'teacher-dashboard-test-id',
    email: 'teacher-dashboard@example.com',
    name: 'Teacher Dashboard User',
    role: 'faculty'
  };

  function createMockRequest(method, pathname, payload, sessionUser) {
    const listeners = {};
    const request = {
      method,
      url: pathname,
      headers: {
        host: 'localhost:3000',
        'content-type': 'application/json',
        cookie: server.createSessionCookie(sessionUser)
      },
      on(event, callback) {
        listeners[event] = callback;
        return request;
      }
    };

    setTimeout(() => {
      if (payload !== undefined && listeners.data) {
        listeners.data(Buffer.from(JSON.stringify(payload)));
      }
      if (listeners.end) {
        listeners.end();
      }
    }, 0);

    return request;
  }

  function createMockResponse() {
    return {
      statusCode: null,
      headers: {},
      body: '',
      writeHead(status, headers) {
        this.statusCode = status;
        this.headers = headers || {};
      },
      end(content) {
        this.body += content || '';
      }
    };
  }

  const formCreatePayload = {
    title: 'Faculty Edit Test Form',
    description: 'Original description',
    startAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    endAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    visibleToStudents: true,
    questions: [{ label: 'Favorite festival?', type: 'short-answer', required: true, options: [] }]
  };

  const formCreateResponse = createMockResponse();
  server.handleRequest(createMockRequest('POST', '/save-custom-form', formCreatePayload, teacherSessionUser), formCreateResponse);
  await new Promise((resolve) => setTimeout(resolve, 25));

  const createdForm = JSON.parse(formCreateResponse.body || '{}');
  assert.strictEqual(createdForm.success, true, 'Faculty should be able to create a form for dashboard editing');
  assert.ok(createdForm.form && createdForm.form.id, 'New teacher form should include an id');

  const formUpdatePayload = {
    formId: createdForm.form.id,
    title: 'Faculty Edit Test Form Updated',
    description: 'Updated description',
    startAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    endAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
    visibleToStudents: false,
    questions: [{ label: 'Updated question', type: 'short-answer', required: false, options: [] }]
  };

  const formUpdateResponse = createMockResponse();
  server.handleRequest(createMockRequest('POST', '/edit-custom-form', formUpdatePayload, teacherSessionUser), formUpdateResponse);
  await new Promise((resolve) => setTimeout(resolve, 25));

  const updatedForm = JSON.parse(formUpdateResponse.body || '{}');
  assert.strictEqual(updatedForm.success, true, 'Faculty should be able to edit their own custom form');
  assert.strictEqual(updatedForm.form.title, 'Faculty Edit Test Form Updated', 'Updated form title should be stored');
  assert.strictEqual(updatedForm.form.visibleToStudents, false, 'Updated visibility should be saved');

  const formDeleteResponse = createMockResponse();
  server.handleRequest(createMockRequest('POST', '/delete-custom-form', { formId: createdForm.form.id }, teacherSessionUser), formDeleteResponse);
  await new Promise((resolve) => setTimeout(resolve, 25));

  const deletedForm = JSON.parse(formDeleteResponse.body || '{}');
  assert.strictEqual(deletedForm.success, true, 'Faculty should be able to delete their own custom form');

  const festivalCreateResponse = createMockResponse();
  server.handleRequest(createMockRequest('POST', '/add-event', {
    eventName: 'Teacher Edit Test Festival',
    eventDate: '2026-09-20',
    eventLocation: 'Main Auditorium',
    image: 'https://example.com/festival.jpg'
  }, teacherSessionUser), festivalCreateResponse);
  await new Promise((resolve) => setTimeout(resolve, 200));

  const createdFestival = JSON.parse(festivalCreateResponse.body || '{}');
  assert.strictEqual(createdFestival.success, true, 'Faculty should be able to create a festival event');
  assert.ok(createdFestival.festival && createdFestival.festival.id, 'Created festival should include an id for future teacher editing');

  const festivalEditResponse = createMockResponse();
  server.handleRequest(createMockRequest('POST', '/edit-festival', {
    festivalId: createdFestival.festival.id,
    eventName: 'Teacher Edited Festival',
    eventDate: '2026-09-25',
    eventLocation: 'Updated Venue',
    image: 'https://example.com/edited.jpg'
  }, teacherSessionUser), festivalEditResponse);
  await new Promise((resolve) => setTimeout(resolve, 200));

  const editedFestival = JSON.parse(festivalEditResponse.body || '{}');
  assert.strictEqual(editedFestival.success, true, 'Faculty should be able to edit their own festival event');
  assert.strictEqual(editedFestival.festival.name, 'Teacher Edited Festival', 'Edited festival name should be saved');

  const festivalDeleteResponse = createMockResponse();
  server.handleRequest(createMockRequest('POST', '/delete-festival', { festivalId: createdFestival.festival.id }, teacherSessionUser), festivalDeleteResponse);
  await new Promise((resolve) => setTimeout(resolve, 200));

    const deletedFestival = JSON.parse(festivalDeleteResponse.body || '{}');
    assert.strictEqual(deletedFestival.success, true, 'Faculty should be able to delete their own festival event');

    console.log('OTP email config test passed');
  } finally {
    if (uniqueTag) {
      await Promise.all([
        userModel.Student.deleteMany({ email: { $in: [`s1-${uniqueTag.slice(-6)}@e.co`, `s2-${uniqueTag.slice(-6)}@e.co`] } }),
        userModel.Faculty.deleteMany({ email: `f1-${uniqueTag.slice(-6)}@e.co` })
      ]);
    }
    await db.mongoose.disconnect();
  }
})();
