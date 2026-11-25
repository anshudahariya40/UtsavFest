Run the login page and mobile password reset locally
==================================================

1. Install dependencies with `npm install` in the project folder and `npm install` in `Controller` if needed.
2. Start your local MongoDB service.
3. Set `HTTPSMS_API_KEY`, `HTTPSMS_FROM`, and `HTTPSMS_COUNTRY_CODE` in the root `.env` file (see `.env.example`).
4. Install the httpSMS Android app on the sender phone and sign into the account associated with your API key. Keep the app running, with internet access, SMS permission, and an active SIM that can send SMS.
5. Run `npm start` in the project folder. Open the URL printed in the terminal (normally `http://localhost:3000/login`).

VS Code Live Server serves static files. This project's login page is an EJS template, and SMS requests, OTP verification, and database updates require the Node server. Open the Node server URL instead of opening `View/auth.html` with Live Server. No public website hosting is required; the computer needs internet access to call httpSMS.

Choose Student or Faculty, click Forgot password, and enter the registered 10-digit mobile number. Enter the 7-character alphanumeric OTP received by SMS; a verified OTP opens the password update step in the popup. The new password must meet the same 6–20 character rules as registration.

OTP requests expire after 10 minutes and permit five incorrect attempts. Verified resets expire after five minutes and can be used once. Requesting another OTP invalidates the earlier request. Requests are limited to five per 15 minutes, with a 60-second cooldown. Pending OTP requests are held in server memory; restarting the server requires requesting a new OTP. Password recovery requires MongoDB. Passwords are hashed and saved to the exact student or faculty record selected during the OTP request, then read back and verified before success is shown. The login form automatically selects that account's email address and role.

An accepted httpSMS API request queues the SMS for the Android phone; delivery still depends on the phone and mobile network. Check the httpSMS dashboard if a message does not arrive. API errors show a failure in the popup, and the failed OTP cannot be used. The API key and OTP are never returned to the browser.

Provider documentation: https://docs.httpsms.com/
