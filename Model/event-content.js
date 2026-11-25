const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const PHOTO_ID = /^[a-f0-9-]{36}$/;

function decodePhoto(data) {
    const match = typeof data === 'string' && data.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!match) throw new Error('Choose a JPEG, PNG, or WebP photo.');
    const buffer = Buffer.from(match[2], 'base64');
    if (!buffer.length || buffer.length > MAX_PHOTO_BYTES) throw new Error('Each photo must be 8 MB or smaller.');
    const valid = match[1] === 'image/jpeg' ? buffer.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
        : match[1] === 'image/png' ? buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
    if (!valid) throw new Error('The photo content does not match its image format.');
    return { buffer, type: match[1], extension: { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[match[1]] };
}

function createEventContentStore(root = path.join(__dirname, '..', 'data', 'event-content')) {
    const directory = eventId => path.join(root, createHash('sha256').update(String(eventId)).digest('hex'));
    async function readJson(file, fallback) {
        try { return JSON.parse(await fs.readFile(file, 'utf8')); }
        catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
    }
    async function writeJson(file, data) {
        await fs.mkdir(path.dirname(file), { recursive: true });
        const temporary = `${file}.${randomUUID()}.tmp`;
        try { await fs.writeFile(temporary, JSON.stringify(data), { flag: 'wx' }); await fs.rename(temporary, file); }
        finally { await fs.rm(temporary, { force: true }); }
    }
    return {
        async listPhotos(eventId) {
            const folder = path.join(directory(eventId), 'photos');
            let files;
            try { files = await fs.readdir(folder); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
            const photos = await Promise.all(files.filter(file => file.endsWith('.json')).map(file => readJson(path.join(folder, file), null)));
            return photos.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        },
        async addPhoto(eventId, userId, payload) {
            const { buffer, type, extension } = decodePhoto(payload.data);
            const original = path.basename(String(payload.name || 'event-photo').replace(/\\/g, '/')).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 140);
            const photo = { id: randomUUID(), name: `${original.replace(/\.[^.]*$/, '') || 'event-photo'}.${extension}`, type, extension, size: buffer.length, uploadedBy: userId, createdAt: new Date().toISOString() };
            const folder = path.join(directory(eventId), 'photos');
            await fs.mkdir(folder, { recursive: true });
            const file = path.join(folder, `${photo.id}.${extension}`);
            await fs.writeFile(file, buffer, { flag: 'wx' });
            try { await writeJson(path.join(folder, `${photo.id}.json`), photo); }
            catch (error) { await fs.rm(file, { force: true }); throw error; }
            return photo;
        },
        async getPhoto(eventId, id) {
            if (!PHOTO_ID.test(id)) return null;
            const photo = await readJson(path.join(directory(eventId), 'photos', `${id}.json`), null);
            return photo && { ...photo, file: path.join(directory(eventId), 'photos', `${id}.${photo.extension}`) };
        },
        getReport(eventId) { return readJson(path.join(directory(eventId), 'report.json'), null); },
        getWinners(eventId) { return readJson(path.join(directory(eventId), 'winners.json'), []); },
        async saveWinners(eventId, winners) {
            await writeJson(path.join(directory(eventId), 'winners.json'), winners);
            return winners;
        },
        async saveReport(eventId, userId, payload) {
            const title = String(payload.title || '').trim();
            const body = String(payload.body || '').trim();
            if (!title || title.length > 150 || !body || body.length > 30000) throw new Error('Enter a title (up to 150 characters) and a report (up to 30,000 characters).');
            const report = { title, body, updatedBy: userId, updatedAt: new Date().toISOString() };
            await writeJson(path.join(directory(eventId), 'report.json'), report);
            return report;
        }
    };
}

module.exports = { createEventContentStore, decodePhoto, MAX_PHOTO_BYTES };
