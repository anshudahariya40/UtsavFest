async function sendPasswordOtp({ mobileNumber, otp }, { env = process.env, fetchImpl = fetch } = {}) {
    const apiKey = String(env.HTTPSMS_API_KEY || '').trim();
    const from = String(env.HTTPSMS_FROM || '').trim();
    const countryCode = String(env.HTTPSMS_COUNTRY_CODE || '+91').trim();
    if (!apiKey || !/^\+[1-9]\d{7,14}$/.test(from) || !/^\+[1-9]\d{0,3}$/.test(countryCode)) {
        throw new Error('Configure HTTPSMS_API_KEY, HTTPSMS_FROM, and HTTPSMS_COUNTRY_CODE in .env.');
    }
    const to = `${countryCode}${String(mobileNumber || '').replace(/\D/g, '')}`;
    if (!/^\+[1-9]\d{7,14}$/.test(to) || !/^[A-Z0-9]{7}$/.test(otp)) {
        throw new Error('Invalid SMS recipient or OTP.');
    }
    const response = await fetchImpl('https://api.httpsms.com/v1/messages/send', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
            from, to,
            content: `Your UtsavFest password reset OTP is ${otp}. It expires in 10 minutes. Do not share this code.`
        }),
        signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`httpSMS rejected the SMS request (HTTP ${response.status}).`);
    const result = await response.json();
    if (result.status !== 'success' || !result.data?.id || ['failed', 'expired'].includes(result.data.status)) {
        throw new Error('httpSMS did not accept the SMS request.');
    }
    return { messageId: result.data.id };
}

module.exports = { sendPasswordOtp };
