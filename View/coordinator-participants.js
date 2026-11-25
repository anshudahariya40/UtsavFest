(() => {
    const options = document.getElementById('coordinator-event-options');
    if (!options) return;
    const events = JSON.parse(options.dataset.events);
    const fests = [...new Set(events.map(event => event.festName))].sort((a, b) => a.localeCompare(b));
    const addDialog = document.getElementById('add-participant-dialog');
    const viewDialog = document.getElementById('view-participants-dialog');
    const form = document.getElementById('coordinator-participant-form');
    const status = document.getElementById('participant-status');
    const submit = form.querySelector('button[type="submit"]');
    const listStatus = document.getElementById('participant-list-status');
    const tableContainer = document.querySelector('.participant-table-scroll');
    const tableBody = document.getElementById('participant-list-body');
    const viewEvent = document.getElementById('view-participant-event');
    const winnersForm = document.getElementById('event-winners-form');
    const winnerStatus = document.getElementById('event-winners-status');
    const winnerSelects = [...winnersForm.querySelectorAll('select')];
    let loadedEventId = '';
    let listRequest;

    function clearList() {
        listRequest?.abort();
        loadedEventId = '';
        winnersForm.hidden = true;
        winnerStatus.textContent = '';
        tableBody.replaceChildren();
        tableContainer.hidden = true;
        listStatus.classList.remove('error');
        listStatus.textContent = 'Choose a fest and event to view participants.';
    }

    function setupFilters(festId, eventId, onChange) {
        const festSelect = document.getElementById(festId);
        const eventSelect = document.getElementById(eventId);
        fests.forEach(fest => festSelect.add(new Option(fest, fest)));
        festSelect.addEventListener('change', () => {
            eventSelect.replaceChildren(new Option(festSelect.value ? 'Choose event' : 'Choose fest first', ''));
            events.filter(event => event.festName === festSelect.value)
                .forEach(event => eventSelect.add(new Option(event.name, event.id)));
            eventSelect.disabled = !festSelect.value || eventSelect.options.length === 1;
            onChange?.();
        });
    }

    setupFilters('participant-fest', 'participant-event', () => {
        status.textContent = '';
        status.classList.remove('error', 'success');
    });
    setupFilters('view-participant-fest', 'view-participant-event', clearList);

    const identifier = document.getElementById('participant-identifier');
    identifier.addEventListener('input', () => {
        status.textContent = '';
        status.classList.remove('error', 'success');
    });

    document.getElementById('open-add-participant').addEventListener('click', () => {
        status.textContent = '';
        status.classList.remove('error', 'success');
        addDialog.showModal();
    });
    document.getElementById('close-add-participant').addEventListener('click', () => addDialog.close());
    document.getElementById('close-view-participants').addEventListener('click', () => viewDialog.close());
    viewDialog.addEventListener('close', () => listRequest?.abort());
    document.getElementById('open-view-participants').addEventListener('click', () => {
        viewDialog.showModal();
        if (viewEvent.value) loadParticipants();
        else clearList();
        if (!events.length) listStatus.textContent = 'Create an event first to view participants.';
    });

    form.addEventListener('submit', async event => {
        event.preventDefault();
        submit.disabled = true;
        status.textContent = 'Finding student and adding participant...';
        status.classList.remove('error', 'success');
        try {
            const response = await fetch(form.action, {
                method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams(new FormData(form)).toString()
            });
            const result = await response.json();
            if (!response.ok || !result.success) throw new Error(result.message || 'Unable to add participant.');
            const student = result.participation;
            status.textContent = `${student.studentName} (${student.enrollmentNumber || student.mobileNumber}) has been added to ${student.eventName}.`;
            status.classList.add('success');
            identifier.value = '';
        } catch (error) {
            status.textContent = error.message || 'Unable to add participant.';
            status.classList.add('error');
        } finally {
            submit.disabled = false;
        }
    });

    async function loadParticipants() {
        clearList();
        if (!viewEvent.value) return;
        listRequest = new AbortController();
        const request = listRequest;
        const selectedEvent = events.find(event => event.id === viewEvent.value);
        listStatus.textContent = 'Loading participants...';
        try {
            const response = await fetch(`/coordinator/participants?eventId=${encodeURIComponent(viewEvent.value)}`, {
                signal: request.signal, cache: 'no-store'
            });
            const result = await response.json();
            if (request.signal.aborted) return;
            if (!response.ok || !result.success) throw new Error(result.message || 'Unable to load participants.');
            const participants = result.participants;
            const winnerResponse = await fetch(`/event-content/winners?eventId=${encodeURIComponent(viewEvent.value)}`, { signal: request.signal, cache: 'no-store' });
            const winnerResult = await winnerResponse.json();
            if (request.signal.aborted) return;
            if (!winnerResponse.ok) throw new Error(winnerResult.message || 'Unable to load winners.');
            winnerSelects.forEach((select, index) => {
                select.replaceChildren(new Option('Not awarded', ''));
                participants.filter(student => student.id).forEach(student => select.add(new Option(`${student.studentName} (${student.enrollmentNumber || student.mobileNumber || student.id})`, student.id)));
                select.value = winnerResult.winners.find(winner => winner.rank === index + 1)?.participantId || '';
            });
            loadedEventId = viewEvent.value;
            winnersForm.hidden = !participants.length;
            listStatus.textContent = participants.length ? `${participants.length} participant${participants.length === 1 ? '' : 's'}` : 'No participants have been added to this event yet.';
            document.getElementById('participant-list-caption').textContent = `${selectedEvent.festName} > ${selectedEvent.name}`;
            participants.forEach(student => {
                const row = document.createElement('tr');
                ['studentName', 'enrollmentNumber', 'mobileNumber', 'email', 'department', 'semester', 'collegeName'].forEach(field => {
                    const cell = document.createElement('td');
                    cell.textContent = student[field] || '—';
                    row.append(cell);
                });
                tableBody.append(row);
            });
            tableContainer.hidden = !participants.length;
        } catch (error) {
            if (request.signal.aborted) return;
            listStatus.textContent = error.message || 'Unable to load participants.';
            listStatus.classList.add('error');
        }
    }
    winnersForm.addEventListener('submit', async event => {
        event.preventDefault();
        if (!loadedEventId || loadedEventId !== viewEvent.value) return;
        const eventId = loadedEventId;
        const winners = winnerSelects.map((select, index) => ({ rank: index + 1, participantId: select.value })).filter(winner => winner.participantId);
        if (new Set(winners.map(winner => winner.participantId)).size !== winners.length) {
            winnerStatus.textContent = 'Choose a different participant for each place.';
            return;
        }
        const controls = [...winnersForm.querySelectorAll('button, select'), document.getElementById('view-participant-fest'), viewEvent];
        controls.forEach(control => { control.disabled = true; });
        winnerStatus.textContent = 'Saving winners...';
        try {
            const response = await fetch(`/event-content/winners?eventId=${encodeURIComponent(eventId)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ winners }) });
            const result = await response.json();
            if (!response.ok) throw new Error(result.message || 'Unable to save winners.');
            if (loadedEventId === eventId) winnerStatus.textContent = 'Winners saved. They will appear in the event and participation reports.';
        } catch (error) {
            if (loadedEventId === eventId) winnerStatus.textContent = error.message || 'Unable to save winners.';
        } finally { controls.forEach(control => { control.disabled = false; }); }
    });
    viewEvent.addEventListener('change', loadParticipants);
})();
