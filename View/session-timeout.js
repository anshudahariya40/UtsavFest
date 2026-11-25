(() => {
    const idleTimeout = 2 * 60 * 1000;
    const heartbeatInterval = 15 * 1000;
    let lastActivityAt = Date.now();
    let lastHeartbeatAt = 0;
    let inactivityTimer;

    const logoutForInactivity = () => {
        window.location.replace('/logout?reason=inactive');
    };

    const scheduleLogout = () => {
        clearTimeout(inactivityTimer);
        const remaining = idleTimeout - (Date.now() - lastActivityAt);
        inactivityTimer = setTimeout(logoutForInactivity, Math.max(remaining, 0));
    };

    const recordActivity = () => {
        lastActivityAt = Date.now();
        scheduleLogout();

        if (lastActivityAt - lastHeartbeatAt < heartbeatInterval) {
            return;
        }
        lastHeartbeatAt = lastActivityAt;
        fetch('/session-activity', {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store'
        }).then((response) => {
            if (response.status === 401 || response.status === 403) {
                window.location.replace('/login');
            } else if (!response.ok) {
                console.error('Could not refresh the active login session:', response.status);
            }
        }).catch((error) => {
            console.error('Could not refresh the active login session:', error);
        });
    };

    ['pointerdown', 'pointermove', 'keydown', 'input', 'change', 'scroll', 'touchstart', 'click'].forEach((eventName) => {
        document.addEventListener(eventName, recordActivity, { passive: true });
    });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && Date.now() - lastActivityAt >= idleTimeout) {
            logoutForInactivity();
        }
    });

    scheduleLogout();
})();
