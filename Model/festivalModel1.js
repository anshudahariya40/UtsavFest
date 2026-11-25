const { v4: uuidv4 } = require('uuid');
const { connectDB, mongoose, isConnected } = require('./db');

const fallbackFestivals = [
    {
        date: '2026-01-12',
        name: 'Pongal Festival',
        location: 'Madurai, India',
        image: 'https://images.unsplash.com/photo-1543353071-873f17a7a088?auto=format&fit=crop&w=800&q=80',
        description: 'Pongal is a harvest celebration centered on gratitude for the season, freshly gathered rice, and the people who bring the harvest to life. In Madurai, visitors can discover Tamil traditions, festive food, decorated homes, and community gatherings.'
    },
    {
        date: '2026-02-09',
        name: 'Rio Carnival',
        location: 'Rio de Janeiro, Brazil',
        image: 'https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?auto=format&fit=crop&w=800&q=80',
        description: 'Rio Carnival fills the city with samba, elaborate costumes, street celebrations, and music. The festival brings together neighborhood blocos and major parade performances for a vivid expression of Brazilian culture.'
    },
    {
        date: '2026-03-25',
        name: 'Holi Festival of Colors',
        location: 'Mathura, India',
        image: 'https://images.unsplash.com/photo-1521323384235-90033100db2c?auto=format&fit=crop&w=800&q=80',
        description: 'Holi welcomes spring with color, music, sweets, and gatherings among family and friends. Mathura is closely associated with Krishna traditions, making the festival especially meaningful across the surrounding region.'
    },
    {
        date: '2026-04-14',
        name: 'Baisakhi Celebration',
        location: 'Amritsar, India',
        image: 'https://images.unsplash.com/photo-1529156069898-49953e39b3ac?auto=format&fit=crop&w=800&q=80',
        description: 'Baisakhi marks the harvest season in Punjab and is also an important day in Sikh history. Amritsar celebrates with prayers, music, traditional food, and community events.'
    },
    {
        date: '2026-05-18',
        name: 'Spring Street Fair',
        location: 'Barcelona, Spain',
        image: 'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=800&q=80',
        description: 'Spring Street Fair brings the neighborhood together around local makers, food stalls, live performances, and open-air displays. It is a relaxed way to explore Barcelona through its community and creative scene.'
    },
    {
        date: '2026-06-08',
        name: 'Sunset Music Weekend',
        location: 'Lisbon, Portugal',
        image: 'https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?auto=format&fit=crop&w=800&q=80',
        description: 'Sunset Music Weekend pairs live performances with the long evening light of Lisbon. Expect a welcoming mix of music, food, and open-air gathering in a coastal city known for its creative energy.'
    },
    {
        date: '2026-07-16',
        name: 'Monsoon Night Festival',
        location: 'Bangkok, Thailand',
        image: 'https://images.unsplash.com/photo-1501386761578-eac5c94b800a?auto=format&fit=crop&w=800&q=80',
        description: 'Monsoon Night Festival celebrates Bangkok after dark with live music, street food, and colorful community performances. The evening setting gives visitors a lively way to experience the city during the rainy season.'
    },
    {
        date: '2026-08-15',
        name: 'Independence Day Parade',
        location: 'New Delhi, India',
        image: 'https://images.unsplash.com/photo-1531058020387-3be344556be6?auto=format&fit=crop&w=800&q=80',
        description: 'India’s Independence Day is observed with national flags, public ceremonies, music, and cultural performances. New Delhi hosts the country’s central commemorations alongside celebrations throughout the city.'
    },
    {
        date: '2026-09-12',
        name: 'Ganesh Chaturthi',
        location: 'Mumbai, India',
        image: 'https://images.unsplash.com/photo-1579546929518-9e396f3cc809?auto=format&fit=crop&w=800&q=80',
        description: 'Ganesh Chaturthi honors Lord Ganesha with decorated community pandals, devotional music, shared meals, and processions. Mumbai is known for its large neighborhood celebrations and welcoming festive atmosphere.'
    },
    {
        date: '2026-10-31',
        name: 'Dia de los Muertos',
        location: 'Mexico City, Mexico',
        image: 'https://images.unsplash.com/photo-1533174000243-c782be17e13e?auto=format&fit=crop&w=800&q=80',
        description: 'Dia de los Muertos is a Mexican tradition of remembering loved ones through family gatherings, colorful ofrendas, flowers, candles, and favorite foods. Mexico City brings together neighborhood traditions, art, and public celebrations.'
    },
    {
        date: '2026-11-12',
        name: 'Diwali Festival',
        location: 'Mumbai, India',
        image: 'https://images.unsplash.com/photo-1563841930606-67e2bce48b78?auto=format&fit=crop&w=800&q=80',
        description: 'Diwali, the festival of lights, is celebrated with lamps, decorations, sweets, family visits, and the triumph of light over darkness. Mumbai’s homes and neighborhoods take on a festive glow throughout the celebration.'
    },
    {
        date: '2026-12-25',
        name: 'Christmas Market Night',
        location: 'Prague, Czech Republic',
        image: 'https://images.unsplash.com/photo-1512389142861-9c449c8f5f8c?auto=format&fit=crop&w=800&q=80',
        description: 'Prague’s Christmas Market Night brings seasonal food, handmade gifts, music, and illuminated stalls to the city. Visitors can explore local crafts and winter treats in a festive historic setting.'
    }
];

function normalizeFestivalDate(dateString) {
    if (!dateString) return null;

    const trimmedDate = String(dateString).trim();
    if (!trimmedDate) return null;

    const isoMatch = /^\d{4}-\d{2}-\d{2}$/.exec(trimmedDate);
    if (isoMatch) {
        const [year, month, day] = trimmedDate.split('-').map(Number);
        if (Number.isInteger(year) && Number.isInteger(month) && Number.isInteger(day)) {
            return { year, month: month - 1, day };
        }
    }

    const date = new Date(trimmedDate);
    if (Number.isNaN(date.getTime())) {
        return null;
    }

    return { year: date.getFullYear(), month: date.getMonth(), day: date.getDate() };
}

function formatFestivalDate(dateString) {
    if (!dateString) {
        return 'TBA';
    }

    const normalized = normalizeFestivalDate(dateString);
    if (!normalized) {
        return String(dateString);
    }

    return new Date(normalized.year, normalized.month, normalized.day).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

let festivals = [...fallbackFestivals];

const festivalSchema = new mongoose.Schema({
    id: { type: String, unique: true, sparse: true },
    date: String,
    dateISO: String,
    name: String,
    festName: String,
    time: String,
    chiefGuest: String,
    notification: String,
    location: String,
    image: String,
    description: String,
    createdBy: String,
    updatedAt: Date,
    createdAt: { type: Date, default: Date.now }
}, { timestamps: true });

const participationSchema = new mongoose.Schema({
    eventId: { type: String, required: true, trim: true },
    studentId: { type: String, required: true, trim: true },
    email: String,
    mobileNumber: String,
    enrollmentNumber: String,
    gender: String,
    studentName: { type: String, required: true, trim: true },
    department: { type: String, required: true, trim: true },
    fieldOfInterest: { type: String, default: '', trim: true },
    semester: { type: String, required: true, trim: true },
    collegeName: { type: String, required: true, trim: true },
    eventName: { type: String, required: true, trim: true },
    createdAt: { type: Date, default: Date.now }
}, { timestamps: true });

// Each event has many registrations; each student can register for many events.
// References use the application's stable string IDs (not MongoDB ObjectIds).
participationSchema.index({ eventId: 1, createdAt: -1 });
participationSchema.index({ studentId: 1, eventId: 1 });
festivalSchema.virtual('participants', {
    ref: 'EventParticipation', localField: 'id', foreignField: 'eventId'
});
festivalSchema.set('toJSON', { virtuals: true });

const Festival = mongoose.models.Festival || mongoose.model('Festival', festivalSchema);
const EventParticipation = mongoose.models.EventParticipation || mongoose.model('EventParticipation', participationSchema, 'eventParticipations');
const memoryParticipations = [];

async function loadFestivals() {
    await connectDB();

    if (!isConnected()) {
        festivals = [...fallbackFestivals];
        return festivals;
    }

    try {
        const savedFestivals = await Festival.find({}).sort({ createdAt: -1 }).lean();
        // An empty collection can mean all events were deliberately deleted.
        festivals = savedFestivals.map((festival) => ensureFestivalId(festival));
        return festivals;
    } catch (error) {
        console.error('Mongo festival load failed:', error.message);
        festivals = [...fallbackFestivals];
        return festivals;
    }
}

function ensureFestivalId(festival) {
    if (!festival) {
        return festival;
    }

    return {
        ...festival,
        id: festival.id || String(festival._id || uuidv4())
    };
}

function cleanEventDetails(eventData) {
    const fields = ['festName', 'time', 'chiefGuest', 'description', 'notification'];
    return Object.fromEntries(fields
        .filter((field) => Object.hasOwn(eventData, field))
        .map((field) => [field, String(eventData[field] || '').trim()]));
}

function validateNewEvent(eventData = {}) {
    const fields = [
        ['festName', 'Fest name', 100], ['eventName', 'Event name', 100],
        ['eventLocation', 'Venue', 120], ['eventDate', 'Event date', 10],
        ['time', 'Time', 5], ['chiefGuest', 'Chief guest', 120],
        ['description', 'Small description', 500], ['image', 'Cover image', null]
    ];
    for (const [field, label, limit] of fields) {
        const value = String(eventData[field] || '').trim();
        if (!value) return `${label} is required.`;
        if (limit && value.length > limit) return `${label} must be ${limit} characters or fewer.`;
    }
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(eventData.time)) return 'Enter a valid event time.';
    const date = String(eventData.eventDate);
    const parsed = new Date(`${date}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return 'Enter a valid event date.';
    if (String(eventData.notification || '').trim().length > 500) return 'Notification must be 500 characters or fewer.';
    return null;
}

async function addFestival(eventData = {}) {
    await connectDB();
    if (!isConnected()) {
        return { success: false, message: 'The database is unavailable. The event was not saved. Please try again.' };
    }

    const cleanedName = String(eventData.eventName || eventData.name || '').trim();
    const cleanedLocation = String(eventData.eventLocation || eventData.location || '').trim();
    const cleanedDate = String(eventData.eventDate || eventData.date || '').trim();

    if (!cleanedName || !cleanedLocation) {
        return { success: false, message: 'Event name and location are required.' };
    }

    const festivalPayload = {
        id: uuidv4(),
        name: cleanedName,
        ...cleanEventDetails(eventData),
        location: cleanedLocation,
        date: formatFestivalDate(cleanedDate),
        dateISO: /^\d{4}-\d{2}-\d{2}$/.test(cleanedDate) ? cleanedDate : '',
        image: eventData.image || 'https://images.unsplash.com/photo-1517457373958-b7bdd4587205?auto=format&fit=crop&w=800&q=80',
        createdBy: eventData.createdBy || eventData.teacherId || null,
        createdAt: new Date()
    };
    try {
        const savedFestival = await Festival.create(festivalPayload);
        const festivalObject = ensureFestivalId(savedFestival.toObject());
        festivals = [festivalObject, ...festivals];
        return { success: true, festival: festivalObject, message: 'Event saved successfully.' };
    } catch (error) {
        console.error('Mongo event save failed:', error.message);
        return { success: false, message: 'Event could not be stored in MongoDB.' };
    }
}

async function editFestival(festivalId, eventData = {}) {
    const normalizedId = String(festivalId || '').trim();
    if (!normalizedId) {
        return { success: false, message: 'Festival id is required.' };
    }

    await connectDB();
    if (!isConnected()) {
        return { success: false, message: 'The database is unavailable. The event was not changed. Please try again.' };
    }

    const cleanedName = String(eventData.eventName || eventData.name || '').trim();
    const cleanedLocation = String(eventData.eventLocation || eventData.location || '').trim();
    const cleanedDate = String(eventData.eventDate || eventData.date || '').trim();

    if (!cleanedName || !cleanedLocation) {
        return { success: false, message: 'Event name and location are required.' };
    }

    const targetIndex = festivals.findIndex((festival) => String(festival.id || festival._id || '') === normalizedId);
    if (targetIndex === -1) {
        return { success: false, message: 'Festival not found.' };
    }

    const updatedFestival = ensureFestivalId({
        ...festivals[targetIndex],
        ...cleanEventDetails(eventData),
        id: normalizedId,
        name: cleanedName,
        location: cleanedLocation,
        date: cleanedDate ? formatFestivalDate(cleanedDate) : festivals[targetIndex].date || 'TBA',
        dateISO: cleanedDate
            ? (/^\d{4}-\d{2}-\d{2}$/.test(cleanedDate) ? cleanedDate : '')
            : festivals[targetIndex].dateISO || '',
        image: eventData.image || festivals[targetIndex].image || 'https://images.unsplash.com/photo-1517457373958-b7bdd4587205?auto=format&fit=crop&w=800&q=80',
        updatedAt: new Date().toISOString(),
        createdBy: festivals[targetIndex].createdBy || eventData.createdBy || eventData.teacherId || null
    });
    if (isConnected()) {
        try {
            const savedFestival = await Festival.findOneAndUpdate(
                { $or: [
                    { id: normalizedId },
                    ...(festivals[targetIndex]._id ? [{ _id: festivals[targetIndex]._id }] : [])
                ] },
                {
                    id: normalizedId,
                    name: cleanedName,
                    festName: updatedFestival.festName,
                    time: updatedFestival.time,
                    chiefGuest: updatedFestival.chiefGuest,
                    description: updatedFestival.description,
                    notification: updatedFestival.notification,
                    location: cleanedLocation,
                    date: updatedFestival.date,
                    dateISO: updatedFestival.dateISO,
                    image: updatedFestival.image,
                    createdBy: updatedFestival.createdBy,
                    updatedAt: updatedFestival.updatedAt
                },
                { new: true }
            );

            if (savedFestival) {
                festivals[targetIndex] = ensureFestivalId(savedFestival.toObject());
            } else {
                return { success: false, message: 'The event was not found in the database. Refresh the page and try again.' };
            }
        } catch (error) {
            console.error('Mongo event update failed:', error.message);
            return { success: false, message: 'The event could not be saved to the database. Please try again.' };
        }
    }

    return { success: true, festival: festivals[targetIndex], message: 'Event updated successfully.' };
}

async function deleteFestival(festivalId) {
    const normalizedId = String(festivalId || '').trim();
    if (!normalizedId) {
        return { success: false, message: 'Festival id is required.' };
    }

    await connectDB();
    if (!isConnected()) {
        return { success: false, message: 'The database is unavailable. The event was not deleted. Please try again.' };
    }

    const festivalToDelete = festivals.find((festival) => {
        const festivalIds = [String(festival.id || ''), String(festival._id || '')].filter(Boolean);
        return festivalIds.includes(normalizedId);
    });

    if (!festivalToDelete) {
        return { success: false, message: 'Festival not found.' };
    }

    const deleteMatchValues = new Set([
        normalizedId,
        String(festivalToDelete.id || ''),
        String(festivalToDelete._id || '')
    ].filter(Boolean));

    if (isConnected()) {
        try {
            const result = await Festival.deleteMany({
                $or: [
                    { id: { $in: [...deleteMatchValues] } },
                    ...(festivalToDelete._id ? [{ _id: festivalToDelete._id }] : [])
                ]
            });

            if (result.deletedCount === 0) {
                return { success: false, message: 'Festival and its image were not found in the database.' };
            }
        } catch (error) {
            console.error('Mongo event delete failed:', error.message);
            return { success: false, message: 'Festival and its image could not be deleted from the database.' };
        }
    }

    festivals = festivals.filter((festival) => {
        const festivalIds = [String(festival.id || ''), String(festival._id || '')].filter(Boolean);
        return !festivalIds.some((festivalIdValue) => deleteMatchValues.has(festivalIdValue));
    });

    return { success: true, message: 'Festival deleted successfully.' };
}

async function addParticipation(participationData = {}) {
    await connectDB();

    const cleanedData = {
        eventId: String(participationData.eventId || '').trim(),
        studentId: String(participationData.studentId || '').trim(),
        email: String(participationData.email || '').trim(),
        mobileNumber: String(participationData.mobileNumber || '').trim(),
        enrollmentNumber: String(participationData.enrollmentNumber || '').trim(),
        gender: String(participationData.gender || '').trim(),
        studentName: String(participationData.studentName || '').trim(),
        department: String(participationData.department || '').trim(),
        fieldOfInterest: String(participationData.fieldOfInterest || '').trim(),
        semester: String(participationData.semester || '').trim(),
        collegeName: String(participationData.collegeName || '').trim(),
        eventName: String(participationData.eventName || '').trim()
    };

    if (!cleanedData.eventId || !cleanedData.studentId) {
        return { success: false, message: 'Select an event and sign in as a student to register.' };
    }
    const event = getFestivalById(cleanedData.eventId);
    if (!event) return { success: false, message: 'The selected event no longer exists.' };
    cleanedData.eventId = event.id;
    cleanedData.eventName = event.name;

    if (!cleanedData.studentName || !cleanedData.department || (!cleanedData.fieldOfInterest && !participationData.allowMissingFieldOfInterest) || !cleanedData.semester || !cleanedData.collegeName || !cleanedData.eventName) {
        return { success: false, message: 'All participation fields are required.' };
    }

    if (!isConnected()) {
        if (participationData.requireDatabase) {
            return { success: false, message: 'The database is unavailable. Participation was not saved.' };
        }
        const participationRecord = { ...cleanedData, createdAt: new Date() };
        memoryParticipations.push(participationRecord);
        return { success: true, participation: participationRecord, message: 'Participation saved in local memory.' };
    }

    try {
        const savedParticipation = await EventParticipation.create(cleanedData);
        return {
            success: true,
            participation: savedParticipation.toObject(),
            message: 'Participation saved successfully.'
        };
    } catch (error) {
        console.error('Mongo event participation save failed:', error.message);
        return { success: false, message: 'Participation could not be stored in MongoDB.' };
    }
}

async function getParticipationsForEvent(event) {
    if (!event) return [];
    await connectDB();
    // A legacy name can identify an event only when that name is unique.
    const uniqueName = festivals.filter(candidate => normalizeParticipationName(candidate.name) === normalizeParticipationName(event.name)).length === 1;
    const matches = record => record.eventId
        ? record.eventId === event.id
        : uniqueName && normalizeParticipationName(record.eventName) === normalizeParticipationName(event.name);
    let records = memoryParticipations.filter(matches);
    if (isConnected()) {
        const escapedName = String(event.name).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const saved = await EventParticipation.find({ $or: [
            { eventId: event.id },
            ...(uniqueName ? [{ eventId: { $in: [null, ''] }, eventName: { $regex: `^\\s*${escapedName}\\s*$`, $options: 'i' } }] : [])
        ] }).sort({ createdAt: -1 }).lean();
        records = [...saved, ...records];
    }
    return records.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function normalizeParticipationName(value) {
    return String(value || '').trim().toLowerCase();
}

async function migrateParticipationRelationships(accounts = []) {
    await connectDB();
    if (!isConnected()) throw new Error('MongoDB must be connected to migrate participation records.');
    const savedEvents = await Festival.find({}).lean();
    // Persist IDs for older events so references remain valid after a restart.
    for (const event of savedEvents) {
        if (!event.id) {
            event.id = String(event._id);
            await Festival.collection.updateOne({ _id: event._id }, { $set: { id: event.id } });
        }
    }
    const records = await EventParticipation.find({}).lean();
    const report = { total: records.length, updated: 0, unresolvedEvents: 0, unresolvedStudents: 0 };
    for (const record of records) {
        const changes = {};
        if (!record.eventId) {
            const matches = savedEvents.filter(event => normalizeParticipationName(event.name) === normalizeParticipationName(record.eventName));
            if (matches.length === 1) changes.eventId = matches[0].id;
            else report.unresolvedEvents++;
        }
        const students = accounts.filter(account => account.role === 'student');
        const matches = record.studentId
            ? students.filter(student => [student.id, student.email].includes(record.studentId))
            : students.filter(student => normalizeParticipationName(student.name) === normalizeParticipationName(record.studentName) && normalizeParticipationName(student.collegeName) === normalizeParticipationName(record.collegeName) && normalizeParticipationName(student.department) === normalizeParticipationName(record.department));
        if (matches.length === 1) {
            const student = matches[0];
            if (!record.studentId || record.studentId !== student.id) changes.studentId = student.id;
            for (const key of ['email', 'mobileNumber', 'enrollmentNumber', 'gender']) {
                if (!record[key] && student[key]) changes[key] = student[key];
            }
        } else if (!record.studentId) report.unresolvedStudents++;
        if (Object.keys(changes).length) {
            // Legacy records can be incomplete; preserve their original fields.
            await EventParticipation.collection.updateOne({ _id: record._id }, { $set: changes });
            report.updated++;
        }
    }
    await EventParticipation.createIndexes();
    return report;
}

function getFestivals() {
    return festivals;
}

function getFestivalSlug(festival) {
    return String(festival?.name || 'festival')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
}

function getFestivalById(festivalId) {
    const requestedId = String(festivalId || '');
    return festivals.find((festival) => String(festival.id || '') === requestedId || getFestivalSlug(festival) === requestedId) || null;
}

module.exports = {
    validateNewEvent,
    getFestivals,
    getFestivalById,
    getFestivalSlug,
    loadFestivals,
    addFestival,
    editFestival,
    deleteFestival,
    addParticipation,
    getParticipationsForEvent,
    migrateParticipationRelationships,
    EventParticipation,
    Festival,
    normalizeFestivalDate
};
