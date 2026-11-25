(() => {
    const openButton = document.querySelector('#add-user-button');
    if (!openButton) return;

    const dialog = document.createElement('dialog');
    dialog.className = 'admin-user-dialog';
    dialog.setAttribute('aria-labelledby', 'add-user-title');
    dialog.innerHTML = `
        <header class="admin-user-dialog-header">
            <div><p class="dashboard-label">Manage accounts</p><h2 id="add-user-title">Add user</h2></div>
            <button type="button" class="admin-dialog-close" aria-label="Close add user form">&times;</button>
        </header>
        <p class="admin-dialog-description">Choose an account type and enter their registration details.</p>
        <form id="admin-add-user-form">
            <label class="admin-user-field">Account type
                <select name="role" required>
                    <option value="student">Student</option>
                    <option value="faculty">Faculty</option>
                    <option value="event-coordinator">Event Coordinator</option>
                </select>
            </label>
            <h3 id="registration-form-title">Student Registration Form</h3>
            <div class="admin-user-fields">
                <label class="admin-user-field"><span id="user-name-label">Student name</span>
                    <input name="name" autocomplete="name" maxlength="100" required>
                </label>
                <fieldset data-roles="student" class="admin-role-fields">
                    <label class="admin-user-field" for="admin-student-enrollment">Enrollment number
                        <input id="admin-student-enrollment" name="enrollmentNumber" type="text" placeholder="Enter student enrollment number" maxlength="20" required>
                    </label>
                </fieldset>
                <fieldset data-roles="student faculty" class="admin-role-fields">
                    <label class="admin-user-field">College name<input name="collegeName" maxlength="200" required></label>
                    <label class="admin-user-field">Department<input name="department" maxlength="200" required></label>
                </fieldset>
                <fieldset data-roles="event-coordinator" class="admin-role-fields" hidden disabled>
                    <label class="admin-user-field">Institute name<input name="instituteName" maxlength="200" required></label>
                </fieldset>
                <fieldset data-roles="student faculty event-coordinator" class="admin-role-fields">
                    <label class="admin-user-field"><span id="user-gender-label">Gender (optional)</span>
                        <select name="gender">
                            <option value="">Select gender</option><option value="male">Male</option>
                            <option value="female">Female</option><option value="other">Other</option>
                            <option value="prefer-not-to-say">Prefer not to say</option>
                        </select>
                    </label>
                </fieldset>
                <fieldset data-roles="student" class="admin-role-fields">
                    <label class="admin-user-field">Semester
                        <select name="semester" required><option value="">Select semester</option>
                            ${Array.from({ length: 8 }, (_, i) => `<option value="${i + 1}">Semester ${i + 1}</option>`).join('')}
                        </select>
                    </label>
                    <label class="admin-user-field">Student picture<input name="picture" type="file" accept="image/png,image/jpeg,image/webp" required><small>PNG, JPEG, or WebP, up to 2 MB.</small></label>
                </fieldset>
                <label class="admin-user-field">Email<input name="email" type="email" autocomplete="email" maxlength="254" required></label>
                <label class="admin-user-field">Mobile number<input name="mobileNumber" type="tel" autocomplete="tel" inputmode="numeric" maxlength="10" pattern="[0-9]{10}" title="Enter a 10-digit mobile number" required></label>
                <label class="admin-user-field">Password<input name="password" type="password" autocomplete="new-password" minlength="6" maxlength="20" required><small>6–20 characters, with uppercase, lowercase, a number, and a special character.</small></label>
                <label class="admin-user-field">Confirm password<input name="confirmPassword" type="password" autocomplete="new-password" minlength="6" maxlength="20" required></label>
            </div>
            <p id="add-user-status" class="admin-user-status" role="status" aria-live="polite"></p>
            <footer class="admin-user-dialog-actions">
                <button type="button" class="admin-user-cancel">Cancel</button>
                <button type="submit" class="admin-add-user-button">Save user</button>
            </footer>
        </form>`;
    document.body.append(dialog);

    const form = dialog.querySelector('form');
    const roleSelect = form.elements.role;
    const status = dialog.querySelector('#add-user-status');
    const saveButton = form.querySelector('[type="submit"]');
    let saving = false;
    let editingAccount = null;
    const updateRole = () => {
        const role = roleSelect.value;
        dialog.querySelectorAll('[data-roles]').forEach((fields) => {
            const active = fields.dataset.roles.split(' ').includes(role);
            fields.hidden = !active;
            fields.disabled = !active;
        });
        dialog.querySelector('#registration-form-title').textContent = {
            student: 'Student Registration Form', faculty: 'Faculty Registration Form',
            'event-coordinator': 'Event Coordinator Registration Form'
        }[role];
        dialog.querySelector('#user-name-label').textContent = role === 'student' ? 'Student name' : role === 'faculty' ? 'Faculty name' : 'Name';
        dialog.querySelector('#user-gender-label').textContent = role === 'event-coordinator' ? 'Gender' : 'Gender (optional)';
        form.elements.gender.required = role === 'event-coordinator';
        status.textContent = '';
    };
    roleSelect.addEventListener('change', updateRole);
    const openForm = (account = null) => {
        editingAccount = account;
        form.reset();
        roleSelect.disabled = false;
        if (account) roleSelect.value = account.role;
        updateRole();
        if (account) {
            for (const key of ['name', 'email', 'mobileNumber', 'collegeName', 'department', 'gender', 'semester', 'enrollmentNumber', 'instituteName']) {
                form.elements[key].value = key === 'semester' ? String(account[key] || '').replace(/^semester\s*/i, '').trim() : account[key] || '';
            }
        }
        roleSelect.disabled = Boolean(account);
        form.elements.password.required = !account;
        form.elements.confirmPassword.required = !account;
        form.elements.picture.required = !account;
        form.elements.password.placeholder = account ? 'Leave blank to keep current password' : '';
        form.elements.confirmPassword.placeholder = account ? 'Repeat new password, if changing' : '';
        dialog.querySelector('#add-user-title').textContent = account ? 'Modify account' : 'Add user';
        dialog.querySelector('.admin-dialog-description').textContent = account ? 'Update this account. Leave password and picture empty to keep the current ones.' : 'Choose an account type and enter their registration details.';
        saveButton.textContent = account ? 'Save changes' : 'Save user';
        dialog.showModal();
    };
    openButton.addEventListener('click', () => openForm());
    const close = () => { if (!saving) dialog.close(); };
    dialog.querySelector('.admin-dialog-close').addEventListener('click', close);
    dialog.querySelector('.admin-user-cancel').addEventListener('click', close);
    dialog.addEventListener('cancel', (event) => { if (saving) event.preventDefault(); });
    form.elements.mobileNumber.addEventListener('input', (event) => {
        event.target.value = event.target.value.replace(/\D/g, '').slice(0, 10);
    });
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (saving || !form.reportValidity()) return;
        if ((!editingAccount || form.elements.password.value) && !/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{6,20}$/.test(form.elements.password.value)) {
            status.textContent = 'Use 6–20 characters with uppercase, lowercase, a number, and a special character.';
            form.elements.password.focus();
            return;
        }
        if (form.elements.password.value !== form.elements.confirmPassword.value) {
            status.textContent = 'Passwords do not match.';
            form.elements.confirmPassword.focus();
            return;
        }
        const payload = Object.fromEntries(new FormData(form));
        payload.role = roleSelect.value;
        if (editingAccount) payload.userId = editingAccount.id;
        const picture = payload.picture;
        delete payload.picture;
        const hasPicture = picture && picture.size > 0;
        if (roleSelect.value === 'student' && ((!editingAccount && !hasPicture) || (hasPicture && (picture.size > 2 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp'].includes(picture.type))))) {
            status.textContent = 'Choose a PNG, JPEG, or WebP student picture up to 2 MB.';
            return;
        }
        saving = true;
        const enabledFields = [...form.querySelectorAll('input, select, button')].filter(field => !field.matches(':disabled'));
        enabledFields.forEach(field => { field.disabled = true; });
        status.textContent = 'Saving user…';
        saveButton.textContent = 'Saving…';
        try {
            if (hasPicture) payload.picture = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = () => reject(new Error('The picture could not be read. Choose it again.'));
                reader.readAsDataURL(picture);
            });
            const response = await fetch('/admin-dashboard/users', {
                method: editingAccount ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
            });
            const result = await response.json();
            if (!response.ok || !result.success) throw new Error(result.message || 'The account could not be saved.');
            status.textContent = result.message;
            try { sessionStorage.setItem('admin-user-added', result.message); } catch (_) { /* Success also remains visible in the form. */ }
            window.location.reload();
        } catch (error) {
            status.textContent = error.message || 'Unable to save. Check your connection and try again.';
            saving = false;
            enabledFields.forEach(field => { field.disabled = false; });
            saveButton.textContent = editingAccount ? 'Save changes' : 'Save user';
        }
    });

    const mobileSearch = document.querySelector('#account-mobile-search');
    const editSelected = document.querySelector('#edit-selected-account');
    const deleteSelected = document.querySelector('#delete-selected-account');
    const selectedLabel = document.querySelector('#selected-account-label');
    const actionStatus = document.querySelector('#account-action-status');
    const rows = [...document.querySelectorAll('.admin-account-row')];
    let selectedRow = null;
    let deleting = false;
    const selectRow = (row) => {
        selectedRow = row;
        rows.forEach(item => {
            item.classList.toggle('admin-account-selected', item === row);
            item.querySelector('[name="selected-account"]').checked = item === row;
        });
        if (editSelected) editSelected.disabled = !row || deleting;
        if (deleteSelected) deleteSelected.disabled = !row || deleting;
        if (selectedLabel) {
            const account = row ? JSON.parse(row.dataset.account) : null;
            selectedLabel.textContent = account ? `Selected: ${account.name || account.email} · ${account.mobileNumber || 'No mobile number'}` : 'Select an account to modify or delete.';
        }
    };
    const filterAccounts = () => {
        const digits = mobileSearch.value.replace(/\D/g, '');
        rows.forEach(row => { row.hidden = !row.dataset.mobile.replace(/\D/g, '').includes(digits); });
        if (selectedRow?.hidden) selectRow(null);
        let matches = 0;
        document.querySelectorAll('[data-account-group]').forEach(group => {
            const visibleCount = [...group.querySelectorAll('.admin-account-row')].filter(row => !row.hidden).length;
            matches += visibleCount;
            const count = group.querySelector('.admin-table-match-count');
            if (count) count.textContent = visibleCount;
            const empty = group.querySelector('.admin-account-empty');
            if (empty) empty.hidden = visibleCount > 0;
        });
        document.querySelector('#account-search-status').textContent = `${matches} ${digits ? 'matching' : 'registered'} account${matches === 1 ? '' : 's'}.`;
    };
    const deleteAccount = async (row) => {
        if (!row || deleting || saving) return;
        const account = JSON.parse(row.dataset.account);
        if (!window.confirm(`Delete ${account.name || account.email}${account.mobileNumber ? ` (${account.mobileNumber})` : ''}? This permanently removes the account.`)) return;
        deleting = true;
        const actionButtons = [...document.querySelectorAll('#edit-selected-account, #delete-selected-account, #add-user-button')];
        actionButtons.forEach(button => { button.disabled = true; });
        actionStatus.textContent = 'Deleting account…';
        try {
            const response = await fetch('/admin-dashboard/users', {
                method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: account.id, role: account.role })
            });
            const result = await response.json();
            if (!response.ok || !result.success) throw new Error(result.message || 'The account could not be deleted.');
            try { sessionStorage.setItem('admin-user-added', result.message); } catch (_) { /* Deletion succeeded even if storage is disabled. */ }
            window.location.reload();
        } catch (error) {
            actionStatus.textContent = error.message || 'Unable to delete. Check your connection and try again.';
            deleting = false;
            actionButtons.forEach(button => { button.disabled = false; });
            selectRow(selectedRow);
        }
    };
    rows.forEach(row => {
        row.querySelector('[name="selected-account"]').addEventListener('change', () => selectRow(row));
    });
    editSelected?.addEventListener('click', () => { if (selectedRow && !deleting) openForm(JSON.parse(selectedRow.dataset.account)); });
    deleteSelected?.addEventListener('click', () => deleteAccount(selectedRow));
    if (mobileSearch) {
        mobileSearch.addEventListener('input', filterAccounts);
        document.querySelector('#clear-account-search').addEventListener('click', () => { mobileSearch.value = ''; filterAccounts(); mobileSearch.focus(); });
        filterAccounts();
    }
    try {
        const message = sessionStorage.getItem('admin-user-added');
        if (message) {
            sessionStorage.removeItem('admin-user-added');
            const notice = document.createElement('p');
            notice.className = 'admin-user-success';
            notice.setAttribute('role', 'status');
            notice.textContent = message;
            document.querySelector('.admin-overview-toolbar').after(notice);
        }
    } catch (_) { /* The form works when session storage is unavailable. */ }
})();
