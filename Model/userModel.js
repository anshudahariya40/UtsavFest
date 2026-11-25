const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { connectDB, mongoose, isConnected } = require('./db');

const users = [];

const userSchema = new mongoose.Schema({
    id: {
        type: String,
        unique: true,
        required: true,
        default: () => uuidv4()
    },
    name: String,
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 30 },
    loginId: { type: String, unique: true, sparse: true, trim: true },
    mobileNumber: { type: String, default: null, trim: true },
    password: { type: String, required: true },
    role: { type: String, required: true },
    studentName: String,
    teacherName: String,
    collegeName: String,
    instituteName: String,
    gender: { type: String, enum: ['male', 'female', 'other', 'prefer-not-to-say'], default: null },
    department: String,
    semester: String,
    enrollmentNumber: String,
    adminCollege: String,
    adminDepartment: String,
    adminCategory: String,
    picture: String,
    resetToken: { type: String, default: null },
    resetTokenExpires: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now }
}, { timestamps: true });

userSchema.pre('save', async function(next) {
    if (this.isModified('password') && this.password && !this.password.startsWith('$2')) {
        this.password = await bcrypt.hash(this.password, 12);
    }
    next();
});

const User = mongoose.models.User || mongoose.model('User', userSchema);
const Admin = mongoose.models.Admin || mongoose.model('Admin', userSchema, 'admins');
const EventCoordinator = mongoose.models.EventCoordinator || mongoose.model('EventCoordinator', userSchema, 'eventcoordinators');
const Student = mongoose.models.Student || mongoose.model('Student', new mongoose.Schema({
    id: { type: String, unique: true, required: true },
    name: String,
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 30 },
    mobileNumber: { type: String, required: true, unique: true, trim: true },
    password: { type: String, required: true },
    role: { type: String, default: 'student' },
    studentName: String,
    teacherName: String,
    collegeName: String,
    department: String,
    gender: { type: String, enum: ['male', 'female', 'other', 'prefer-not-to-say'], default: null },
    semester: String,
    enrollmentNumber: { type: String, required: true, unique: true, trim: true, uppercase: true },
    adminCollege: String,
    adminDepartment: String,
    adminCategory: String,
    picture: String,
    createdAt: { type: Date, default: Date.now }
}, { timestamps: true }), 'students');

const Faculty = mongoose.models.Faculty || mongoose.model('Faculty', new mongoose.Schema({
    id: { type: String, unique: true, required: true },
    name: String,
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 30 },
    mobileNumber: { type: String, required: true, unique: true, trim: true },
    password: { type: String, required: true },
    role: { type: String, default: 'faculty' },
    approvalStatus: { type: String, enum: ['pending', 'approved'], default: 'approved' },
    registrationSource: { type: String, enum: ['self', 'admin', 'legacy'], default: 'legacy' },
    studentName: String,
    teacherName: String,
    collegeName: String,
    department: String,
    gender: { type: String, enum: ['male', 'female', 'other', 'prefer-not-to-say'], default: null },
    adminCollege: String,
    adminDepartment: String,
    adminCategory: String,
    picture: String,
    createdAt: { type: Date, default: Date.now }
}, { timestamps: true }), 'faculty');

function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
}

async function hashPassword(password) {
    return bcrypt.hash(String(password || ''), 12);
}

async function ensureDefaultEventCoordinator() {
    if (!isConnected()) {
        return false;
    }

    const loginId = String(process.env.EVENT_COORDINATOR_LOGIN_ID || '').trim();
    const password = process.env.EVENT_COORDINATOR_PASSWORD || '';
    if (!loginId || !password) {
        return false;
    }

    const existingCoordinator = await EventCoordinator.findOne({ loginId }).select('_id').lean();
    if (existingCoordinator) {
        return false;
    }

    await EventCoordinator.create({
        id: uuidv4(),
        name: 'Event Coordinator',
        email: loginId.toLowerCase(),
        loginId,
        password: await hashPassword(password),
        role: 'event-coordinator'
    });
    return true;
}

async function migrateLegacyAdminAccounts() {
    if (!isConnected()) {
        return;
    }

    const legacyAccounts = await User.find({ role: 'admin' }).lean();
    for (const legacyAccount of legacyAccounts) {
        const isCoordinator = legacyAccount.adminCategory === 'tnp';
        const destination = isCoordinator ? EventCoordinator : Admin;
        const role = isCoordinator ? 'event-coordinator' : 'admin';

        try {
            const existingAccount = await destination.findOne({
                $or: [{ id: legacyAccount.id }, { loginId: legacyAccount.loginId }]
            }).lean();

            if (existingAccount) {
                if (existingAccount.id !== legacyAccount.id || existingAccount.loginId !== legacyAccount.loginId || existingAccount.password !== legacyAccount.password) {
                    continue;
                }
            } else {
                const { _id, __v, ...accountData } = legacyAccount;
                await destination.create({ ...accountData, role });
            }

            await User.deleteOne({ _id: legacyAccount._id });
        } catch (error) {
            console.error(`Legacy ${role} account migration failed:`, error.message);
        }
    }
}

async function initializeUserCollections() {
    if (!isConnected()) {
        return;
    }

    for (const model of [Admin, Faculty, Student, EventCoordinator]) {
        const collectionExists = await mongoose.connection.db
            .listCollections({ name: model.collection.collectionName }, { nameOnly: true })
            .hasNext();
        if (!collectionExists) {
            await model.createCollection();
        }
    }

    await migrateLegacyAdminAccounts();
    await ensureDefaultEventCoordinator();
    await Promise.all([Student.createIndexes(), Faculty.createIndexes()]);
}

async function comparePassword(inputPassword, storedPassword) {
    if (!storedPassword) {
        return false;
    }

    if (storedPassword.startsWith('$2')) {
        return bcrypt.compare(String(inputPassword || ''), storedPassword);
    }

    return String(inputPassword || '') === storedPassword;
}

async function verifyStoredPassword(inputPassword, user, collection) {
    if (!user || !user.password) {
        return false;
    }

    if (user.password.startsWith('$2')) {
        return bcrypt.compare(String(inputPassword || ''), user.password);
    }

    if (String(inputPassword || '') !== user.password) {
        return false;
    }

    const hashedPassword = await hashPassword(inputPassword);
    const update = await collection.updateOne(
        { _id: user._id, password: user.password },
        { $set: { password: hashedPassword } }
    );
    if (update.matchedCount) {
        user.password = hashedPassword;
        return true;
    }

    const currentUser = await collection.findById(user._id).select('password').lean();
    return Boolean(currentUser && await bcrypt.compare(String(inputPassword || ''), currentUser.password));
}

function normalizeMobileNumber(mobileNumber) {
    return String(mobileNumber || '').replace(/\D/g, '').trim();
}

function normalizeEnrollmentNumber(enrollmentNumber) {
    return String(enrollmentNumber || '').trim().toUpperCase();
}

function isStrongPassword(password) {
    return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{6,20}$/.test(String(password || ''));
}

async function findExistingUserRecord(email, mobileNumber, role, enrollmentNumber) {
    const conditions = [];

    if (email) {
        conditions.push({ email });
    }

    if (mobileNumber) {
        conditions.push({ mobileNumber });
    }

    if (role === 'student' && enrollmentNumber) {
        conditions.push({ enrollmentNumber });
    }

    if (conditions.length === 0) {
        return null;
    }

    const collections = [Student, Faculty];
    for (const collection of collections) {
        const query = {
            ...(role ? { role } : {}),
            $or: conditions
        };

        const record = await collection.findOne(query).lean();
        if (record) {
            return record;
        }
    }

    if (role) {
        for (const collection of collections) {
            const record = await collection.findOne({
                $or: conditions
            }).lean();
            if (record) {
                return record;
            }
        }
    }

    return null;
}

function validateManagedUserInput(input, editing = false) {
    const text = (key) => typeof input[key] === 'string' ? input[key].trim() : '';
    const role = text('role');
    if (!['student', 'faculty', 'event-coordinator'].includes(role)) {
        return { success: false, message: 'Select Student, Faculty, or Event Coordinator.' };
    }
    const account = {
        role,
        name: text('name'),
        email: normalizeEmail(text('email')),
        mobileNumber: normalizeMobileNumber(text('mobileNumber')),
        password: typeof input.password === 'string' ? input.password : '',
        collegeName: text('collegeName'),
        department: text('department'),
        gender: text('gender'),
        semester: text('semester'),
        enrollmentNumber: normalizeEnrollmentNumber(text('enrollmentNumber')),
        instituteName: text('instituteName'),
        picture: text('picture')
    };
    if (!account.name || account.name.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account.email) || account.email.length > 30) {
        return { success: false, message: 'Enter a name (up to 100 characters) and a valid email address.' };
    }
    if (!/^\d{10}$/.test(account.mobileNumber)) {
        return { success: false, message: 'Enter a valid 10-digit mobile number.' };
    }
    if ((!editing || account.password) && !isStrongPassword(account.password)) {
        return { success: false, message: 'Password must be 6-20 characters with uppercase, lowercase, a number, and a special character.' };
    }
    if ((!editing || account.password) && input.confirmPassword !== account.password) {
        return { success: false, message: 'Passwords do not match.' };
    }
    if (account.gender && !['male', 'female', 'other', 'prefer-not-to-say'].includes(account.gender)) {
        return { success: false, message: 'Select a valid gender.' };
    }
    if (role === 'event-coordinator' && (!account.instituteName || !account.gender)) {
        return { success: false, message: 'Institute name and gender are required for an Event Coordinator.' };
    }
    if (role !== 'event-coordinator' && (!account.collegeName || !account.department)) {
        return { success: false, message: 'College and department are required.' };
    }
    if ([account.collegeName, account.department, account.instituteName].some(value => value.length > 200)) {
        return { success: false, message: 'College, institute, and department names must be under 200 characters.' };
    }
    if (role === 'student' && (!/^[1-8]$/.test(account.semester) || !account.enrollmentNumber || account.enrollmentNumber.length > 20)) {
        return { success: false, message: 'Select semester 1-8 and enter an enrollment number (up to 20 characters).' };
    }
    if (role === 'student' && (!editing || account.picture) && (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(account.picture) || account.picture.length > 2800000)) {
        return { success: false, message: 'Upload a PNG, JPEG, or WebP student picture under 2 MB.' };
    }
    return { success: true, account };
}

async function createManagedUser(input) {
    const validation = validateManagedUserInput(input);
    if (!validation.success) return validation;
    const { account } = validation;
    const { role } = account;

    const database = await connectDB();
    if (!database || !isConnected()) {
        return { success: false, status: 503, message: 'MongoDB is unavailable. The account was not saved. Please try again.' };
    }
    try {
        for (const collection of [Student, Faculty, Admin, EventCoordinator, User]) {
            const existing = await collection.findOne({ $or: [{ email: account.email }, { loginId: account.email }, { mobileNumber: account.mobileNumber }] }).select('id').lean();
            if (existing) return { success: false, status: 409, message: 'An account with this email or mobile number already exists.' };
        }
        if (role !== 'event-coordinator') {
            const result = await registerUser({
                ...account,
                ...(role === 'student' ? { studentName: account.name } : { teacherName: account.name })
            }, { adminCreated: true });
            return { success: result.success, message: result.success ? 'User added successfully.' : result.message };
        }
        await EventCoordinator.create({
            id: uuidv4(), role, name: account.name,
            email: account.email, loginId: account.email,
            mobileNumber: account.mobileNumber,
            password: await hashPassword(account.password),
            instituteName: account.instituteName, collegeName: account.instituteName,
            adminCollege: account.instituteName, gender: account.gender
        });
        return { success: true, message: 'Event Coordinator added successfully. Use their email as the Login ID.' };
    } catch (error) {
        return { success: false, status: error.code === 11000 ? 409 : 500, message: error.code === 11000 ? 'An account with these details already exists.' : 'The account could not be saved. Please try again.' };
    }
}

async function findManagedUser(id, role) {
    if (typeof id !== 'string' || !id || !['student', 'faculty', 'event-coordinator'].includes(role)) return null;
    const identifiers = [{ id }];
    if (mongoose.isValidObjectId(id)) identifiers.push({ _id: id });
    const collection = { student: Student, faculty: Faculty, 'event-coordinator': EventCoordinator }[role];
    const query = { role, $or: identifiers };
    const account = await collection.findOne(query).lean();
    if (account) return { collection, account };
    if (role === 'event-coordinator') {
        const legacy = await User.findOne({ role: 'admin', adminCategory: 'tnp', $or: identifiers }).lean();
        if (legacy) return { collection: User, account: legacy };
    }
    return null;
}

async function updateManagedUser(input) {
    const validation = validateManagedUserInput(input, true);
    if (!validation.success) return validation;
    const { account: changes } = validation;
    const database = await connectDB();
    if (!database || !isConnected()) return { success: false, status: 503, message: 'MongoDB is unavailable. Changes were not saved.' };
    try {
        const target = await findManagedUser(input.userId, changes.role);
        if (!target) return { success: false, status: 404, message: 'Account not found.' };
        for (const collection of [Student, Faculty, Admin, EventCoordinator, User]) {
            const query = { $or: [{ email: changes.email }, { loginId: changes.email }, { mobileNumber: changes.mobileNumber }] };
            if (collection === target.collection) query._id = { $ne: target.account._id };
            if (await collection.exists(query)) return { success: false, status: 409, message: 'Another account uses this email or mobile number.' };
        }
        const fields = { name: changes.name, email: changes.email, mobileNumber: changes.mobileNumber, gender: changes.gender || null };
        if (changes.role === 'event-coordinator') {
            Object.assign(fields, { instituteName: changes.instituteName, collegeName: changes.instituteName, adminCollege: changes.instituteName, loginId: changes.email });
        } else {
            Object.assign(fields, { collegeName: changes.collegeName, department: changes.department });
            if (changes.role === 'faculty') Object.assign(fields, { teacherName: changes.name, adminCollege: changes.collegeName, adminDepartment: changes.department });
            else Object.assign(fields, { studentName: changes.name, semester: changes.semester, enrollmentNumber: changes.enrollmentNumber });
        }
        if (changes.password) fields.password = await hashPassword(changes.password);
        if (changes.role === 'student' && changes.picture) fields.picture = changes.picture;
        const updated = await target.collection.updateOne({ _id: target.account._id, role: target.account.role }, { $set: fields }, { runValidators: true });
        if (!updated.matchedCount) return { success: false, status: 404, message: 'Account no longer exists.' };
        return { success: true, message: 'Account details updated successfully.' };
    } catch (error) {
        return { success: false, status: error.code === 11000 ? 409 : 500, message: error.code === 11000 ? 'Another account uses these details.' : 'Account details could not be updated.' };
    }
}

async function deleteManagedAccount(input) {
    if (!['student', 'faculty', 'event-coordinator'].includes(input.role) || typeof input.userId !== 'string' || !input.userId) {
        return { success: false, message: 'Select a Student, Faculty, or Event Coordinator account.' };
    }
    const database = await connectDB();
    if (!database || !isConnected()) return { success: false, status: 503, message: 'MongoDB is unavailable. The account was not deleted.' };
    try {
        const target = await findManagedUser(input.userId, input.role);
        if (!target) return { success: false, status: 404, message: 'Account not found.' };
        const result = await target.collection.deleteOne({ _id: target.account._id, role: target.account.role });
        if (!result.deletedCount) return { success: false, status: 404, message: 'Account no longer exists.' };
        return { success: true, message: 'Account deleted successfully.' };
    } catch (error) {
        return { success: false, status: 500, message: 'The account could not be deleted.' };
    }
}

async function registerUser(user, { adminCreated = false } = {}) {
    if (!isStrongPassword(user.password)) {
        return {
            success: false,
            message: 'Password must be 6-20 characters and include an uppercase letter, a lowercase letter, a number, and a special character.'
        };
    }

    const email = normalizeEmail(user.email);
    const mobileNumber = normalizeMobileNumber(user.mobileNumber);
    const role = (user.role || 'student').toLowerCase();
    if (!['student', 'faculty'].includes(role)) return { success: false, message: 'Select Student or Faculty for registration.' };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 30) {
        return { success: false, message: 'Enter a valid email address up to 30 characters.' };
    }
    const enrollmentNumber = role === 'student' ? normalizeEnrollmentNumber(user.enrollmentNumber) : user.enrollmentNumber;
    const gender = String(user.gender || '').trim().toLowerCase();
    if (gender && !['male', 'female', 'other', 'prefer-not-to-say'].includes(gender)) {
        return { success: false, message: 'Select a valid gender.' };
    }
    if (['student', 'faculty'].includes(role) && !mobileNumber) {
        return { success: false, message: 'Mobile number is required for registration.' };
    }
    if (role === 'student' && !enrollmentNumber) {
        return { success: false, message: 'Enrollment number is required for student registration.' };
    }
    const safeUser = {
        ...user,
        id: user.id || uuidv4(),
        email,
        mobileNumber,
        enrollmentNumber,
        gender: ['student', 'faculty'].includes(role) ? gender || null : undefined,
        password: await hashPassword(user.password),
        name: user.name || user.studentName || user.teacherName,
        role
    };

    const database = await connectDB();
    if (!database || !isConnected()) {
        return { success: false, message: 'Registration could not be saved because MongoDB is unavailable. Please try again.' };
    }

    try {
        const existingUser = await findExistingUserRecord(email, mobileNumber, role, enrollmentNumber);

        if (existingUser) {
            const duplicateField = existingUser.email === email
                ? 'email'
                : existingUser.mobileNumber === mobileNumber
                    ? 'mobile number'
                    : 'enrollment number';
            return { success: false, message: `An account with this ${duplicateField} already exists.` };
        }

        const roleCollection = role === 'student' ? Student : Faculty;
        const roleData = {
            id: safeUser.id,
            name: safeUser.name,
            email: safeUser.email,
            mobileNumber: safeUser.mobileNumber,
            password: safeUser.password,
            role: safeUser.role,
            studentName: safeUser.studentName,
            teacherName: safeUser.teacherName,
            collegeName: safeUser.collegeName || safeUser.adminCollege,
            department: safeUser.department || safeUser.adminDepartment,
            gender: safeUser.gender,
            ...(role === 'faculty' ? { approvalStatus: adminCreated ? 'approved' : 'pending', registrationSource: adminCreated ? 'admin' : 'self' } : {}),
            ...(role === 'student' ? { semester: safeUser.semester, enrollmentNumber: safeUser.enrollmentNumber } : {}),
            adminCollege: safeUser.adminCollege,
            adminDepartment: safeUser.adminDepartment,
            adminCategory: safeUser.adminCategory,
            picture: safeUser.picture,
            createdAt: new Date()
        };

        const createdUser = await roleCollection.create(roleData);

        return {
            success: true,
            message: role === 'faculty' && !adminCreated ? 'Registration successful. Approval Pending From Admin' : 'Registration successful. You can now sign in.',
            user: createdUser.toObject()
        };
    } catch (error) {
        console.error('Mongo user registration failed:', error.message);
        if (error.code === 11000) {
            const duplicateKey = Object.keys(error.keyPattern || {})[0];
            const duplicateField = {
                email: 'email',
                mobileNumber: 'mobile number',
                enrollmentNumber: 'enrollment number'
            }[duplicateKey];
            if (duplicateField) {
                return { success: false, message: `An account with this ${duplicateField} already exists.` };
            }
        }
        return { success: false, message: 'Registration could not be saved to MongoDB. Please try again.' };
    }
}

function isFacultyApprovalPending(user) {
    return Boolean(user && user.role === 'faculty' && user.approvalStatus === 'pending');
}

async function checkFacultySessionApproval(sessionUser) {
    if (!sessionUser || sessionUser.role !== 'faculty') return { allowed: true };
    const database = await connectDB();
    if (!database || !isConnected()) return { allowed: false, message: 'Unable to verify faculty approval. Please try again.' };
    const identity = typeof sessionUser.id === 'string' && sessionUser.id ? { id: sessionUser.id } : { email: normalizeEmail(sessionUser.email) };
    const faculty = await Faculty.findOne({ ...identity, role: 'faculty' }).select('role approvalStatus').lean();
    if (!faculty) return { allowed: false, message: 'This account is no longer available. Please sign in again.' };
    return isFacultyApprovalPending(faculty) ? { allowed: false, message: 'Approval Pending From Admin' } : { allowed: true };
}

async function setFacultyApproval(input) {
    if (typeof input.userId !== 'string' || !input.userId || !['approved', 'pending'].includes(input.approvalStatus)) {
        return { success: false, message: 'Select a faculty account and a valid approval action.' };
    }
    const database = await connectDB();
    if (!database || !isConnected()) return { success: false, status: 503, message: 'MongoDB is unavailable. Approval was not changed.' };
    try {
        const target = await findManagedUser(input.userId, 'faculty');
        if (!target) return { success: false, status: 404, message: 'Faculty account not found.' };
        const result = await Faculty.updateOne({ _id: target.account._id, role: 'faculty' }, { $set: { approvalStatus: input.approvalStatus } }, { runValidators: true });
        if (!result.matchedCount) return { success: false, status: 404, message: 'Faculty account no longer exists.' };
        return { success: true, message: input.approvalStatus === 'approved' ? 'Faculty approved. Login is now enabled.' : 'Faculty moved to Pending. Login is now blocked.' };
    } catch (error) {
        return { success: false, status: 500, message: 'Faculty approval could not be changed.' };
    }
}

async function loginUser(identifier, password, role) {
    const normalizedRole = String(role || '').trim().toLowerCase();

    await connectDB();

    if (['admin', 'admin-2.0', 'event-coordinator'].includes(normalizedRole)) {
        const loginId = String(identifier || '').trim();
        const invalidCredentials = { success: false, message: 'Login ID, password, or account type is incorrect.' };
        if (!loginId || !isConnected()) {
            return invalidCredentials;
        }

        try {
            const roleModel = normalizedRole === 'event-coordinator' ? EventCoordinator : Admin;
            const legacyQuery = normalizedRole === 'event-coordinator'
                ? { role: 'admin', adminCategory: 'tnp', loginId }
                : { role: 'admin', loginId };
            let collection = roleModel;
            let user = await roleModel.findOne({ loginId }).lean();
            if (!user) {
                collection = User;
                user = await User.findOne(legacyQuery).lean();
            }
            if (!user || (normalizedRole === 'admin-2.0' && user.adminCategory === 'tnp') || !(await verifyStoredPassword(password, user, collection))) {
                return invalidCredentials;
            }

            return {
                success: true,
                message: `Welcome back, ${user.name || user.loginId}.`,
                user
            };
        } catch (error) {
            console.error('Mongo admin login failed:', error.message);
            return invalidCredentials;
        }
    }

    const normalizedEmail = normalizeEmail(identifier);
    const normalizedMobile = normalizeMobileNumber(identifier);

    if (isConnected()) {
        try {
            const credentialMatches = [];

            if (normalizedEmail) {
                credentialMatches.push({ email: normalizedEmail });
            }

            if (normalizedMobile) {
                credentialMatches.push({ mobileNumber: normalizedMobile });
            }

            if (credentialMatches.length === 0) {
                return { success: false, message: 'Email, password, or account type is incorrect.' };
            }

            const collections = normalizedRole === 'student' ? [Student, Faculty] : [Faculty, Student];
            for (const collection of collections) {
                const user = await collection.findOne({
                    ...(normalizedRole ? { role: normalizedRole } : {}),
                    $or: credentialMatches
                }).lean();

                if (!user) {
                    continue;
                }

                const isPasswordValid = await verifyStoredPassword(password, user, collection);
                if (!isPasswordValid) {
                    return { success: false, message: 'Email, password, or account type is incorrect.' };
                }

                if (isFacultyApprovalPending(user)) return { success: false, message: 'Approval Pending From Admin' };

                return {
                    success: true,
                    message: `Welcome back, ${user.name || user.studentName || user.teacherName}.`,
                    user
                };
            }

            return { success: false, message: 'Email, password, or account type is incorrect.' };
        } catch (error) {
            console.error('Mongo user login failed:', error.message);
        }
    }

    const user = users.find((savedUser) =>
        (savedUser.email === normalizedEmail || (normalizedMobile && savedUser.mobileNumber === normalizedMobile)) &&
        savedUser.role === role
    );

    if (!user) {
        return { success: false, message: 'Email, password, or account type is incorrect.' };
    }

    const isPasswordValid = await comparePassword(password, user.password);
    if (!isPasswordValid) {
        return { success: false, message: 'Email, password, or account type is incorrect.' };
    }

    if (isFacultyApprovalPending(user)) return { success: false, message: 'Approval Pending From Admin' };

    return {
        success: true,
        message: `Welcome back, ${user.name || user.studentName || user.teacherName}.`,
        user
    };
}

async function loginUserByPhone(mobileNumber, role) {
    const normalizedMobile = normalizeMobileNumber(mobileNumber);
    const normalizedRole = String(role || '').trim().toLowerCase();

    if (!normalizedMobile) {
        return { success: false, message: 'A valid mobile number is required for WhatsApp login.' };
    }

    await connectDB();

    if (isConnected()) {
        try {
            const collections = normalizedRole === 'student' ? [Student, Faculty] : [Faculty, Student];
            for (const collection of collections) {
                const user = await collection.findOne({
                    ...(normalizedRole ? { role: normalizedRole } : {}),
                    mobileNumber: normalizedMobile
                }).lean();

                if (user) {
                    if (isFacultyApprovalPending(user)) return { success: false, message: 'Approval Pending From Admin' };
                    return {
                        success: true,
                        message: `Welcome back, ${user.name || user.studentName || user.teacherName}.`,
                        user
                    };
                }
            }

            return { success: false, message: 'No account found for this WhatsApp number.' };
        } catch (error) {
            console.error('Mongo phone login failed:', error.message);
            return { success: false, message: 'Unable to authenticate with WhatsApp login.' };
        }
    }

    const user = users.find((savedUser) => savedUser.mobileNumber === normalizedMobile && savedUser.role === normalizedRole);
    if (!user) {
        return { success: false, message: 'No account found for this WhatsApp number.' };
    }

    if (isFacultyApprovalPending(user)) return { success: false, message: 'Approval Pending From Admin' };

    return {
        success: true,
        message: `Welcome back, ${user.name || user.studentName || user.teacherName}.`,
        user
    };
}

async function findUserByEmail(email, role) {
    const normalizedEmail = normalizeEmail(email);
    const normalizedRole = String(role || '').trim().toLowerCase();

    if (!normalizedEmail) {
        return null;
    }

    await connectDB();

    if (isConnected()) {
        try {
            const collections = normalizedRole === 'student' ? [Student, Faculty] : [Faculty, Student];
            for (const collection of collections) {
                const user = await collection.findOne({
                    ...(normalizedRole ? { role: normalizedRole } : {}),
                    email: normalizedEmail
                }).lean();

                if (user) {
                    return user;
                }
            }

            for (const collection of [Student, Faculty]) {
                const user = await collection.findOne({ email: normalizedEmail }).lean();
                if (user) {
                    return user;
                }
            }
        } catch (error) {
            console.error('Mongo email lookup failed:', error.message);
        }
    }

    const user = users.find((savedUser) => savedUser.email === normalizedEmail && (!normalizedRole || savedUser.role === normalizedRole));
    return user || users.find((savedUser) => savedUser.email === normalizedEmail) || null;
}

async function findUserByPhone(phoneNumber) {
    const normalizedPhone = normalizeMobileNumber(phoneNumber);

    if (!normalizedPhone) {
        return null;
    }

    await connectDB();

    if (isConnected()) {
        try {
            for (const collection of [Student, Faculty]) {
                const user = await collection.findOne({ mobileNumber: normalizedPhone }).lean();
                if (user) {
                    return user;
                }
            }
        } catch (error) {
            console.error('Mongo phone lookup failed:', error.message);
        }
    }

    return users.find((savedUser) => normalizeMobileNumber(savedUser.mobileNumber) === normalizedPhone) || null;
}

function summarizeManagedAccount(account, role) {
    return {
        id: String(account.id || account._id || ''),
        name: account.name || account.studentName || account.teacherName || '',
        email: account.email || '',
        mobileNumber: account.mobileNumber || '',
        role,
        adminCategory: account.adminCategory || '',
        collegeName: account.collegeName || account.adminCollege || '',
        department: account.department || account.adminDepartment || '',
        gender: account.gender || '',
        semester: account.semester || '',
        enrollmentNumber: account.enrollmentNumber || '',
        instituteName: account.instituteName || account.collegeName || account.adminCollege || '',
        loginId: account.loginId || '',
        ...(role === 'faculty' ? { approvalStatus: account.approvalStatus === 'pending' ? 'pending' : 'approved', registrationSource: account.registrationSource || 'legacy' } : {}),
        createdAt: account.createdAt || null
    };
}

async function listUsersForAdmin() {
    try {
        await connectDB();

        if (isConnected()) {
            const [students, faculty, admins, eventCoordinators, legacyAdmins] = await Promise.all([
                Student.find({ role: 'student' }).select('id name studentName email mobileNumber role collegeName department gender semester enrollmentNumber createdAt').lean(),
                Faculty.find({ role: 'faculty' }).select('id name teacherName email mobileNumber role collegeName department gender approvalStatus registrationSource createdAt').lean(),
                Admin.find({ role: 'admin' }).select('id name email loginId role adminCategory adminCollege adminDepartment createdAt').lean(),
                EventCoordinator.find({ role: 'event-coordinator' }).select('id name email loginId mobileNumber role gender instituteName collegeName adminCategory adminCollege adminDepartment createdAt').lean(),
                User.find({ role: 'admin' }).select('id name email loginId mobileNumber role gender instituteName adminCategory adminCollege adminDepartment createdAt').lean()
            ]);

            return [
                ...students.map((account) => summarizeManagedAccount(account, 'student')),
                ...faculty.map((account) => summarizeManagedAccount(account, 'faculty')),
                ...admins.map((account) => summarizeManagedAccount(account, 'admin')),
                ...eventCoordinators.map((account) => summarizeManagedAccount(account, 'event-coordinator')),
                ...legacyAdmins.map((account) => summarizeManagedAccount(account, account.adminCategory === 'tnp' ? 'event-coordinator' : 'admin'))
            ].sort((left, right) => new Date(right.createdAt || 0) - new Date(left.createdAt || 0));
        }
    } catch (error) {
        console.error('Admin account list failed:', error.message);
    }

    return users.map((account) => summarizeManagedAccount(account, account.role));
}

async function deleteManagedUser(userId, role) {
    const normalizedId = String(userId || '').trim();
    const normalizedRole = String(role || '').trim().toLowerCase();
    if (!normalizedId || !['student', 'faculty'].includes(normalizedRole)) {
        return { success: false, message: 'Only student and faculty accounts can be deleted.' };
    }

    try {
        await connectDB();

        if (isConnected()) {
            const collection = normalizedRole === 'student' ? Student : Faculty;
            const account = await collection.findOne({ id: normalizedId, role: normalizedRole }).select('id email').lean();
            if (!account) {
                return { success: false, message: 'Account not found.' };
            }
            await collection.deleteOne({ id: normalizedId, role: normalizedRole });
            return { success: true, user: { id: account.id, email: account.email } };
        }
    } catch (error) {
        console.error('Admin account deletion failed:', error.message);
        return { success: false, message: 'Account could not be deleted.' };
    }

    const index = users.findIndex((account) => account.id === normalizedId && account.role === normalizedRole);
    if (index === -1) {
        return { success: false, message: 'Account not found.' };
    }

    const [account] = users.splice(index, 1);
    return { success: true, user: { id: account.id, email: account.email } };
}

async function findPasswordResetAccount(mobileNumber, role) {
    if (!['student', 'faculty'].includes(role)) return null;
    await connectDB();
    if (!isConnected()) throw new Error('Database unavailable. Password recovery requires MongoDB.');
    const collection = role === 'student' ? Student : Faculty;
    const account = await collection.findOne({ mobileNumber, role }).select('id email mobileNumber role').lean();
    return account ? {
        documentId: String(account._id), id: account.id, email: account.email,
        mobileNumber: account.mobileNumber, role, storage: 'mongo'
    } : null;
}

async function updatePasswordResetAccount(account, password) {
    if (!account || account.storage !== 'mongo' || !['student', 'faculty'].includes(account.role)) {
        throw new Error('Password recovery requires a database account.');
    }
    const hashedPassword = await hashPassword(password);
    await connectDB();
    if (!isConnected()) throw new Error('Database unavailable. Password was not saved.');
    const collection = account.role === 'student' ? Student : Faculty;
    const query = { _id: account.documentId, role: account.role, mobileNumber: account.mobileNumber };
    const result = await collection.updateOne(query, { $set: { password: hashedPassword } });
    if (!result.acknowledged || result.matchedCount !== 1) throw new Error('Account no longer available.');
    // Confirm the persisted value using the same bcrypt comparison as login.
    const savedAccount = await collection.findOne(query).select('email role password').lean();
    if (!savedAccount || !(await comparePassword(password, savedAccount.password))) {
        throw new Error('The saved password could not be verified. Please try again.');
    }
    return { email: savedAccount.email, role: savedAccount.role };
}

function studentLookupKeys(identifier) {
    const value = String(identifier || '').trim();
    const digits = normalizeMobileNumber(value);
    const mobileNumbers = [];
    if (/^[+\d\s()-]+$/.test(value) && (digits.length === 10 || (digits.length === 12 && digits.startsWith('91')))) {
        mobileNumbers.push(digits, ...(digits.length === 12 ? [digits.slice(2)] : []));
    }
    return { enrollmentNumber: normalizeEnrollmentNumber(value), mobileNumbers };
}

async function findStudentForParticipation(identifier) {
    await connectDB();
    if (!isConnected()) return null;
    const keys = studentLookupKeys(identifier);
    const matches = [{ enrollmentNumber: keys.enrollmentNumber }];
    if (keys.mobileNumbers.length) matches.push({ mobileNumber: { $in: keys.mobileNumbers } });
    const students = await Student.find({ $or: matches, role: 'student' })
        .select('id name studentName email mobileNumber enrollmentNumber department semester collegeName gender')
        .limit(2).lean();
    if (students.length > 1) {
        const error = new Error('This number matches more than one student. Enter their enrollment number or another registered mobile number.');
        error.code = 'AMBIGUOUS_STUDENT';
        throw error;
    }
    return students[0] || null;
}

async function findCoordinatorProfile(user) {
    await connectDB();
    if (!isConnected()) return null;
    const identifiers = [
        ...(user.id ? [{ id: user.id }] : []),
        ...(user.email ? [{ email: normalizeEmail(user.email) }] : [])
    ];
    if (!identifiers.length) return null;
    for (const collection of [EventCoordinator, Admin, User]) {
        const profile = await collection.findOne({ $or: identifiers })
            .select('name collegeName instituteName adminCollege').lean();
        if (profile) return profile;
    }
    return null;
}

module.exports = {
    studentLookupKeys,
    findCoordinatorProfile,
    findStudentForParticipation,
    initializeUserCollections,
    ensureDefaultEventCoordinator,
    migrateLegacyAdminAccounts,
    registerUser,
    createManagedUser,
    updateManagedUser,
    deleteManagedAccount,
    isFacultyApprovalPending,
    checkFacultySessionApproval,
    setFacultyApproval,
    loginUser,
    loginUserByPhone,
    findUserByEmail,
    findUserByPhone,
    listUsersForAdmin,
    deleteManagedUser,
    findPasswordResetAccount,
    updatePasswordResetAccount,
    Admin,
    EventCoordinator,
    Student,
    Faculty,
    User
};
