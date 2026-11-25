(() => {
    const section = document.querySelector('.faculty-approvals');
    if (!section) return;
    const status = section.querySelector('#faculty-approval-status');
    const buttons = [...section.querySelectorAll('.faculty-approval-button')];
    let saving = false;
    try {
        const message = sessionStorage.getItem('faculty-approval-message');
        if (message) {
            status.textContent = message;
            sessionStorage.removeItem('faculty-approval-message');
        }
    } catch (_) { /* Approval controls work without session storage. */ }
    buttons.forEach(button => button.addEventListener('click', async () => {
        if (saving) return;
        saving = true;
        buttons.forEach(item => { item.disabled = true; });
        status.textContent = 'Updating faculty approval…';
        try {
            const response = await fetch('/admin-dashboard/approvals', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: button.dataset.facultyId, approvalStatus: button.dataset.approvalNext })
            });
            const result = await response.json();
            if (!response.ok || !result.success) throw new Error(result.message || 'Faculty approval could not be updated.');
            status.textContent = result.message;
            try { sessionStorage.setItem('faculty-approval-message', result.message); } catch (_) { /* Update succeeded. */ }
            window.location.reload();
        } catch (error) {
            status.textContent = error.message || 'Unable to update approval. Check your connection and try again.';
            saving = false;
            buttons.forEach(item => { item.disabled = false; });
        }
    }));
})();
