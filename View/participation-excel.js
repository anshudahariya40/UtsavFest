(() => {
    const input = document.getElementById('student-excel-file');
    if (!input) return;
    const status = document.getElementById('student-excel-status');
    const preview = document.getElementById('student-excel-preview');
    const table = document.getElementById('student-excel-table');
    const previous = document.getElementById('student-excel-previous');
    const next = document.getElementById('student-excel-next');
    const pageLabel = document.getElementById('student-excel-page');
    const fest = document.getElementById('participation-fest');
    const event = document.getElementById('participation-event');
    const options = document.getElementById('participation-event-options');
    const events = JSON.parse(options.dataset.events);
    const pageSize = 100;
    let results = [], page = 0, importing = false, resultsRequest;
    const labels = { added: 'Added', alreadyRegistered: 'Already registered', unmatched: 'Not found', ambiguous: 'Conflicting identifiers', incomplete: 'Incomplete profile', failed: 'Not saved' };

    function resetPreview() {
        results = [];
        page = 0;
        preview.hidden = true;
        table.tBodies[0].replaceChildren();
    }
    function populateEvents(selected = '') {
        event.replaceChildren(new Option(fest.value ? 'Select event' : 'Select fest first', ''));
        events.filter(item => item.festName === fest.value).forEach(item => event.add(new Option(item.name, item.id)));
        event.value = selected;
        event.disabled = !fest.value;
        input.disabled = !event.value;
    }
    [...new Set(events.map(item => item.festName))].sort((a, b) => a.localeCompare(b)).forEach(name => fest.add(new Option(name, name)));
    fest.disabled = !events.length;
    const selected = events.find(item => item.id === options.dataset.selectedEvent);
    if (selected) { fest.value = selected.festName; populateEvents(selected.id); }

    async function refreshRegistered() {
        resultsRequest?.abort();
        if (!event.value) {
            const empty = document.createElement('p');
            empty.textContent = 'Select a fest and event above to view its participants.';
            document.querySelector('.participation-results').replaceChildren(empty);
            return;
        }
        const request = resultsRequest = new AbortController();
        const selectedId = event.value;
        try {
            const response = await fetch(`/admin-dashboard/participation?eventId=${encodeURIComponent(selectedId)}`, { signal: request.signal, cache: 'no-store' });
            if (!response.ok) return;
            const parsed = new DOMParser().parseFromString(await response.text(), 'text/html');
            const updated = parsed.querySelector('.participation-results');
            if (updated && !request.signal.aborted && selectedId === event.value) document.querySelector('.participation-results').replaceWith(updated);
        } catch (error) {
            if (!request.signal.aborted) console.error('Unable to refresh participant list.', error);
        }
    }
    function selectionChanged() {
        resetPreview();
        input.value = '';
        input.disabled = !event.value;
        status.textContent = event.value ? 'Upload an Excel file to automatically add matching students.' : 'Select a fest and event to upload a file.';
        const url = new URL(location.href);
        if (event.value) url.searchParams.set('eventId', event.value);
        else url.searchParams.delete('eventId');
        history.replaceState(null, '', url);
        refreshRegistered();
    }
    fest.addEventListener('change', () => { if (!importing) { populateEvents(); selectionChanged(); } });
    event.addEventListener('change', () => { if (!importing) selectionChanged(); });

    function renderPage() {
        const fragment = document.createDocumentFragment();
        results.slice(page * pageSize, (page + 1) * pageSize).forEach(result => {
            const row = document.createElement('tr');
            const values = [
                `${result.sheet}: ${result.rowNumber}`, labels[result.status], result.studentName,
                result.enrollmentNumber || result.identifiers.join(' / '), result.mobileNumber,
                result.department, result.semester, result.collegeName, result.message
            ];
            values.forEach(value => {
                const cell = document.createElement('td');
                cell.textContent = value || '—';
                row.append(cell);
            });
            fragment.append(row);
        });
        table.tBodies[0].replaceChildren(fragment);
        previous.disabled = page === 0;
        next.disabled = (page + 1) * pageSize >= results.length;
        pageLabel.textContent = `${page * pageSize + 1}–${Math.min((page + 1) * pageSize, results.length)} of ${results.length} Excel rows`;
    }

    function extractRows(workbook) {
        const rows = [], skippedSheets = [];
        const recognized = new Set(['enrollment', 'enrollmentno', 'enrollmentnumber', 'enrolment', 'enrolmentno', 'enrolmentnumber', 'enrollno', 'enrollnumber', 'rollno', 'rollnumber', 'mobileno', 'mobilenumber', 'mobile', 'phone', 'phoneno', 'phonenumber', 'contact', 'contactno', 'contactnumber', 'identifier', 'studentidentifier', 'enrollmentormobilenumber']);
        for (const sheet of workbook.worksheets) {
            if (sheet.rowCount > 10001 || sheet.columnCount > 100) throw new Error('Use up to 10,000 rows and 100 columns per worksheet.');
            let columns = null;
            sheet.eachRow((row, rowNumber) => {
                const values = [];
                row.eachCell((cell, column) => { values[column] = cell.text.trim(); });
                if (!values.some(value => value)) return;
                if (columns === null) {
                    columns = [];
                    values.forEach((value, column) => {
                        if (recognized.has(value.toLowerCase().replace(/[^a-z0-9]/g, ''))) columns.push(column);
                    });
                    if (!columns.length) skippedSheets.push(sheet.name);
                } else if (columns.length) {
                    const identifiers = [...new Set(columns.map(column => values[column] || '').filter(Boolean))];
                    if (identifiers.length > 3 || identifiers.some(value => value.length > 100)) throw new Error('Use up to three identifier columns, with values up to 100 characters.');
                    rows.push({ sheet: sheet.name, rowNumber, identifiers });
                }
            });
        }
        if (rows.length > 10000) throw new Error('Use up to 10,000 student rows across the workbook.');
        if (!rows.length) throw new Error('No student rows found. Add an Enrollment number or Mobile number column heading and student identifiers below it.');
        return { rows, skippedSheets };
    }

    input.addEventListener('change', async () => {
        if (importing) return;
        resetPreview();
        const file = input.files[0];
        if (!file) return;
        if (!event.value) { status.textContent = 'Select a fest and event first.'; return; }
        if (!/\.xlsx$/i.test(file.name)) { status.textContent = 'Please choose an Excel .xlsx file. Save older .xls files as .xlsx first.'; return; }
        if (file.size > 5 * 1024 * 1024) { status.textContent = 'Please choose a file smaller than 5 MB.'; return; }
        importing = true;
        const selectedId = event.value;
        const selectedEvent = events.find(item => item.id === selectedId);
        input.disabled = fest.disabled = event.disabled = true;
        status.textContent = 'Reading Excel and adding matching students...';
        try {
            const workbook = new ExcelJS.Workbook();
            try { await workbook.xlsx.load(await file.arrayBuffer()); }
            catch { throw new Error('Could not read this file. Choose a valid, unprotected Excel .xlsx workbook.'); }
            const { rows, skippedSheets } = extractRows(workbook);
            const response = await fetch('/admin-dashboard/participation/import', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ eventId: selectedId, rows })
            });
            const result = await response.json();
            if (!response.ok || !result.success) throw new Error(result.message || 'Unable to import this student list.');
            results = result.results;
            const summary = result.summary;
            status.textContent = `${summary.added} added to ${selectedEvent.festName} > ${selectedEvent.name}. ${summary.alreadyRegistered} already registered. ${summary.total - summary.added - summary.alreadyRegistered} rows need attention.${skippedSheets.length ? ` Worksheets without identifier headings were skipped: ${skippedSheets.join(', ')}.` : ''}`;
            table.caption.textContent = `${selectedEvent.festName} > ${selectedEvent.name} — Excel participation results`;
            preview.hidden = false;
            renderPage();
            await refreshRegistered();
        } catch (error) {
            status.textContent = error.message || 'Unable to import this file. Please try again.';
        } finally {
            importing = false;
            fest.disabled = !events.length;
            event.disabled = !fest.value;
            input.disabled = !event.value;
            input.value = '';
        }
    });
    previous.addEventListener('click', () => { if (page > 0) { page--; renderPage(); } });
    next.addEventListener('click', () => { if ((page + 1) * pageSize < results.length) { page++; renderPage(); } });
    document.getElementById('student-excel-clear').addEventListener('click', () => {
        resetPreview();
        status.textContent = 'Preview cleared. Saved event participants remain registered.';
    });
})();
