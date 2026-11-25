(() => {
    const root = document.getElementById('event-content');
    if (!root) return;
    const events = JSON.parse(root.dataset.events);
    const mode = root.dataset.mode;
    const festSelect = document.getElementById('content-fest');
    const eventSelect = document.getElementById('content-event');
    const status = document.getElementById('content-status');
    const reportForm = document.getElementById('report-form');
    const photoForm = document.getElementById('photo-form');
    const fileInput = document.getElementById('photo-files');
    let selectedFest = '', selectedEvent = '', dirty = false, busy = false, version = 0;
    const notice = (message, error = false) => { status.textContent = message; status.dataset.error = String(error); };
    const endpoint = (resource, eventId = selectedEvent) => `/event-content/${resource}?eventId=${encodeURIComponent(eventId)}`;
    function option(value, label) { const node = document.createElement('option'); node.value = value; node.textContent = label; return node; }
    [...new Set(events.map(event => event.festName))].sort().forEach(fest => festSelect.append(option(fest, fest)));
    function lock(value) {
        busy = value; festSelect.disabled = value; eventSelect.disabled = value || !selectedFest;
        if (fileInput) fileInput.disabled = value;
        document.querySelectorAll('button[type="submit"]').forEach(button => { button.disabled = value; });
    }
    async function api(url, options) {
        const response = await fetch(url, options);
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || 'Unable to complete this request. Please try again.');
        return data;
    }
    const post = (resource, payload) => api(endpoint(resource), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    function hidePanels() { ['report-panel', 'upload-panel', 'gallery-panel'].forEach(id => { const panel = document.getElementById(id); if (panel) panel.hidden = true; }); }
    function canLeave() { return !busy && (!dirty || window.confirm('Leave this report without saving your changes?')); }
    festSelect.addEventListener('change', () => {
        if (!canLeave()) { festSelect.value = selectedFest; return; }
        selectedFest = festSelect.value; selectedEvent = ''; dirty = false; version++;
        eventSelect.replaceChildren(option('', selectedFest ? 'Select an event' : 'Select a fest first'));
        events.filter(event => event.festName === selectedFest).forEach(event => eventSelect.append(option(event.id, event.name)));
        eventSelect.disabled = !selectedFest; hidePanels(); resetFiles();
        notice(selectedFest ? 'Select an event to continue.' : 'Select a fest and event to get started.');
    });
    eventSelect.addEventListener('change', () => {
        if (!canLeave()) { eventSelect.value = selectedEvent; return; }
        selectedEvent = eventSelect.value; dirty = false; resetFiles(); loadSelected();
    });
    async function loadSelected() {
        const current = ++version; hidePanels();
        if (!selectedEvent) { notice('Select an event to continue.'); return; }
        notice('Loading event details…');
        try {
            if (mode === 'reports') {
                const { report, winners = [] } = await api(endpoint('report'));
                if (current !== version) return;
                const winnerList = document.getElementById('report-winners');
                winnerList.replaceChildren();
                winners.forEach(winner => {
                    const item = document.createElement('li');
                    item.value = winner.rank;
                    item.textContent = `${winner.studentName}${winner.enrollmentNumber ? ` (${winner.enrollmentNumber})` : ''}`;
                    winnerList.append(item);
                });
                if (!winners.length) {
                    const item = document.createElement('li');
                    item.textContent = 'Winners have not been announced yet.';
                    item.style.listStyle = 'none';
                    winnerList.append(item);
                }
                const editable = events.find(event => event.id === selectedEvent).canEdit;
                document.getElementById('report-title').value = report?.title || '';
                document.getElementById('report-body').value = report?.body || '';
                document.getElementById('report-title').readOnly = !editable;
                document.getElementById('report-body').readOnly = !editable;
                document.getElementById('report-save').hidden = !editable;
                document.getElementById('report-heading').textContent = editable ? 'Write your report' : 'Event report';
                savedLabel(report); updateLength();
                document.getElementById('report-panel').hidden = false;
                notice(report ? 'Saved report loaded.' : editable ? 'No report yet. Write and save the first report for this event.' : 'The coordinator has not written a report for this event yet.');
            } else {
                await loadGallery(current);
                if (current !== version) return;
                if (photoForm) document.getElementById('upload-panel').hidden = false;
                notice(mode === 'upload' ? 'Event selected. Choose photos to upload.' : 'Event selected. Download individual photos or the whole album.');
            }
        } catch (error) { if (current === version) notice(error.message, true); }
    }
    async function loadGallery(current = version) {
        const eventId = selectedEvent;
        const { photos } = await api(endpoint('photos', eventId));
        if (current !== version) return;
        const gallery = document.getElementById('photo-gallery'); gallery.replaceChildren();
        document.getElementById('photo-count').textContent = `(${photos.length})`;
        document.getElementById('gallery-empty').hidden = photos.length > 0;
        const album = document.getElementById('download-album'); album.hidden = !photos.length; album.href = endpoint('photos.zip', eventId);
        photos.forEach(photo => {
            const figure = document.createElement('figure'); figure.className = 'photo-card';
            const image = document.createElement('img'); image.loading = 'lazy'; image.alt = photo.name;
            const photoUrl = `${endpoint('photo', eventId)}&photoId=${encodeURIComponent(photo.id)}`;
            image.src = photoUrl;
            const caption = document.createElement('figcaption');
            const name = document.createElement('p'); name.textContent = photo.name;
            const download = document.createElement('a'); download.href = `${photoUrl}&download=1`; download.textContent = 'Download photo';
            caption.append(name, download); figure.append(image, caption); gallery.append(figure);
        });
        document.getElementById('gallery-panel').hidden = false;
    }
    function resetFiles() {
        if (!fileInput) return;
        fileInput.value = ''; document.getElementById('photo-selection').replaceChildren(); document.getElementById('upload-progress').textContent = '';
    }
    function fileList() {
        const list = document.getElementById('photo-selection'); list.replaceChildren();
        Array.from(fileInput.files).forEach(file => { const item = document.createElement('li'); item.textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB`; list.append(item); });
    }
    if (fileInput) fileInput.addEventListener('change', fileList);
    const asDataUrl = file => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('Unable to read this photo.')); reader.readAsDataURL(file); });
    if (photoForm) photoForm.addEventListener('submit', async event => {
        event.preventDefault();
        if (busy || !selectedEvent || !fileInput.files.length) return;
        const files = Array.from(fileInput.files);
        const invalid = files.find(file => !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || !file.size || file.size > 8 * 1024 * 1024);
        if (invalid) { notice(`${invalid.name}: choose a JPEG, PNG, or WebP photo up to 8 MB.`, true); return; }
        lock(true); let saved = 0; const failed = []; const errors = [];
        try {
            for (const [index, file] of files.entries()) {
                document.getElementById('upload-progress').textContent = `Uploading ${index + 1} of ${files.length}…`;
                try { await post('photos', { name: file.name, data: await asDataUrl(file) }); saved++; }
                catch (error) { failed.push(file); errors.push(`${file.name}: ${error.message}`); }
            }
            const retry = new DataTransfer(); failed.forEach(file => retry.items.add(file)); fileInput.files = retry.files; fileList();
            try { await loadGallery(); } catch { errors.push('Refresh the page to reload the gallery.'); }
            document.getElementById('upload-progress').textContent = `${saved} of ${files.length} uploaded`;
            notice(errors.length ? `${saved} photos uploaded. ${errors.join(' ')} Failed photos remain selected for retry.` : `${saved} photos uploaded successfully. Everyone can now download them.`, errors.length > 0);
        } finally { lock(false); }
    });
    function updateLength() { document.getElementById('report-length').textContent = `${document.getElementById('report-body').value.length.toLocaleString()} / 30,000 characters`; }
    function savedLabel(report) { document.getElementById('report-saved').textContent = report ? `Saved ${new Date(report.updatedAt).toLocaleString()}` : 'Not saved yet'; }
    if (reportForm) {
        reportForm.addEventListener('input', () => { dirty = true; updateLength(); document.getElementById('report-saved').textContent = 'Unsaved changes'; });
        reportForm.addEventListener('submit', async event => {
            event.preventDefault(); if (busy || !selectedEvent) return;
            lock(true);
            const title = document.getElementById('report-title'), body = document.getElementById('report-body');
            title.readOnly = true; body.readOnly = true;
            notice('Saving your report…');
            try { const { report } = await post('report', { title: title.value, body: body.value }); dirty = false; savedLabel(report); notice('Report saved successfully. You can return here to update it.'); }
            catch (error) { notice(error.message, true); }
            finally { lock(false); title.readOnly = false; body.readOnly = false; }
        });
    }
    window.addEventListener('beforeunload', event => { if (dirty || busy) { event.preventDefault(); event.returnValue = ''; } });
})();
