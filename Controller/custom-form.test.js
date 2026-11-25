const assert = require('node:assert/strict');
const test = require('node:test');
const {
	getSubmissionReview,
	getStudentFormsForDashboard,
	normalizeCustomFormQuestions,
	sanitizeCustomFormForStudent
} = require('./server');

test('auto-scored quizzes require valid answer keys and choice questions', () => {
	const validQuiz = normalizeCustomFormQuestions([
		{ label: 'Capital?', type: 'multiple-choice', options: ['Delhi', 'Mumbai'], correctAnswers: 'Delhi' },
		{ label: 'Colors?', type: 'checkboxes', options: ['Red', 'Blue', 'Green'], correctAnswers: ['Red', 'Blue'] }
	], true);

	assert.equal(validQuiz.error, undefined);
	assert.deepEqual(validQuiz.questions[0].correctAnswers, ['Delhi']);
	assert.deepEqual(validQuiz.questions[1].correctAnswers, ['Red', 'Blue']);

	assert.match(
		normalizeCustomFormQuestions([{ label: 'Capital?', type: 'multiple-choice', options: ['Delhi', 'Mumbai'] }], true).error,
		/correct answer/
	);
	assert.match(
		normalizeCustomFormQuestions([{ label: 'Explain this', type: 'paragraph' }], true).error,
		/cannot contain paragraph/
	);
	assert.deepEqual(
		normalizeCustomFormQuestions([{ label: 'Capital?', type: 'short-answer', correctAnswers: ['Delhi'] }], true).questions[0].correctAnswers,
		['Delhi']
	);
	const regularFormWithAnswer = normalizeCustomFormQuestions([
		{ label: 'Capital?', type: 'short-answer', teacherAnswer: 'Delhi' }
	], false);
	assert.equal(regularFormWithAnswer.error, undefined);
	assert.equal(regularFormWithAnswer.questions[0].teacherAnswer, 'Delhi');
	assert.match(
		normalizeCustomFormQuestions([{ label: 'Capital?', type: 'short-answer' }], true).error,
		/Enter the correct answer/
	);
	assert.match(
		normalizeCustomFormQuestions([{ label: 'Pick one', type: 'multiple-choice', options: ['A', 'A'], correctAnswers: 'A' }], true).error,
		/unique answer options/
	);
});

test('quiz grading checks exact answers and builds a post-submit answer review', () => {
	const quiz = {
		autoGrade: true,
		questions: [
			{ label: 'Capital?', type: 'multiple-choice', correctAnswers: ['Delhi'] },
			{ label: 'Select both', type: 'checkboxes', correctAnswers: ['Red', 'Blue'] },
			{ label: 'Spell it', type: 'short-answer', correctAnswers: ['UtsavFest'] }
		]
	};

	assert.deepEqual(getSubmissionReview(quiz, ['Delhi', ['Blue', 'Red'], 'utsavfest']), {
		score: 3,
		total: 3,
		review: [
			{ question: 'Capital?', answer: 'Delhi', correctAnswer: 'Delhi', isCorrect: true },
			{ question: 'Select both', answer: ['Blue', 'Red'], correctAnswer: ['Red', 'Blue'], isCorrect: true },
			{ question: 'Spell it', answer: 'utsavfest', correctAnswer: 'UtsavFest', isCorrect: true }
		]
	});
	assert.equal(getSubmissionReview(quiz, ['Mumbai', ['Red'], 'Utsav Fest']).score, 0);
	assert.deepEqual(getSubmissionReview({ autoGrade: false, questions: [] }, []), {
		score: null,
		total: null,
		review: null
	});
});

test('separate teacher answer is graded and available for post-submit review without quiz mode', () => {
	const form = {
		autoGrade: false,
		questions: [
			{ label: 'What is 2 + 2?', type: 'short-answer', teacherAnswer: '4' },
			{ label: 'Your thoughts?', type: 'paragraph' }
		]
	};

	assert.deepEqual(getSubmissionReview(form, ['4', 'Some thoughts']), {
		score: 1,
		total: 1,
		review: [{ question: 'What is 2 + 2?', answer: '4', correctAnswer: '4', isCorrect: true }]
	});
});

test('student form data never includes correct answers before submission', () => {
	const savedForm = {
		id: 'quiz-1',
		autoGrade: true,
		questions: [{ label: 'Capital?', type: 'short-answer', teacherAnswer: 'Delhi', correctAnswers: ['Delhi'] }]
	};

	assert.deepEqual(sanitizeCustomFormForStudent(savedForm), {
		id: 'quiz-1',
		autoGrade: true,
		questions: [{ label: 'Capital?', type: 'short-answer' }]
	});
	assert.deepEqual(savedForm.questions[0].correctAnswers, ['Delhi']);
});

test('published upcoming exams are listed, private and expired exams are hidden', () => {
	const now = Date.now();
	const forms = [
		{ id: 'upcoming', visibleToStudents: true, startAt: new Date(now + 60_000).toISOString(), endAt: new Date(now + 3_600_000).toISOString(), questions: [] },
		{ id: 'private', visibleToStudents: false, startAt: new Date(now - 60_000).toISOString(), endAt: new Date(now + 3_600_000).toISOString(), questions: [] },
		{ id: 'expired', visibleToStudents: true, startAt: new Date(now - 3_600_000).toISOString(), endAt: new Date(now - 60_000).toISOString(), questions: [] }
	];

	assert.deepEqual(getStudentFormsForDashboard(forms, [], 'student-1', now).map((form) => form.id), ['upcoming']);
});

test('student can retry a published exam after the existing resubmission delay', () => {
	const now = Date.now();
	const forms = [{
		id: 'exam-1',
		visibleToStudents: true,
		startAt: new Date(now - 3_600_000).toISOString(),
		endAt: new Date(now + 3_600_000).toISOString(),
		questions: []
	}];

	assert.deepEqual(getStudentFormsForDashboard(forms, [
		{ formId: 'exam-1', studentId: 'student-1', submittedAt: now - 60_000 }
	], 'student-1', now), []);
	assert.equal(getStudentFormsForDashboard(forms, [
		{ formId: 'exam-1', studentId: 'student-1', submittedAt: now - (25 * 60 * 60 * 1000) }
	], 'student-1', now).length, 1);
});
