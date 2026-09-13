'use strict';

/**
 * One-time helper: get a Gmail API refresh token for the sending account.
 *
 *   GMAIL_CLIENT_ID=... GMAIL_CLIENT_SECRET=... node scripts/gmail-auth.js
 *
 * Opens Google sign-in in your browser. Sign in AS THE SENDING ACCOUNT, approve
 * "Send email on your behalf", and the refresh token is printed here. The OAuth
 * client must be a "Desktop app" client (loopback redirects are allowed).
 */

const http = require('http');
const { exec } = require('child_process');
const { google } = require('googleapis');

const PORT = 53682;
const REDIRECT = `http://localhost:${PORT}`;
const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET } = process.env;

if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET) {
  console.error('Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET first.');
  process.exit(1);
}

const oauth = new google.auth.OAuth2(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, REDIRECT);
const url = oauth.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent', // forces a refresh token even if previously approved
  scope: ['https://www.googleapis.com/auth/gmail.send'],
});

const server = http.createServer(async (req, res) => {
  const code = new URL(req.url, REDIRECT).searchParams.get('code');
  if (!code) { res.end('No code in request.'); return; }
  try {
    const { tokens } = await oauth.getToken(code);
    res.end('Done — you can close this tab and return to the terminal.');
    console.log('\nGMAIL_REFRESH_TOKEN=' + tokens.refresh_token + '\n');
  } catch (err) {
    res.end('Token exchange failed: ' + err.message);
    console.error('Token exchange failed:', err.message);
  }
  server.close();
});

server.listen(PORT, () => {
  console.log('Opening Google sign-in. If it does not open, visit:\n\n' + url + '\n');
  exec(`open "${url}"`);
});
