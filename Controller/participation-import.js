const events = require('../Model/festivalModel1');
const { studentLookupKeys } = require('../Model/userModel');

async function importParticipants(event, rows, accounts) {
    const enrollmentIndex = new Map();
    const mobileIndex = new Map();
    function index(map, key, student) {
        if (!key) return;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(student);
    }
    accounts.filter(account => account.role === 'student').forEach(student => {
        index(enrollmentIndex, String(student.enrollmentNumber || '').trim().toUpperCase(), student);
        index(mobileIndex, String(student.mobileNumber || '').replace(/\D/g, ''), student);
    });
    const registered = new Set((await events.getParticipationsForEvent(event)).map(record => record.studentId));
    const results = [];
    const summary = { total: rows.length, added: 0, alreadyRegistered: 0, unmatched: 0, ambiguous: 0, incomplete: 0, failed: 0 };
    for (const row of rows) {
        const found = new Map();
        row.identifiers.forEach(identifier => {
            const keys = studentLookupKeys(identifier);
            const matches = [
                ...(enrollmentIndex.get(keys.enrollmentNumber) || []),
                ...keys.mobileNumbers.flatMap(number => mobileIndex.get(number) || [])
            ];
            matches.forEach(student => found.set(student.id, student));
        });
        const result = { rowNumber: row.rowNumber, sheet: row.sheet || '', identifiers: row.identifiers };
        if (!found.size) {
            result.status = 'unmatched';
            result.message = row.identifiers.length ? 'No matching registered student.' : 'No enrollment or mobile number in this row.';
        } else if (found.size > 1) {
            result.status = 'ambiguous';
            result.message = 'Identifiers match different students. Correct this row and upload again.';
        } else {
            const student = [...found.values()][0];
            Object.assign(result, {
                studentName: student.name, enrollmentNumber: student.enrollmentNumber,
                mobileNumber: student.mobileNumber, email: student.email,
                department: student.department, semester: student.semester, collegeName: student.collegeName
            });
            if (registered.has(student.id)) {
                result.status = 'alreadyRegistered';
                result.message = 'Already registered; skipped to avoid a duplicate.';
            } else if (!student.name || !student.department || !student.semester || !student.collegeName) {
                result.status = 'incomplete';
                result.message = 'Student profile needs name, department, semester, and college.';
            } else {
                const saved = await events.addParticipation({
                    eventId: event.id, studentId: student.id, studentName: student.name,
                    department: student.department, semester: student.semester, collegeName: student.collegeName,
                    email: student.email, mobileNumber: student.mobileNumber,
                    enrollmentNumber: student.enrollmentNumber, gender: student.gender,
                    allowMissingFieldOfInterest: true, requireDatabase: true
                });
                result.status = saved.success ? 'added' : 'failed';
                result.message = saved.success ? 'Added to the selected event.' : saved.message;
                if (saved.success) registered.add(student.id);
            }
        }
        summary[result.status]++;
        results.push(result);
    }
    return { success: true, summary, results };
}

module.exports = { importParticipants };
