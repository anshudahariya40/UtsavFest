const crypto = require('node:crypto');

const OTP_LIFETIME = 10 * 60 * 1000;
const RESET_LIFETIME = 5 * 60 * 1000;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

function generateOtp() {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let otp;
    do {
        otp = Array.from({ length: 7 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
    } while (!/[A-Z]/.test(otp) || !/[0-9]/.test(otp));
    return otp;
}

function createPasswordResetService({ findAccount, updatePassword, deliverOtp, now = Date.now }) {
    const challenges = new Map();
    const limits = new Map();
    function prune() {
        for (const [key, value] of challenges) if (value.expiresAt <= now()) challenges.delete(key);
        for (const [key, value] of limits) if (value.expiresAt <= now()) limits.delete(key);
    }
    function allow(key) {
        const current = limits.get(key) || { count: 0, last: -Infinity, expiresAt: now() + 15 * 60 * 1000 };
        if (current.count >= 5 || now() - current.last < 60000) return false;
        current.count++;
        current.last = now();
        limits.set(key, current);
        return true;
    }
    return {
        async request({ mobileNumber, role }, ip) {
            prune();
            const mobile = String(mobileNumber || '').replace(/\D/g, '');
            if (!/^\d{10}$/.test(mobile) || !['student', 'faculty'].includes(role)) {
                return { success: false, message: 'Choose your account type and enter your registered 10-digit mobile number.' };
            }
            const account = await findAccount(mobile, role);
            if (!account) {
                return { success: false, message: 'No account is registered with this mobile number for the selected account type.' };
            }
            if (!allow(`ip:${ip}`) || !allow(`account:${role}:${mobile}`)) {
                return { success: false, message: 'Please wait before requesting another OTP. Up to five requests are allowed in 15 minutes.' };
            }
            const requestId = crypto.randomBytes(32).toString('hex');
            const otp = generateOtp();
            // Replace earlier requests, including any already verified password reset.
            for (const [key, value] of challenges) if (value.mobile === mobile && value.role === role) challenges.delete(key);
            const challenge = { mobile, role, account, otpHash: digest(otp), attempts: 0, expiresAt: now() + OTP_LIFETIME };
            challenges.set(requestId, challenge);
            try {
                if (account) await deliverOtp({ mobileNumber: account.mobileNumber, role, otp });
            } catch (error) {
                challenges.delete(requestId);
                throw error;
            }
            return { success: true, requestId, message: 'If this mobile number matches your account, an OTP has been requested by SMS. Enter it within 10 minutes.' };
        },
        verify({ requestId, otp }) {
            prune();
            const challenge = challenges.get(requestId);
            const invalid = { success: false, message: 'OTP is incorrect or expired. Request a new OTP if needed.' };
            if (!challenge || challenge.resetHash) return invalid;
            challenge.attempts++;
            const valid = challenge.account && typeof otp === 'string' && /^[A-Za-z0-9]{7}$/.test(otp) &&
                crypto.timingSafeEqual(Buffer.from(digest(otp.toUpperCase()), 'hex'), Buffer.from(challenge.otpHash, 'hex'));
            if (!valid) {
                if (challenge.attempts >= 5) challenges.delete(requestId);
                return invalid;
            }
            const resetToken = crypto.randomBytes(32).toString('hex');
            challenge.resetHash = digest(resetToken);
            delete challenge.otpHash;
            challenge.expiresAt = now() + RESET_LIFETIME;
            return { success: true, resetToken, message: 'OTP verified. Set your new password.' };
        },
        async reset({ requestId, resetToken, password, confirmPassword }) {
            prune();
            const challenge = challenges.get(requestId);
            if (!challenge || !challenge.resetHash || typeof resetToken !== 'string' || resetToken.length !== 64 ||
                !crypto.timingSafeEqual(Buffer.from(digest(resetToken), 'hex'), Buffer.from(challenge.resetHash, 'hex'))) {
                return { success: false, message: 'Password reset has expired or is invalid. Request a new OTP.' };
            }
            if (typeof password !== 'string' || password !== confirmPassword) {
                return { success: false, message: 'Passwords do not match.' };
            }
            if (!/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{6,20}$/.test(password)) {
                return { success: false, message: 'Use 6–20 characters with uppercase and lowercase letters, a number, and a special character.' };
            }
            if (challenge.busy) return { success: false, message: 'Your password update is already in progress.' };
            challenge.busy = true;
            try {
                const login = await updatePassword(challenge.account, password);
                challenges.delete(requestId);
                return { success: true, login, message: 'Password saved and verified. Log in with your new password.' };
            } finally {
                challenge.busy = false;
            }
        }
    };
}

module.exports = { generateOtp, createPasswordResetService };
