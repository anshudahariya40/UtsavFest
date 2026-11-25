const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const archiver = require('archiver');
const { createEventContentStore } = require('../Model/event-content');

function createEventContentHandler({ getEvents, isCoordinator, isAdmin, validSession, allowedOrigin, getParticipants = async () => [], store = createEventContentStore() }) {
    const viewFolder = path.join(__dirname, '..', 'View');
    const routes = new Set(['/event-photos', '/event-reports', '/event-content/photos', '/event-content/photo', '/event-content/photos.zip', '/event-content/report.zip', '/event-content/report', '/event-content/winners', '/event-content.js', '/event-content.css']);
    function send(response, status, data) {
        response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify(data));
    }
    function readBody(request, limit) {
        return new Promise((resolve, reject) => {
            const chunks = []; let size = 0; let exceeded = false;
            request.on('data', chunk => {
                size += chunk.length;
                if (size > limit) { exceeded = true; chunks.length = 0; }
                if (!exceeded) chunks.push(chunk);
            });
            request.on('end', () => {
                if (exceeded) return reject(new Error('The upload is too large. Each photo must be 8 MB or smaller.'));
                try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('Invalid request. Please try again.')); }
            });
            request.on('error', reject);
        });
    }
    return {
        matches: pathname => routes.has(pathname),
        async handle(request, response, user, url) {
            const route = url.pathname;
            if (route === '/event-content.js' || route === '/event-content.css') {
                if (request.method !== 'GET') return send(response, 405, { message: 'Method not allowed.' });
                response.writeHead(200, { 'Content-Type': route.endsWith('.js') ? 'application/javascript; charset=utf-8' : 'text/css; charset=utf-8', 'Cache-Control': 'no-cache' });
                return response.end(fs.readFileSync(path.join(viewFolder, route.slice(1))));
            }
            const isPage = ['/event-photos', '/event-reports'].includes(route);
            if (!validSession(user)) {
                if (isPage && request.method === 'GET') {
                    response.writeHead(302, { Location: `/login?returnTo=${encodeURIComponent(route)}` }); return response.end();
                }
                return send(response, 401, { message: 'Sign in to access event photos and reports.' });
            }
            const owns = event => Boolean(isCoordinator(user) && event.createdBy && [user.id, user.email].filter(Boolean).includes(event.createdBy));
            if (isPage) {
                if (request.method !== 'GET') return send(response, 405, { message: 'Method not allowed.' });
                const reports = route === '/event-reports';
                if (reports && !isCoordinator(user) && !isAdmin(user)) return send(response, 403, { message: 'Only coordinators and administrators can access event reports.' });
                const uploading = !reports && url.searchParams.get('mode') === 'upload';
                if (uploading && !isCoordinator(user)) return send(response, 403, { message: 'Only event coordinators can upload photos.' });
                const events = getEvents().filter(event => !uploading && !reports || (reports && isAdmin(user)) || owns(event)).map(event => ({ id: event.id, name: event.name, festName: event.festName || 'Other events', canEdit: owns(event) }));
                const html = ejs.render(fs.readFileSync(path.join(viewFolder, 'event-content.ejs'), 'utf8'), { events, reports, uploading, back: isAdmin(user) ? '/admin-dashboard' : '/' });
                response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return response.end(html);
            }
            const event = getEvents().find(event => event.id === url.searchParams.get('eventId'));
            if (!event) return send(response, 404, { message: 'Select an existing event.' });
            if (route === '/event-content/winners') {
                if (!owns(event) && !(request.method === 'GET' && isAdmin(user))) return send(response, 403, { message: 'Only the event coordinator can mark winners for this event.' });
                if (request.method === 'GET') return send(response, 200, { winners: await store.getWinners(event.id) });
                if (request.method !== 'POST') return send(response, 405, { message: 'Method not allowed.' });
                if (!allowedOrigin(request)) return send(response, 403, { message: 'Submit this form from the website.' });
                let payload;
                try { payload = await readBody(request, 10000); } catch (error) { return send(response, 400, { message: error.message }); }
                const selections = payload?.winners;
                if (!Array.isArray(selections) || selections.length > 3 || selections.some(item => !item || ![1, 2, 3].includes(item.rank) || typeof item.participantId !== 'string' || !item.participantId.trim() || item.participantId.length > 100) || new Set(selections.map(item => item.rank)).size !== selections.length || new Set(selections.map(item => item.participantId)).size !== selections.length) {
                    return send(response, 400, { message: 'Choose a different participant for each of the first, second and third places.' });
                }
                const participants = await getParticipants(event);
                const winners = [];
                for (const selection of selections) {
                    const participant = participants.find(record => String(record._id || record.id || '') === selection.participantId);
                    if (!participant) return send(response, 400, { message: 'Winners must be registered participants in this event.' });
                    winners.push({ rank: selection.rank, participantId: selection.participantId, studentName: participant.studentName, enrollmentNumber: participant.enrollmentNumber || '', collegeName: participant.collegeName || '' });
                }
                winners.sort((a, b) => a.rank - b.rank);
                return send(response, 200, { success: true, winners: await store.saveWinners(event.id, winners) });
            }
            if (request.method === 'POST') {
                if (!['/event-content/photos', '/event-content/report'].includes(route)) return send(response, 405, { message: 'Method not allowed.' });
                if (!owns(event)) return send(response, 403, { message: 'You can only update photos and reports for your own events.' });
                if (!allowedOrigin(request)) return send(response, 403, { message: 'Submit this form from the website.' });
                let payload;
                try {
                    payload = await readBody(request, route.endsWith('/photos') ? 12 * 1024 * 1024 : 150000);
                    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid request.');
                } catch (error) { return send(response, 400, { message: error.message }); }
                // Validate before storage; disk failures are handled as server errors below.
                if (route.endsWith('/photos')) {
                    const { decodePhoto } = require('../Model/event-content');
                    try { decodePhoto(payload.data); } catch (error) { return send(response, 400, { message: error.message }); }
                    const photo = await store.addPhoto(event.id, user.id || user.email, payload);
                    return send(response, 201, { success: true, photo });
                }
                const title = String(payload.title || '').trim(), body = String(payload.body || '').trim();
                if (!title || title.length > 150 || !body || body.length > 30000) return send(response, 400, { message: 'Enter a title (up to 150 characters) and a report (up to 30,000 characters).' });
                return send(response, 200, { success: true, report: await store.saveReport(event.id, user.id || user.email, { title, body }) });
            }
            if (request.method !== 'GET') return send(response, 405, { message: 'Method not allowed.' });
            if (route === '/event-content/report.zip') {
                if (!isAdmin(user)) return send(response, 403, { message: 'Only administrators can download event report packages.' });
                const report = await store.getReport(event.id);
                if (!report) return send(response, 404, { message: 'The coordinator has not written a report for this event yet.' });
                const photos = await store.listPhotos(event.id);
                const entries = await Promise.all(photos.map(photo => store.getPhoto(event.id, photo.id)));
                await Promise.all(entries.map(photo => fs.promises.access(photo.file)));
                const winners = await store.getWinners(event.id);
                const filename = `${String(event.name).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'event'}-report.zip`;
                response.writeHead(200, { 'Content-Type': 'application/zip', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': `attachment; filename="${filename}"` });
                const archive = archiver('zip', { store: true });
                archive.on('error', () => response.destroy()); archive.on('warning', () => response.destroy());
                response.on('close', () => archive.abort()); archive.pipe(response);
                const winnerText = winners.length ? winners.map(winner => `${winner.rank}. ${winner.studentName}${winner.enrollmentNumber ? ` (${winner.enrollmentNumber})` : ''}${winner.collegeName ? ` - ${winner.collegeName}` : ''}`).join('\n') : 'Winners have not been announced yet.';
                const text = `${report.title}\n\nFest: ${event.festName || 'Other events'}\nEvent: ${event.name}\nUpdated: ${report.updatedAt}\n\n${report.body}\n\nEvent winners\n${winnerText}\n`;
                archive.append(text, { name: 'report.txt' });
                entries.forEach((photo, index) => archive.file(photo.file, { name: `photos/${index + 1}-${photo.name.replace(/[^a-zA-Z0-9._-]/g, '_')}` }));
                if (!entries.length) archive.append('No photos have been uploaded for this event.\n', { name: 'photos/README.txt' });
                await archive.finalize(); return;
            }
            if (route === '/event-content/report') {
                if (!owns(event) && !isAdmin(user)) return send(response, 403, { message: 'You cannot view this event report.' });
                return send(response, 200, { report: await store.getReport(event.id), winners: await store.getWinners(event.id) });
            }
            if (route === '/event-content/photos') return send(response, 200, { photos: await store.listPhotos(event.id) });
            if (route === '/event-content/photo') {
                const photo = await store.getPhoto(event.id, url.searchParams.get('photoId') || '');
                if (!photo) return send(response, 404, { message: 'Photo not found.' });
                const stat = await fs.promises.stat(photo.file);
                response.writeHead(200, { 'Content-Type': photo.type, 'Content-Length': stat.size, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-cache', 'Content-Disposition': `${url.searchParams.has('download') ? 'attachment' : 'inline'}; filename="event-photo.${photo.extension}"; filename*=UTF-8''${encodeURIComponent(photo.name)}` });
                const stream = fs.createReadStream(photo.file);
                stream.on('error', () => response.destroy()); response.on('close', () => stream.destroy()); return stream.pipe(response);
            }
            if (route === '/event-content/photos.zip') {
                const photos = await store.listPhotos(event.id);
                if (!photos.length) return send(response, 404, { message: 'No photos have been uploaded for this event.' });
                const entries = await Promise.all(photos.map(photo => store.getPhoto(event.id, photo.id)));
                await Promise.all(entries.map(photo => fs.promises.access(photo.file)));
                response.writeHead(200, { 'Content-Type': 'application/zip', 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="event-photos.zip"' });
                const archive = archiver('zip', { store: true });
                archive.on('error', () => response.destroy()); archive.on('warning', () => response.destroy());
                response.on('close', () => archive.abort()); archive.pipe(response);
                entries.forEach((photo, index) => archive.file(photo.file, { name: `${index + 1}-${photo.name.replace(/[^a-zA-Z0-9._-]/g, '_')}` }));
                await archive.finalize(); return;
            }
            return send(response, 404, { message: 'Page not found.' });
        }
    };
}

module.exports = { createEventContentHandler };
