const http = require('http');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const nodemailer = require('nodemailer');
const dotenv = require('dotenv');
const init = require('init');
const mailgun = require('mailgun.js');
const FormData = require('form-data');
const festivalModel = require('../Model/festivalModel1');
const userModel = require('../Model/userModel');
const { importParticipants } = require('./participation-import');
const { createPasswordResetService } = require('./password-reset');
const { sendPasswordOtp } = require('./httpsms');
const { connectDB, mongoose } = require('../Model/db');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const port = 3000;
const viewFolder = path.join(__dirname, '..', 'View');
let emailTransporter = null;
let mailgunClient = null;
const customForms = [];
const customFormSubmissions = [];
const whatsappLoginTokens = new Map();
const formResubmissionDelay = 24 * 60 * 60 * 1000;
const validCustomFormTypes = new Set(['short-answer', 'paragraph', 'multiple-choice', 'checkboxes']);
const choiceQuestionTypes = new Set(['multiple-choice', 'checkboxes']);
const staticAssetCache = new Map();
const serverLimits = {
	maxConcurrentRequests: 2000,
	requestTimeoutMs: 15000
};
const activeRequests = { count: 0 };

const passwordResetService = createPasswordResetService({
    findAccount: userModel.findPasswordResetAccount,
    updatePassword: userModel.updatePasswordResetAccount,
    deliverOtp: sendPasswordOtp
});

void init;

function normalizeCustomFormQuestions(rawQuestions, autoGrade) {
	if (!Array.isArray(rawQuestions)) {
		return { error: 'Add at least one question to the form.' };
	}

	const questions = rawQuestions
		.map((question) => ({
			label: String(question.label || '').trim(),
			type: String(question.type || 'short-answer'),
			required: question.required === true,
			options: Array.isArray(question.options) ? question.options.map((option) => String(option).trim()).filter(Boolean) : [],
			correctAnswers: question.correctAnswers,
			teacherAnswer: String(question.teacherAnswer || '').trim()
		}))
		.filter((question) => question.label);

	if (!questions.length) {
		return { error: 'Form title and at least one question are required.' };
	}

	for (const question of questions) {
		if (!validCustomFormTypes.has(question.type)) {
			return { error: 'Choose a valid question type.' };
		}
		if (choiceQuestionTypes.has(question.type) && (question.options.length < 2 || new Set(question.options).size !== question.options.length)) {
			return { error: 'Each choice question needs at least two unique answer options.' };
		}
		if (autoGrade && question.type === 'paragraph') {
			return { error: 'Auto-scored quizzes cannot contain paragraph questions. Use short answer or choice questions.' };
		}

		if (autoGrade) {
			const correctAnswers = question.type === 'checkboxes'
				? (Array.isArray(question.correctAnswers) ? question.correctAnswers.map(String) : [])
				: [String(Array.isArray(question.correctAnswers) ? question.correctAnswers[0] || '' : question.correctAnswers || '').trim()].filter(Boolean);
			if (question.type === 'short-answer') {
				if (!correctAnswers.length) {
					return { error: 'Enter the correct answer for every text-answer quiz question.' };
				}
				question.correctAnswers = correctAnswers;
				continue;
			}
			if (!correctAnswers.length || (question.type === 'multiple-choice' && correctAnswers.length !== 1) || correctAnswers.some((answer) => !question.options.includes(answer))) {
				return { error: 'Select the correct answer for every quiz question.' };
			}
			question.correctAnswers = [...new Set(correctAnswers)];
		} else {
			delete question.correctAnswers;
		}
	}

	return { questions };
}

function getSubmissionReview(form, answers) {
	const gradedQuestionIndexes = form.questions
		.map((question, index) => ({ question, index }))
		.filter(({ question }) => form.autoGrade || question.teacherAnswer);
	if (!gradedQuestionIndexes.length) {
		return { score: null, total: null, review: null };
	}

	let score = 0;
	const review = gradedQuestionIndexes.map(({ question, index }) => {
		const submittedAnswer = question.type === 'checkboxes'
			? (Array.isArray(answers[index]) ? answers[index].map(String) : [])
			: String(answers[index] || '');
		const submittedValues = Array.isArray(submittedAnswer) ? submittedAnswer : [submittedAnswer];
		const correctAnswers = question.correctAnswers || [];
		const isCorrect = form.autoGrade && choiceQuestionTypes.has(question.type)
			? submittedValues.length === correctAnswers.length && submittedValues.every((answer) => correctAnswers.includes(answer))
			: submittedValues.map((answer) => answer.trim().toLocaleLowerCase()).join(',') ===
				String(question.teacherAnswer || correctAnswers[0] || '').trim().toLocaleLowerCase();
		if (isCorrect) score += 1;
		return {
			question: question.label,
			answer: submittedAnswer,
			correctAnswer: question.teacherAnswer || (question.type === 'checkboxes' ? correctAnswers : correctAnswers[0]),
			isCorrect
		};
	});

	return { score, total: gradedQuestionIndexes.length, review };
}

function sanitizeCustomFormForStudent(form) {
	return {
		...form,
		questions: form.questions.map(({ correctAnswers, teacherAnswer, ...question }) => question)
	};
}

function findLatestSubmission(submissions, formId, studentId) {
	return submissions.reduce((latestSubmission, submission) => {
		if (submission.formId !== formId || submission.studentId !== studentId) {
			return latestSubmission;
		}
		return !latestSubmission || submission.submittedAt > latestSubmission.submittedAt ? submission : latestSubmission;
	}, null);
}

function getLastCustomFormSubmission(formId, studentId) {
	return findLatestSubmission(customFormSubmissions, formId, studentId);
}

function getStudentFormsForDashboard(forms, submissions, studentId, now = Date.now()) {
	return forms.filter((form) => {
		const isPublishedAndNotExpired = form.visibleToStudents && now < new Date(form.endAt).getTime();
		const lastSubmission = findLatestSubmission(submissions, form.id, studentId);
		const canSubmitAgain = !lastSubmission || now - lastSubmission.submittedAt >= formResubmissionDelay;
		return isPublishedAndNotExpired && canSubmitAgain;
	}).map(sanitizeCustomFormForStudent);
}

function getLastCustomFormSubmissionFrom(submissions, formId, studentId) {
	return findLatestSubmission(submissions, formId, studentId);
}

function getCachedStaticAsset(fileName, encoding = 'utf8') {
	const cacheKey = `${fileName}:${encoding}`;
	if (!staticAssetCache.has(cacheKey)) {
		staticAssetCache.set(cacheKey, fs.readFileSync(path.join(viewFolder, fileName), encoding));
	}
	return staticAssetCache.get(cacheKey);
}

function sendJson(response, statusCode, payload, headers = {}) {
	response.writeHead(statusCode, {
		'Content-Type': 'application/json; charset=utf-8',
		...headers
	});
	response.end(JSON.stringify(payload));
}

function enforceRequestConcurrency(request, response, next) {
	if (activeRequests.count >= serverLimits.maxConcurrentRequests) {
		sendJson(response, 503, {
			success: false,
			message: 'The website is temporarily busy. Please try again in a moment.'
		}, { 'Retry-After': '1' });
		return;
	}

	activeRequests.count += 1;
	const release = () => {
		activeRequests.count = Math.max(0, activeRequests.count - 1);
	};
	request.once('close', release);
	request.once('error', release);
	next();
}

function enforceRequestTimeout(request, response, next) {
	const timeoutId = setTimeout(() => {
		if (response.writableEnded || response.headersSent) {
			return;
		}
		response.writeHead(504, {
			'Content-Type': 'application/json; charset=utf-8',
			'Retry-After': '1'
		});
		response.end(JSON.stringify({ success: false, message: 'Request timed out. Please try again.' }));
	}, serverLimits.requestTimeoutMs);

	request.once('close', () => clearTimeout(timeoutId));
	next();
}

function runRequestMiddleware(request, response, next) {
	const middleware = [enforceRequestConcurrency, enforceRequestTimeout];
	let index = 0;
	const runNext = () => {
		const currentMiddleware = middleware[index];
		if (!currentMiddleware) {
			next();
			return;
		}
		index += 1;
		currentMiddleware(request, response, runNext);
	};
	runNext();
}

function hasAllowedOrigin(request) {
	const origin = request.headers.origin;
	if (!origin) {
		return true;
	}
	const host = request.headers.host || '';
	return origin === `http://${host}` || origin === `https://${host}`;
}

function getSmtpConfig() {
	const hasRealCredentials = Boolean(process.env.EMAIL_USER && process.env.EMAIL_PASS);

	if (hasRealCredentials) {
		const host = process.env.SMTP_HOST || 'smtp.gmail.com';
		const isGmail = host.toLowerCase().includes('gmail');

		if (isGmail && !process.env.SMTP_HOST) {
			return {
				service: 'gmail',
				auth: {
					user: process.env.EMAIL_USER,
					pass: process.env.EMAIL_PASS
				}
			};
		}

		return {
			host,
			port: Number(process.env.SMTP_PORT || 587),
			secure: (process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
			auth: {
				user: process.env.EMAIL_USER,
				pass: process.env.EMAIL_PASS
			}
		};
	}

	return {
		host: 'smtp.ethereal.email',
		port: 587,
		secure: false,
		auth: {
			user: '',
			pass: ''
		}
	};
}

function initMailgun() {
	if (process.env.MAILGUN_API_KEY && process.env.MAILGUN_DOMAIN) {
		const mg = mailgun.client({
			username: 'api',
			key: process.env.MAILGUN_API_KEY
		});
		mailgunClient = mg.messages;
		console.log('Mailgun email service configured successfully.');
		return true;
	}
	return false;
}

function readJsonBody(request, maxBytes = Infinity) {
	return new Promise((resolve, reject) => {
		let body = '';
		let size = 0;
		request.on('data', (chunk) => {
			size += chunk.length;
			if (size > maxBytes) {
				reject(new Error('Request is too large. Use a student picture under 2 MB.'));
				return;
			}
			body += chunk.toString();
		});
		request.on('end', () => {
			if (!body) {
				resolve({});
				return;
			}

			try {
				resolve(JSON.parse(body));
			} catch (error) {
				resolve(Object.fromEntries(new URLSearchParams(body)));
			}
		});
		request.on('error', reject);
	});
}

function readFormData(request) {
	return new Promise((resolve, reject) => {
		const chunks = [];

		request.on('data', (chunk) => chunks.push(chunk));
		request.on('end', () => {
			const body = Buffer.concat(chunks);
			const contentType = request.headers['content-type'] || '';

			if (contentType.startsWith('application/x-www-form-urlencoded')) {
				resolve(Object.fromEntries(new URLSearchParams(body.toString())));
				return;
			}

			const boundary = contentType.match(/boundary=([^;]+)/)?.[1];
			if (!boundary) {
				resolve({});
				return;
			}

			const formData = {};
			const parts = body.toString().split(`--${boundary}`);

			parts.forEach((part) => {
				const fieldName = part.match(/name="([^"]+)"/)?.[1];
				if (!fieldName) {
					return;
				}

				const valueStart = part.indexOf('\r\n\r\n');
				if (valueStart === -1) {
					return;
				}

				let value = part.slice(valueStart + 4).replace(/\r\n--$/, '').replace(/\r\n$/, '');
				const fileName = part.match(/filename="([^"]*)"/)?.[1];
				formData[fieldName] = fileName || value;
			});

			resolve(formData);
		});
		request.on('error', reject);
	});
}

function renderAuthPage(response, mode, message = '', success = false, returnTo = '') {
	const template = fs.readFileSync(path.join(viewFolder, 'auth.html'), 'utf8');
	const page = ejs.render(template, { authMode: mode, message, success, user: null, returnTo });
	response.writeHead(200, { 'Content-Type': 'text/html' });
	response.end(page);
}

function getPageErrorMeta(pageName) {
	const pages = {
		dashboard: {
			title: 'Dashboard',
			message: 'The dashboard is temporarily unavailable. Please refresh the page or try again in a moment.',
			backLink: '/'
		},
		calendar: {
			title: 'Calendar',
			message: 'The calendar page could not be loaded right now. Please try again later.',
			backLink: '/calendar'
		},
		auth: {
			title: 'Authentication',
			message: 'The login or registration page is not available right now. Please try again later.',
			backLink: '/login'
		},
		destinations: {
			title: 'Destinations',
			message: 'The destinations page is temporarily unavailable. Please try again shortly.',
			backLink: '/destinations'
		},
		about: {
			title: 'About',
			message: 'The about page could not be loaded. Please try refreshing the page.',
			backLink: '/about'
		},
		explore: {
			title: 'Explore',
			message: 'The explore page is currently unavailable.',
			backLink: '/explore'
		},
		default: {
			title: 'Page',
			message: 'This page is currently not working. Please try again in a few minutes.',
			backLink: '/'
		}
	};

	return pages[pageName] || pages.default;
}

function sendPageError(response, pageName, statusCode = 500, customMessage) {
	const pageMeta = getPageErrorMeta(pageName);
	const message = customMessage || pageMeta.message;

	const html = `
		<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1.0" />
			<title>${pageMeta.title} Error</title>
			<style>
				body { font-family: Arial, sans-serif; background: #f8fafc; color: #1f2937; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
				.card { max-width: 540px; background: white; border-radius: 16px; padding: 32px; box-shadow: 0 14px 30px rgba(15, 23, 42, 0.08); text-align: center; }
				.badge { display: inline-block; padding: 6px 12px; border-radius: 999px; background: #fee2e2; color: #b91c1c; font-weight: bold; letter-spacing: 0.04em; font-size: 13px; }
				h1 { margin: 18px 0 12px; font-size: 32px; color: #111827; }
				p { margin: 0 0 24px; line-height: 1.6; color: #4b5563; }
				a { display: inline-block; text-decoration: none; background: #2563eb; color: white; padding: 12px 18px; border-radius: 10px; font-weight: 600; }
			</style>
		</head>
		<body>
			<div class="card">
				<div class="badge">${pageMeta.title} Error</div>
				<h1>Something went wrong</h1>
				<p>${message}</p>
				<a href="${pageMeta.backLink}">Go back</a>
			</div>
		</body>
		</html>
	`;

	response.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8' });
	response.end(html);
}

function getSessionUser(request) {
	const cookieHeader = request.headers.cookie || '';
	const cookies = Object.fromEntries(
		cookieHeader
			.split(';')
			.map((entry) => {
				const trimmed = entry.trim();
				if (!trimmed) {
					return null;
				}
				const separatorIndex = trimmed.indexOf('=');
				if (separatorIndex === -1) {
					return [trimmed, ''];
				}
				const key = trimmed.slice(0, separatorIndex);
				const value = trimmed.slice(separatorIndex + 1);
				return [key, decodeURIComponent(value)];
			})
			.filter(Boolean)
	);

	const sessionUser = cookies.utsavfest_user;
	if (!sessionUser) {
		return null;
	}

	try {
		return JSON.parse(sessionUser);
	} catch (error) {
		return null;
	}
}

function setSessionCookie(response, user, useAdminDashboard = false) {
	const safeUser = {
		id: user.id,
		email: user.email,
		name: user.name || user.studentName || user.teacherName,
		role: user.role,
		adminCategory: user.adminCategory,
		useAdminDashboard: Boolean(useAdminDashboard && isSystemAdmin(user))
	};

	response.setHeader('Set-Cookie', `utsavfest_user=${encodeURIComponent(JSON.stringify(safeUser))}; Path=/; HttpOnly; SameSite=Lax`);
}

function clearSessionCookie(response) {
	response.setHeader('Set-Cookie', 'utsavfest_user=; Path=/; HttpOnly; SameSite=Lax; max-age=0; expires=Thu, 01 Jan 1970 00:00:00 GMT');
}

function isValidSessionUser(user) {
	if (!user || typeof user !== 'object') {
		return false;
	}

	return Boolean(user.id || user.email) && Boolean(user.role);
}

function isEventCoordinator(user) {
	return Boolean(user && (
		user.role === 'event-coordinator' ||
		(user.role === 'admin' && user.adminCategory === 'tnp')
	));
}

function isSystemAdmin(user) {
	return Boolean(user && user.role === 'admin' && (!user.adminCategory || user.adminCategory === 'facility'));
}

async function renderDashboard(response, user) {
	if (isEventCoordinator(user)) {
		const profile = await userModel.findCoordinatorProfile(user);
		if (profile) {
			user = { ...user, name: profile.name || user.name, collegeName: profile.collegeName || profile.instituteName || profile.adminCollege };
		}
	}
	const template = fs.readFileSync(path.join(viewFolder, 'user-dashboard.ejs'), 'utf8');
	const now = Date.now();
	const systemAdmin = isSystemAdmin(user);
	const adminUsers = systemAdmin ? await userModel.listUsersForAdmin() : [];
	const studentId = user.id || user.email;
	const facultyId = user.id || user.email;
	const studentForms = user.role === 'student'
		? getStudentFormsForDashboard(customForms, customFormSubmissions, studentId, now)
		: [];
	const facultyForms = user.role === 'faculty'
		? customForms.filter((form) => form.teacherId === facultyId).map((form) => ({
			...form,
			submissions: customFormSubmissions
				.filter((submission) => submission.formId === form.id)
				.sort((left, right) => right.submittedAt - left.submittedAt)
		}))
		: [];
	const studentFormResults = user.role === 'student'
		? customFormSubmissions
			.filter((submission) => submission.studentId === studentId && submission.review)
			.sort((left, right) => right.submittedAt - left.submittedAt)
		: [];
	const page = ejs.render(template, {
		user,
		isEventCoordinator: isEventCoordinator(user),
		isSystemAdmin: systemAdmin,
		adminUsers,
		festivals: festivalModel.getFestivals(),
		studentForms,
		facultyForms,
		studentFormResults
	});
	response.writeHead(200, { 'Content-Type': 'text/html' });
	response.end(page);
}

async function renderAdminDashboard(response, user, pageName = 'overview', eventId = '') {
	const accounts = await userModel.listUsersForAdmin();
	const coordinatorIds = new Set(accounts.filter(account => account.role === 'event-coordinator').flatMap(account => [account.id, account.email]));
	const participationEvents = festivalModel.getFestivals().filter(event => event.createdBy && coordinatorIds.has(event.createdBy));
	const selectedEvent = pageName === 'participation' ? participationEvents.find(event => event.id === eventId) : null;
	const registrations = selectedEvent ? await festivalModel.getParticipationsForEvent(selectedEvent) : [];
	const participants = registrations.map(record => {
		const profile = accounts.find(account => account.role === 'student' && record.studentId && [account.id, account.email].includes(record.studentId));
		return { ...profile, ...record };
	});
	const template = fs.readFileSync(path.join(viewFolder, 'AdminDash.ejs'), 'utf8');
	const renderedPage = ejs.render(template, {
		dashboardData: {
			adminName: user.name || user.email || 'Administrator',
			accounts,
			participationEvents,
			selectedEvent,
			participants,
			events: festivalModel.getFestivals(),
			page: pageName
		}
	});
	response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
	response.end(renderedPage);
}

function normalizeEmail(email) {
	return String(email || '').trim().toLowerCase();
}

function getAdminDashboardPage(pathname) {
	switch (pathname) {
		case '/admin-dashboard':
			return 'overview';
		case '/admin-dashboard/students':
			return 'students';
		case '/admin-dashboard/events':
			return 'events';
		case '/admin-dashboard/approvals':
			return 'approvals';
		case '/admin-dashboard/participation':
			return 'participation';
		case '/admin-dashboard/reports':
			return 'reports';
		default:
			return null;
	}
}

function createOtp(email) {
	const otp = String(Math.floor(100000 + Math.random() * 900000));
	return otp;
}

async function createEmailTransporter() {
	if (emailTransporter) {
		return emailTransporter;
	}

	const smtpConfig = getSmtpConfig();
	if (!smtpConfig.auth.user || !smtpConfig.auth.pass) {
		const testAccount = await nodemailer.createTestAccount();
		emailTransporter = nodemailer.createTransport({
			host: 'smtp.ethereal.email',
			port: 587,
			secure: false,
			auth: {
				user: testAccount.user,
				pass: testAccount.pass
			}
		});
		console.log('No real email credentials were found. Using Ethereal test email inbox for OTP delivery.');
		console.log('Preview the OTP email in the Ethereal inbox shown during startup.');
		return emailTransporter;
	}

	emailTransporter = nodemailer.createTransport(smtpConfig);
	console.log('SMTP email transporter configured successfully.');
	return emailTransporter;
}

async function sendOtpEmail(email, otp) {
	// Try Mailgun first if configured
	if (mailgunClient && process.env.MAILGUN_DOMAIN) {
		try {
			const messageData = {
				from: process.env.EMAIL_FROM || `UtsavFest <noreply@${process.env.MAILGUN_DOMAIN}>`,
				to: email,
				subject: 'Your UtsavFest Email Verification OTP',
				html: `
					<div style="font-family: Arial, sans-serif; padding: 20px;">
						<h2>Email Verification</h2>
						<p>Your OTP is:</p>
						<h1 style="letter-spacing: 4px;">${otp}</h1>
						<p>Use this code to verify your email on UtsavFest.</p>
						<p style="color: #999; font-size: 12px;">This OTP is valid for 10 minutes.</p>
					</div>
				`
			};

			const result = await mailgunClient.create(process.env.MAILGUN_DOMAIN, messageData);
			console.log(`✓ OTP email sent successfully to ${email}. Message ID: ${result.id}`);
			return result;
		} catch (error) {
			console.error('Failed to send OTP via Mailgun:', error.message);
			// Fall back to nodemailer
		}
	}

	// Fallback to Nodemailer (Ethereal or SMTP)
	const transporter = await createEmailTransporter();
	const info = await transporter.sendMail({
		from: process.env.EMAIL_FROM || '"UtsavFest" <no-reply@utsavfest.com>',
		to: email,
		subject: 'Your UtsavFest Email Verification OTP',
		html: `
			<div style="font-family: Arial, sans-serif; padding: 20px;">
				<h2>Email Verification</h2>
				<p>Your OTP is:</p>
				<h1 style="letter-spacing: 4px;">${otp}</h1>
				<p>Use this code to verify your email on UtsavFest.</p>
				<p style="color: #999; font-size: 12px;">This OTP is valid for 10 minutes.</p>
			</div>
		`
	});

	const previewUrl = nodemailer.getTestMessageUrl(info);
	if (previewUrl) {
		console.log(`✓ OTP email preview URL: ${previewUrl}`);
	} else {
		console.log(`✓ OTP email sent successfully to ${email}. Message ID: ${info.messageId}`);
	}
	return info;
}

async function handleRequest(request, response) {
	runRequestMiddleware(request, response, async () => {
		const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
		const sessionUser = getSessionUser(request);
		if (sessionUser?.role === 'faculty' && pathname !== '/logout' && !/\.(css|js|png|jpe?g|webp|svg|ico|woff2?)$/i.test(pathname)) {
			try {
				const access = await userModel.checkFacultySessionApproval(sessionUser);
				if (!access.allowed) {
					clearSessionCookie(response);
					if (request.method === 'GET' || pathname === '/login') renderAuthPage(response, 'login', access.message, false);
					else {
						response.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
						response.end(JSON.stringify({ success: false, message: access.message }));
					}
					return;
				}
			} catch (error) {
				response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
				response.end(JSON.stringify({ success: false, message: 'Unable to verify faculty approval. Please try again.' }));
				return;
			}
		}
		handleAuthorizedRequest(request, response);
	});
}

const eventContentHandler = require('./event-content').createEventContentHandler({
	getEvents: () => festivalModel.getFestivals(),
	isCoordinator: isEventCoordinator,
	isAdmin: isSystemAdmin,
	validSession: isValidSessionUser,
	allowedOrigin: hasAllowedOrigin
});

function handleAuthorizedRequest(request, response) {
	const requestUrl = new URL(request.url, `http://${request.headers.host}`);
	const sessionUser = getSessionUser(request);
	const hasValidSession = isValidSessionUser(sessionUser);
	if (eventContentHandler.matches(requestUrl.pathname)) {
		eventContentHandler.handle(request, response, sessionUser, requestUrl).catch(error => {
			console.error('Event content failed:', error.message);
			if (response.headersSent) return response.destroy();
			response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
			response.end(JSON.stringify({ message: 'Event content could not be loaded or saved. Please try again.' }));
		});
		return;
	}

	if (request.method === 'GET' && requestUrl.pathname === '/coordinator/participants') {
		const send = (status, result) => {
			response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
			response.end(JSON.stringify(result));
		};
		if (!hasValidSession || !isEventCoordinator(sessionUser)) {
			send(403, { success: false, message: 'Only event coordinators can view these participants.' });
			return;
		}
		const event = festivalModel.getFestivalById(requestUrl.searchParams.get('eventId'));
		if (!event || !event.createdBy || ![sessionUser.id, sessionUser.email].filter(Boolean).includes(event.createdBy)) {
			send(403, { success: false, message: 'Select an event you created.' });
			return;
		}
		festivalModel.getParticipationsForEvent(event).then(records => {
			const participants = records.map(record => ({
				studentName: record.studentName, enrollmentNumber: record.enrollmentNumber,
				mobileNumber: record.mobileNumber, email: record.email,
				department: record.department, semester: record.semester, collegeName: record.collegeName
			}));
			send(200, { success: true, participants });
		}).catch(() => send(500, { success: false, message: 'Unable to load participants. Please try again.' }));
		return;
	}

	if (request.method === 'POST' && requestUrl.pathname === '/admin-dashboard/participation/import') {
		const send = (status, result) => {
			response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
			response.end(JSON.stringify(result));
		};
		if (!hasValidSession || !isSystemAdmin(sessionUser)) {
			send(403, { success: false, message: 'Only administrators can import participants.' });
			return;
		}
		if (!hasAllowedOrigin(request)) {
			send(403, { success: false, message: 'Upload the file from the admin dashboard.' });
			return;
		}
		readJsonBody(request, 3 * 1024 * 1024).then(async payload => {
			if (!payload || !Array.isArray(payload.rows) || !payload.rows.length || payload.rows.length > 10000 || payload.rows.some(row =>
				!row || !Number.isInteger(row.rowNumber) || row.rowNumber < 1 || typeof row.sheet !== 'string' || row.sheet.length > 100 ||
				!Array.isArray(row.identifiers) || row.identifiers.length > 3 || row.identifiers.some(value => typeof value !== 'string' || value.length > 100))) {
				send(400, { success: false, message: 'Upload up to 10,000 student rows with enrollment or mobile numbers.' });
				return;
			}
			await connectDB();
			if (mongoose.connection.readyState !== 1) {
				send(503, { success: false, message: 'The database is unavailable. Students were not added. Please try again.' });
				return;
			}
			const accounts = await userModel.listUsersForAdmin();
			const coordinatorIds = new Set(accounts.filter(account => account.role === 'event-coordinator').flatMap(account => [account.id, account.email]));
			const event = festivalModel.getFestivalById(String(payload.eventId || ''));
			if (!event || !event.createdBy || !coordinatorIds.has(event.createdBy)) {
				send(400, { success: false, message: 'Select an event scheduled by an event coordinator.' });
				return;
			}
			send(200, await importParticipants(event, payload.rows, accounts));
		}).catch(() => send(400, { success: false, message: 'Unable to import this list. Check the file and try again.' }));
		return;
	}

	if ((['POST', 'PATCH', 'DELETE'].includes(request.method) && requestUrl.pathname === '/admin-dashboard/users') || (request.method === 'POST' && requestUrl.pathname === '/admin-dashboard/approvals')) {
		const send = (status, result) => {
			response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
			response.end(JSON.stringify(result));
		};
		if (!hasValidSession || !isSystemAdmin(sessionUser)) {
			send(403, { success: false, message: 'Only administrators can manage users.' });
			return;
		}
		if (!hasAllowedOrigin(request)) {
			send(403, { success: false, message: 'Submit this form from the admin dashboard.' });
			return;
		}
		readJsonBody(request, 3 * 1024 * 1024).then(async (formData) => {
			if (!formData || typeof formData !== 'object' || Array.isArray(formData)) {
				send(400, { success: false, message: 'Invalid user data.' });
				return;
			}
			const action = requestUrl.pathname === '/admin-dashboard/approvals' ? userModel.setFacultyApproval : { POST: userModel.createManagedUser, PATCH: userModel.updateManagedUser, DELETE: userModel.deleteManagedAccount }[request.method];
			const result = await action(formData);
			send(result.success ? (request.method === 'POST' && requestUrl.pathname === '/admin-dashboard/users' ? 201 : 200) : result.status || 400, result);
		}).catch(() => send(400, { success: false, message: 'Invalid submission. Use a student picture under 2 MB.' }));
		return;
	}

	if (request.method === 'GET' && requestUrl.pathname === '/exceljs.min.js') {
		response.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
		response.end(fs.readFileSync(require.resolve('exceljs/dist/exceljs.min.js')));
		return;
	}

	if (request.method === 'GET' && ['/admin-users.js', '/admin-approvals.js', '/participation-excel.js', '/coordinator-participants.js'].includes(requestUrl.pathname)) {
		response.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
		response.end(fs.readFileSync(path.join(viewFolder, requestUrl.pathname.slice(1)), 'utf8'));
		return;
	}

	if (requestUrl.pathname === '/logout') {
		clearSessionCookie(response);
		const template = fs.readFileSync(path.join(viewFolder, 'auth.html'), 'utf8');
		const page = ejs.render(template, {
			authMode: 'login',
			message: 'You have been logged out successfully.',
			success: true,
			user: null,
			returnTo: ''
		});
		response.writeHead(200, { 'Content-Type': 'text/html' });
		response.end(page);
		return;
	}

	const normalizedPathname = requestUrl.pathname.replace(/\/+$/, '') || '/';
	const adminDashboardPage = getAdminDashboardPage(normalizedPathname);
	if (request.method === 'GET' && adminDashboardPage) {
		if (!hasValidSession) {
			response.writeHead(302, { Location: `/login?returnTo=${encodeURIComponent(normalizedPathname)}` });
			response.end();
			return;
		}

		if (!isSystemAdmin(sessionUser)) {
			sendPageError(response, 'default', 403, 'Only administrators can access the admin dashboard.');
			return;
		}

		renderAdminDashboard(response, sessionUser, adminDashboardPage, requestUrl.searchParams.get('eventId') || '').catch((error) => {
			console.error('Admin dashboard render failed:', error.message);
			sendPageError(response, 'dashboard', 500, 'The admin dashboard could not be loaded right now.');
		});
		return;
	}

	if (request.method === 'GET' && requestUrl.pathname === '/admin-dashboard-redirect.js') {
		response.writeHead(200, {
			'Content-Type': 'application/javascript; charset=utf-8',
			'Cache-Control': 'no-store'
		});
		response.end("window.location.replace(new URL('/admin-dashboard', document.currentScript.src).href);");
		return;
	}

	if (request.method === 'GET' && ['/event-coordinator/add-event', '/faculty/add-event'].includes(requestUrl.pathname)) {
		if (!hasValidSession) {
			response.writeHead(302, { Location: '/login' });
			response.end();
			return;
		}

		if (!isEventCoordinator(sessionUser)) {
			sendPageError(response, 'default', 403, 'Only event coordinators can add events.');
			return;
		}

		const template = fs.readFileSync(path.join(viewFolder, 'add-event.ejs'), 'utf8');
		const page = ejs.render(template, { user: sessionUser });
		response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
		response.end(page);
		return;
	}

	if (request.method === 'GET' && requestUrl.pathname === '/faculty/form-builder') {
		if (!hasValidSession) {
			response.writeHead(302, { Location: '/login' });
			response.end();
			return;
		}

		if (sessionUser.role !== 'faculty') {
			sendPageError(response, 'default', 403, 'Only faculty members can build student forms.');
			return;
		}

		const formId = requestUrl.searchParams.get('formId');
		const existingForm = formId
			? customForms.find((form) => form.id === formId && form.teacherId === (sessionUser.id || sessionUser.email))
			: null;
		if (formId && !existingForm) {
			sendPageError(response, 'default', 404, 'The form could not be found or you do not have permission to edit it.');
			return;
		}

		const template = fs.readFileSync(path.join(viewFolder, 'faculty-form-builder.ejs'), 'utf8');
		const page = ejs.render(template, { user: sessionUser, existingForm });
		response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
		response.end(page);
		return;
	}

	if (hasValidSession && requestUrl.pathname === '/') {
		const renderHomePage = isSystemAdmin(sessionUser)
			? renderAdminDashboard(response, sessionUser)
			: renderDashboard(response, sessionUser);
		renderHomePage.catch((error) => {
			console.error('Dashboard render failed:', error.message);
			sendPageError(response, 'dashboard', 500, 'The dashboard could not be loaded right now.');
		});
		return;
	}

	if (hasValidSession && (requestUrl.pathname === '/login' || requestUrl.pathname === '/register')) {
		response.writeHead(302, { Location: '/' });
		response.end();
		return;
	}

	if (request.method === 'GET' && requestUrl.pathname.startsWith('/festival/')) {
		try {
			const festivalId = decodeURIComponent(requestUrl.pathname.slice('/festival/'.length));
			const festival = festivalModel.getFestivalById(festivalId);

			if (!festival) {
				sendPageError(response, 'default', 404, 'The festival you are looking for could not be found.');
				return;
			}

			const festivalDetails = {
				...festival,
				description: festival.description || `Discover ${festival.name} in ${festival.location}, with local traditions, community gatherings, and a festive atmosphere. Check with local organizers for the latest schedule and visitor information.`
			};
			const template = fs.readFileSync(path.join(viewFolder, 'festival-detail.html'), 'utf8');
			const page = ejs.render(template, { festival: festivalDetails, user: hasValidSession ? sessionUser : null });
			response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
			response.end(page);
		} catch (error) {
			console.error(error.message);
			sendPageError(response, 'default', 500, 'Festival details could not be loaded right now.');
		}
		return;
	}

	const publicPageTemplates = {
		'/calendar': { template: 'calendar.html', data: (user) => ({ festivals: festivalModel.getFestivals(), user }) },
		'/destinations': { template: 'destinations.html', data: (user) => ({ user }) },
		'/about': { template: 'about.html', data: (user) => ({ user }) },
		'/explore': { template: 'explore.html', data: (user) => ({ festivals: festivalModel.getFestivals(), user }) },
		'/': { template: 'fest.html', data: (user) => ({ festivals: festivalModel.getFestivals(), festivalModel, user, authMode: 'login', returnTo: '', message: '', success: false, port }) },
		'/fest.html': { template: 'fest.html', data: (user) => ({ festivals: festivalModel.getFestivals(), festivalModel, user, authMode: 'login', returnTo: '', message: '', success: false, port }) },
		'/login': { template: 'auth.html', data: (user) => ({ festivals: festivalModel.getFestivals(), festivalModel, user, authMode: 'login', returnTo: '', message: '', success: false, port }) },
		'/register': { template: 'auth.html', data: (user) => ({ festivals: festivalModel.getFestivals(), festivalModel, user, authMode: 'register', returnTo: '', message: '', success: false, port }) }
	};

	if (requestUrl.pathname in publicPageTemplates || requestUrl.pathname === '/add-event' || requestUrl.pathname === '/edit-festival' || requestUrl.pathname === '/delete-festival' || requestUrl.pathname === '/delete-managed-user' || requestUrl.pathname === '/add-participation' || requestUrl.pathname === '/coordinator/add-participant' || requestUrl.pathname === '/save-custom-form' || requestUrl.pathname === '/edit-custom-form' || requestUrl.pathname === '/delete-custom-form' || requestUrl.pathname === '/set-student-form-visibility' || requestUrl.pathname === '/submit-custom-form') {
		try {
			if (request.method === 'POST' && requestUrl.pathname === '/register') {
				readFormData(request).then(async (formData) => {
					const email = normalizeEmail(formData.email);
					const result = await userModel.registerUser({ ...formData, email, name: formData.studentName || formData.teacherName });
					renderAuthPage(response, 'register', result.message, result.success);
				}).catch(() => {
					response.writeHead(400, { 'Content-Type': 'text/plain' });
					response.end('Invalid registration data.');
				});
				return;
			}

			if (request.method === 'POST' && requestUrl.pathname === '/login') {
				readFormData(request).then(async (formData) => {
					const isAdminTwoLogin = formData.role === 'admin-2.0';
					const identifier = ['admin', 'admin-2.0', 'event-coordinator'].includes(formData.role) ? formData.loginId : formData.email;
					const result = await userModel.loginUser(identifier, formData.password, formData.role);

					if (result.success) {
						if (isAdminTwoLogin && !isSystemAdmin(result.user)) {
							renderAuthPage(response, 'login', 'This account is not enabled for Admin 2.0.', false, '/admin-dashboard');
							return;
						}

						const useAdminDashboard = isSystemAdmin(result.user);
						setSessionCookie(response, result.user, useAdminDashboard);
						if (useAdminDashboard) {
							await renderAdminDashboard(response, result.user, getAdminDashboardPage(formData.returnTo) || 'overview');
						} else {
							await renderDashboard(response, result.user);
						}
						return;
					}

					renderAuthPage(response, 'login', result.message, false, isAdminTwoLogin || getAdminDashboardPage(formData.returnTo) ? formData.returnTo || '/admin-dashboard' : '');
				}).catch(() => {
					response.writeHead(400, { 'Content-Type': 'text/plain' });
					response.end('Invalid login data.');
				});
				return;
			}

			if (request.method === 'POST' && requestUrl.pathname === '/add-event') {
				if (!hasValidSession || !isEventCoordinator(sessionUser)) {
					response.writeHead(403, { 'Content-Type': 'application/json' });
					response.end(JSON.stringify({ success: false, message: 'Only logged-in event coordinators can add festival events.' }));
					return;
				}

				const parseBody = async () => {
					const contentType = request.headers['content-type'] || '';
					if (contentType.includes('application/json')) {
						return readJsonBody(request);
					}
					return readFormData(request);
				};

				parseBody().then(async (formData) => {
					const validationError = festivalModel.validateNewEvent(formData);
					if (validationError) {
						response.writeHead(400, { 'Content-Type': 'application/json' });
						response.end(JSON.stringify({ success: false, message: validationError }));
						return;
					}
					const result = await festivalModel.addFestival({ ...formData, createdBy: sessionUser.id || sessionUser.email, teacherId: sessionUser.id || sessionUser.email });
					response.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
					response.end(JSON.stringify(result));
				}).catch(() => {
					response.writeHead(400, { 'Content-Type': 'application/json' });
					response.end(JSON.stringify({ success: false, message: 'Invalid event data.' }));
				});
				return;
			}

			if (request.method === 'POST' && requestUrl.pathname === '/edit-festival') {
				if (!hasValidSession || !isEventCoordinator(sessionUser)) {
					response.writeHead(403, { 'Content-Type': 'application/json' });
					response.end(JSON.stringify({ success: false, message: 'Only logged-in event coordinators can edit festival events.' }));
					return;
				}

				readJsonBody(request).then(async (payload) => {
					const result = await festivalModel.editFestival(payload.festivalId, {
						...payload,
						createdBy: sessionUser.id || sessionUser.email,
						teacherId: sessionUser.id || sessionUser.email
					});
					response.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
					response.end(JSON.stringify(result));
				}).catch(() => {
					response.writeHead(400, { 'Content-Type': 'application/json' });
					response.end(JSON.stringify({ success: false, message: 'Invalid festival update data.' }));
				});
				return;
			}

			if (request.method === 'POST' && requestUrl.pathname === '/delete-festival') {
				if (!hasValidSession || (!isEventCoordinator(sessionUser) && sessionUser.role !== 'admin')) {
					response.writeHead(403, { 'Content-Type': 'application/json' });
					response.end(JSON.stringify({ success: false, message: 'Only event coordinators or admins can delete festival events.' }));
					return;
				}

				readJsonBody(request).then(async (payload) => {
					const result = await festivalModel.deleteFestival(payload.festivalId);
					response.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
					response.end(JSON.stringify(result));
				}).catch(() => {
					response.writeHead(400, { 'Content-Type': 'application/json' });
					response.end(JSON.stringify({ success: false, message: 'Invalid festival deletion data.' }));
				});
				return;
			}

			if (request.method === 'POST' && requestUrl.pathname === '/delete-managed-user') {
				if (!hasValidSession || !isSystemAdmin(sessionUser)) {
					response.writeHead(403, { 'Content-Type': 'application/json' });
					response.end(JSON.stringify({ success: false, message: 'Only administrators can delete user accounts.' }));
					return;
				}

				readJsonBody(request).then(async (payload) => {
					const userId = String(payload.userId || '').trim();
					const role = String(payload.role || '').trim().toLowerCase();
					if (!userId || !['student', 'faculty'].includes(role)) {
						response.writeHead(400, { 'Content-Type': 'application/json' });
						response.end(JSON.stringify({ success: false, message: 'Only student and faculty accounts can be deleted.' }));
						return;
					}

					const result = await userModel.deleteManagedUser(userId, role);
					if (!result.success) {
						response.writeHead(404, { 'Content-Type': 'application/json' });
						response.end(JSON.stringify(result));
						return;
					}

					const accountKeys = new Set([userId, result.user?.id, result.user?.email].filter(Boolean).map(String));
					if (role === 'faculty') {
						for (let index = customForms.length - 1; index >= 0; index -= 1) {
							if (accountKeys.has(String(customForms[index].teacherId))) customForms.splice(index, 1);
						}
					} else {
					for (let index = customFormSubmissions.length - 1; index >= 0; index -= 1) {
						if (accountKeys.has(String(customFormSubmissions[index].studentId))) customFormSubmissions.splice(index, 1);
						}
					}

					response.writeHead(200, { 'Content-Type': 'application/json' });
					response.end(JSON.stringify({ success: true, message: 'User account deleted.' }));
				}).catch(() => {
					response.writeHead(400, { 'Content-Type': 'application/json' });
					response.end(JSON.stringify({ success: false, message: 'Invalid account deletion data.' }));
				});
				return;
			}

			if (request.method === 'POST' && requestUrl.pathname === '/coordinator/add-participant') {
				if (!hasValidSession || !isEventCoordinator(sessionUser)) {
					response.writeHead(403, { 'Content-Type': 'application/json' });
					response.end(JSON.stringify({ success: false, message: 'Only event coordinators can add participants.' }));
					return;
				}
				readFormData(request).then(async (formData) => {
					const event = festivalModel.getFestivalById(String(formData.eventId || '').trim());
					if (!event || !event.createdBy || ![sessionUser.id, sessionUser.email].filter(Boolean).includes(event.createdBy)) {
						response.writeHead(403, { 'Content-Type': 'application/json' });
						response.end(JSON.stringify({ success: false, message: 'Select an event you created.' }));
						return;
					}
					const identifier = String(formData.studentIdentifier || '').trim();
					if (!identifier || identifier.length > 100) {
						response.writeHead(400, { 'Content-Type': 'application/json' });
						response.end(JSON.stringify({ success: false, message: 'Enter a valid enrollment number or mobile number.' }));
						return;
					}
					const student = await userModel.findStudentForParticipation(identifier);
					if (!student) {
						response.writeHead(404, { 'Content-Type': 'application/json' });
						response.end(JSON.stringify({ success: false, message: 'No registered student matches that enrollment or mobile number.' }));
						return;
					}
					if (!(student.name || student.studentName) || !student.department || !student.semester || !student.collegeName) {
						response.writeHead(400, { 'Content-Type': 'application/json' });
						response.end(JSON.stringify({ success: false, message: 'The student profile needs name, department, semester, and college details before they can be added.' }));
						return;
					}
					const existing = await festivalModel.getParticipationsForEvent(event);
					if (existing.some(record => record.studentId === student.id)) {
						response.writeHead(409, { 'Content-Type': 'application/json' });
						response.end(JSON.stringify({ success: false, message: 'This student is already registered for the event.' }));
						return;
					}
					const result = await festivalModel.addParticipation({
						eventId: event.id, studentId: student.id, studentName: student.name || student.studentName,
						department: student.department, semester: student.semester, collegeName: student.collegeName,
						email: student.email, mobileNumber: student.mobileNumber,
						enrollmentNumber: student.enrollmentNumber, gender: student.gender, allowMissingFieldOfInterest: true
					});
					response.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
					response.end(JSON.stringify(result));
				}).catch((error) => {
					response.writeHead(400, { 'Content-Type': 'application/json' });
					response.end(JSON.stringify({ success: false, message: error.code === 'AMBIGUOUS_STUDENT' ? error.message : 'Unable to add the participant. Please try again.' }));
				});
				return;
			}

			if (request.method === 'POST' && requestUrl.pathname === '/add-participation') {
				if (!hasValidSession || sessionUser.role !== 'student') {
					response.writeHead(403, { 'Content-Type': 'application/json' });
					response.end(JSON.stringify({ success: false, message: 'Only logged-in students can participate in events.' }));
					return;
				}

				readFormData(request).then(async (formData) => {
					const accounts = await userModel.listUsersForAdmin();
					const profile = accounts.find(account => account.role === 'student' && [account.id, account.email].includes(sessionUser.id || sessionUser.email));
					const result = await festivalModel.addParticipation({
						...formData,
						allowMissingFieldOfInterest: false,
						studentId: profile?.id || sessionUser.id || sessionUser.email,
						email: profile?.email || sessionUser.email || '',
						mobileNumber: profile?.mobileNumber || '',
						enrollmentNumber: profile?.enrollmentNumber || '',
						gender: profile?.gender || ''
					});
					response.writeHead(200, { 'Content-Type': 'application/json' });
					response.end(JSON.stringify(result));
				}).catch(() => {
					response.writeHead(400, { 'Content-Type': 'application/json' });
					response.end(JSON.stringify({ success: false, message: 'Invalid participation data.' }));
				});
				return;
			}

			if (request.method === 'POST' && requestUrl.pathname === '/save-custom-form') {
				if (!hasValidSession || sessionUser.role !== 'faculty') {
					response.writeHead(403, { 'Content-Type': 'application/json' });
					response.end(JSON.stringify({ success: false, message: 'Only logged-in teachers can save forms.' }));
					return;
				}

				readJsonBody(request).then((formData) => {
					const title = String(formData.title || '').trim();
					const autoGrade = formData.autoGrade === true;
					const normalizedQuestions = normalizeCustomFormQuestions(formData.questions, autoGrade);
					if (!title || normalizedQuestions.error) {
						response.writeHead(400, { 'Content-Type': 'application/json' });
						response.end(JSON.stringify({ success: false, message: normalizedQuestions.error || 'A form title is required.' }));
						return;
					}
					const questions = normalizedQuestions.questions;

					const startAt = new Date(formData.startAt);
					const endAt = new Date(formData.endAt);
					if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
						response.writeHead(400, { 'Content-Type': 'application/json' });
						response.end(JSON.stringify({ success: false, message: 'Valid starting and ending times are required.' }));
						return;
					}
					if (endAt <= startAt) {
						response.writeHead(400, { 'Content-Type': 'application/json' });
						response.end(JSON.stringify({ success: false, message: 'Ending time must be after starting time.' }));
						return;
					}

					const teacherId = sessionUser.id || sessionUser.email;
					const savedForm = { id: `${Date.now()}-${teacherId}`, teacherId, title, description: String(formData.description || '').trim(), startAt: startAt.toISOString(), endAt: endAt.toISOString(), visibleToStudents: formData.visibleToStudents === true, autoGrade, questions, createdAt: new Date().toISOString() };
					customForms.unshift(savedForm);
					response.writeHead(200, { 'Content-Type': 'application/json' });
					response.end(JSON.stringify({ success: true, form: savedForm }));
				}).catch(() => {
					response.writeHead(400, { 'Content-Type': 'application/json' });
					response.end(JSON.stringify({ success: false, message: 'Invalid form data.' }));
				});
				return;
			}

			if (request.method === 'POST' && requestUrl.pathname === '/edit-custom-form') {
				if (!hasValidSession || sessionUser.role !== 'faculty') {
					response.writeHead(403, { 'Content-Type': 'application/json' });
					response.end(JSON.stringify({ success: false, message: 'Only logged-in teachers can edit forms.' }));
					return;
				}

				readJsonBody(request).then((formData) => {
					const formId = String(formData.formId || '').trim();
					const formIndex = customForms.findIndex((savedForm) => savedForm.id === formId && (savedForm.teacherId === (sessionUser.id || sessionUser.email)));
					if (formIndex === -1) {
						response.writeHead(404, { 'Content-Type': 'application/json' });
						response.end(JSON.stringify({ success: false, message: 'Form not found or you do not have permission to edit it.' }));
						return;
					}

					const title = String(formData.title || '').trim();
					const autoGrade = formData.autoGrade === true;
					const normalizedQuestions = normalizeCustomFormQuestions(formData.questions, autoGrade);
					if (!title || normalizedQuestions.error) {
						response.writeHead(400, { 'Content-Type': 'application/json' });
						response.end(JSON.stringify({ success: false, message: normalizedQuestions.error || 'A form title is required.' }));
						return;
					}
					const questions = normalizedQuestions.questions;

					const startAt = new Date(formData.startAt);
					const endAt = new Date(formData.endAt);
					if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
						response.writeHead(400, { 'Content-Type': 'application/json' });
						response.end(JSON.stringify({ success: false, message: 'Valid starting and ending times are required.' }));
						return;
					}
					if (endAt <= startAt) {
						response.writeHead(400, { 'Content-Type': 'application/json' });
						response.end(JSON.stringify({ success: false, message: 'Ending time must be after starting time.' }));
						return;
					}

					const updatedForm = {
						...customForms[formIndex],
						title,
						description: String(formData.description || '').trim(),
						startAt: startAt.toISOString(),
						endAt: endAt.toISOString(),
						visibleToStudents: formData.visibleToStudents === true,
						autoGrade,
						questions,
						updatedAt: new Date().toISOString()
					};
					customForms[formIndex] = updatedForm;
					response.writeHead(200, { 'Content-Type': 'application/json' });
					response.end(JSON.stringify({ success: true, form: updatedForm }));
				}).catch(() => {
					response.writeHead(400, { 'Content-Type': 'application/json' });
					response.end(JSON.stringify({ success: false, message: 'Invalid form update data.' }));
				});
				return;
			}

			if (request.method === 'POST' && requestUrl.pathname === '/set-student-form-visibility') {
				if (!hasValidSession || sessionUser.role !== 'faculty') {
					response.writeHead(403, { 'Content-Type': 'application/json' });
					response.end(JSON.stringify({ success: false, message: 'Only faculty members can change student dashboard form visibility.' }));
					return;
				}

				readJsonBody(request).then((payload) => {
					const formId = String(payload.formId || '').trim();
					const form = customForms.find((savedForm) => savedForm.id === formId && savedForm.teacherId === (sessionUser.id || sessionUser.email));
					if (!form) {
						response.writeHead(404, { 'Content-Type': 'application/json' });
						response.end(JSON.stringify({ success: false, message: 'Form not found or you do not have permission to update it.' }));
						return;
					}

					form.visibleToStudents = payload.visibleToStudents === true;
					form.updatedAt = new Date().toISOString();
					response.writeHead(200, { 'Content-Type': 'application/json' });
					response.end(JSON.stringify({ success: true, message: form.visibleToStudents ? 'Form published to the student dashboard.' : 'Form hidden from the student dashboard.' }));
				}).catch(() => {
					response.writeHead(400, { 'Content-Type': 'application/json' });
					response.end(JSON.stringify({ success: false, message: 'Invalid form update data.' }));
				});
				return;
			}

			if (request.method === 'POST' && requestUrl.pathname === '/delete-custom-form') {
				if (!hasValidSession || sessionUser.role !== 'faculty') {
					response.writeHead(403, { 'Content-Type': 'application/json' });
					response.end(JSON.stringify({ success: false, message: 'Only logged-in teachers can delete forms.' }));
					return;
				}

				readJsonBody(request).then((payload) => {
					const formId = String(payload.formId || '').trim();
					const beforeLength = customForms.length;
					for (let index = customForms.length - 1; index >= 0; index -= 1) {
						const savedForm = customForms[index];
						if (savedForm.id === formId && savedForm.teacherId === (sessionUser.id || sessionUser.email)) {
							customForms.splice(index, 1);
							break;
						}
					}

					if (customForms.length === beforeLength) {
						response.writeHead(404, { 'Content-Type': 'application/json' });
						response.end(JSON.stringify({ success: false, message: 'Form not found or you do not have permission to delete it.' }));
						return;
					}

					response.writeHead(200, { 'Content-Type': 'application/json' });
					response.end(JSON.stringify({ success: true, message: 'Form deleted successfully.' }));
				}).catch(() => {
					response.writeHead(400, { 'Content-Type': 'application/json' });
					response.end(JSON.stringify({ success: false, message: 'Invalid form deletion data.' }));
				});
				return;
			}

			if (request.method === 'POST' && requestUrl.pathname === '/submit-custom-form') {
				if (!hasValidSession || sessionUser.role !== 'student') {
					response.writeHead(403, { 'Content-Type': 'application/json' });
					response.end(JSON.stringify({ success: false, message: 'Only logged-in students can submit forms.' }));
					return;
				}

				readJsonBody(request).then((submission) => {
					const form = customForms.find((savedForm) => savedForm.id === String(submission.formId || ''));
					const studentName = String(submission.studentName || '').trim();
					const semester = String(submission.semester || '').trim();
					const answers = Array.isArray(submission.answers) ? submission.answers : [];
					const now = Date.now();
					if (!studentName || !semester) {
						response.writeHead(400, { 'Content-Type': 'application/json' });
						response.end(JSON.stringify({ success: false, message: 'Student name and semester are required.' }));
						return;
					}
					const isActive = form && form.visibleToStudents && now >= new Date(form.startAt).getTime() && now < new Date(form.endAt).getTime();
					const studentId = sessionUser.id || sessionUser.email;
					const lastSubmission = form ? getLastCustomFormSubmission(form.id, studentId) : null;
					if (!isActive || (lastSubmission && now - lastSubmission.submittedAt < formResubmissionDelay)) {
						response.writeHead(400, { 'Content-Type': 'application/json' });
						response.end(JSON.stringify({ success: false, message: 'This form is not available for submission yet.' }));
						return;
					}

					if (answers.length !== form.questions.length) {
						response.writeHead(400, { 'Content-Type': 'application/json' });
						response.end(JSON.stringify({ success: false, message: 'Please answer all form questions before submitting.' }));
						return;
					}

					const normalizedAnswers = answers.map((answer, index) => {
						const question = form.questions[index];
						const values = Array.isArray(answer) ? answer.map(String) : [String(answer || '')];
						if (question.required && !values.some((value) => value.trim())) {
							return null;
						}
						if (['multiple-choice', 'checkboxes'].includes(question.type) && values.some((value) => value && !question.options.includes(value))) {
							return null;
						}
						if (question.type === 'multiple-choice' && values.filter(Boolean).length > 1) {
							return null;
						}
						return question.type === 'checkboxes' ? values.filter(Boolean) : (values[0] || '');
					});
					if (normalizedAnswers.some((answer) => answer === null)) {
						response.writeHead(400, { 'Content-Type': 'application/json' });
						response.end(JSON.stringify({ success: false, message: 'One or more answers are missing or invalid.' }));
						return;
					}

					const grading = getSubmissionReview(form, normalizedAnswers);
					const savedSubmission = {
						formId: form.id,
						formTitle: form.title,
						studentId,
						studentName,
						semester,
						answers: normalizedAnswers,
						score: grading.score,
						total: grading.total,
						review: grading.review,
						submittedAt: now
					};
					customFormSubmissions.push(savedSubmission);
					response.writeHead(200, { 'Content-Type': 'application/json' });
					response.end(JSON.stringify({
						success: true,
						message: 'Form submitted successfully.',
						score: savedSubmission.score,
						total: savedSubmission.total
					}));
				}).catch(() => {
					response.writeHead(400, { 'Content-Type': 'application/json' });
					response.end(JSON.stringify({ success: false, message: 'Invalid form submission.' }));
				});
				return;
			}

			const pageMeta = publicPageTemplates[requestUrl.pathname];
			if (!pageMeta) {
				response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
				response.end('Page not found.');
				return;
			}

			const template = fs.readFileSync(path.join(viewFolder, pageMeta.template), 'utf8');
			const page = ejs.render(template, pageMeta.data(hasValidSession ? sessionUser : null));
			response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
			response.end(page);
		} catch (error) {
			console.error(error.message);
			sendPageError(response, requestUrl.pathname === '/' ? 'dashboard' : requestUrl.pathname.replace('/', '') || 'default', 500, 'The page could not be loaded. Please refresh and try again.');
		}
		return;
	}

	const staticAssetMap = {
		'/fest.css': ['fest.css', 'text/css'],
		'/festival-detail.css': ['festival-detail.css', 'text/css'],
		'/responsive-images.css': ['responsive-images.css', 'text/css'],
		'/admin-dashboard.css': ['admin-dashboard.css', 'text/css'],
		'/AdminDash.css': ['admin-dashboard.css', 'text/css'],
		'/explore.css': ['explore.css', 'text/css'],
		'/about.css': ['about.css', 'text/css'],
		'/destinations.css': ['destinations.css', 'text/css'],
		'/calendar.css': ['calendar.css', 'text/css'],
		'/robots.txt': ['robots.txt', 'text/plain; charset=utf-8'],
		'/sitemap.xml': ['sitemap.xml', 'application/xml; charset=utf-8'],
		'/image.png': ['image.png', 'image/png', null]
	};
	const staticAsset = staticAssetMap[request.url];
	if (staticAsset) {
		const [fileName, contentType, encoding] = staticAsset;
		response.writeHead(200, { 'Content-Type': contentType });
		response.end(getCachedStaticAsset(fileName, encoding));
		return;
	}

	if (['/forgot-password', '/verify-password-otp', '/update-password'].includes(request.url) && request.method === 'POST') {
        void (async () => {
            try {
                const data = await readJsonBody(request, 4096);
                const result = request.url === '/forgot-password'
                    ? await passwordResetService.request(data, request.socket.remoteAddress)
                    : request.url === '/verify-password-otp'
                        ? passwordResetService.verify(data)
                        : await passwordResetService.reset(data);
                response.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
                response.end(JSON.stringify(result));
            } catch (error) {
                console.error('Password reset request failed:', error.message);
                response.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
                response.end(JSON.stringify({ success: false, message: 'Unable to process password reset. Please try again later.' }));
            }
        })();
        return;
    }

	const whatsappLoginMatch = request.url.match(/^\/whatsapp-login\?token=([^&]+)/);
	if (whatsappLoginMatch && request.method === 'GET') {
		const token = decodeURIComponent(whatsappLoginMatch[1]);
		const loginRequest = whatsappLoginTokens.get(token);
		if (!loginRequest || loginRequest.expiresAt < Date.now()) {
			response.writeHead(400, { 'Content-Type': 'text/plain' });
			response.end('This WhatsApp login link is invalid or has expired.');
			return;
		}

		whatsappLoginTokens.delete(token);
		userModel.findUserByEmail(loginRequest.email, loginRequest.role).then((user) => {
			if (!user) {
				response.writeHead(401, { 'Content-Type': 'text/plain' });
				response.end('Unable to find the user linked to this WhatsApp login request.');
				return;
			}

			if (userModel.isFacultyApprovalPending(user)) {
				renderAuthPage(response, 'login', 'Approval Pending From Admin', false);
				return;
			}

			setSessionCookie(response, user);
			response.writeHead(302, { Location: '/' });
			response.end();
		}).catch(() => {
			response.writeHead(500, { 'Content-Type': 'text/plain' });
			response.end('Something went wrong while completing WhatsApp login.');
		});
		return;
	}

	sendPageError(response, 'default', 404, 'The page you are looking for does not exist or is currently unavailable.');
}

function startServer(portToUse) {
	const currentServer = http.createServer(handleRequest);
	currentServer.maxConnections = serverLimits.maxConcurrentRequests;
	currentServer.keepAliveTimeout = 65 * 1000;
	currentServer.headersTimeout = 30 * 1000;
	currentServer.requestTimeout = serverLimits.requestTimeoutMs;
	currentServer.timeout = serverLimits.requestTimeoutMs;

	currentServer.on('connection', (socket) => {
		socket.setNoDelay(true);
	});

	currentServer.on('error', (error) => {
		if (error.code === 'EADDRINUSE') {
			const nextPort = portToUse + 1;
			console.warn(`Port ${portToUse} is busy. Retrying on ${nextPort}...`);
			currentServer.close(() => startServer(nextPort));
			return;
		}

		console.error('Server error:', error);
		process.exit(1);
	});

	currentServer.listen(portToUse, () => {
		console.log(`Server started: http://localhost:${portToUse}`);
	});
}

if (require.main === module) {
	connectDB()
		.then(() => userModel.initializeUserCollections())
		.then(() => initMailgun())
		.then(() => festivalModel.loadFestivals())
		.then(async () => {
			if (mongoose.connection.readyState === 1) {
				const report = await festivalModel.migrateParticipationRelationships(await userModel.listUsersForAdmin());
				console.log('Participation relationships:', report);
			}
		})
		.then(() => startServer(port))
		.catch((error) => {
			console.error('Startup database initialization failed:', error.message);
			startServer(port);
		});
}

module.exports = {
	createOtp,
	getSmtpConfig,
	startServer,
	sendOtpEmail,
	normalizeEmail,
	handleRequest,
	normalizeCustomFormQuestions,
	getSubmissionReview,
	sanitizeCustomFormForStudent,
	getStudentFormsForDashboard
};
