'use strict';

const { google } = require('googleapis');
const { CALENDAR_CONFIG } = require('../config/calendar-config');

/**
 * Patient emails (booking confirmation + day-before reminder), sent through the
 * Gmail API as GMAIL_SENDER.
 *
 * Railway blocks outbound SMTP on the Hobby plan, so nodemailer/app passwords
 * can't work here; the Gmail API goes over HTTPS instead. Auth is an OAuth
 * refresh token for the sending account — generate it with scripts/gmail-auth.js.
 */

const CLINIC = {
  name: 'Han Kim, DC',
  address: '151 87th Street, Suite 1, Daly City, CA 94015',
  phone: '(650) 731-4663',
};

let _gmail = null;

function isEnabled() {
  return Boolean(
    process.env.GMAIL_CLIENT_ID &&
    process.env.GMAIL_CLIENT_SECRET &&
    process.env.GMAIL_REFRESH_TOKEN &&
    process.env.GMAIL_SENDER
  );
}

function getGmail() {
  if (_gmail) return _gmail;
  const auth = new google.auth.OAuth2(process.env.GMAIL_CLIENT_ID, process.env.GMAIL_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  _gmail = google.gmail({ version: 'v1', auth });
  return _gmail;
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/** "Tuesday, June 23rd at 2:00 PM" in the clinic timezone. */
function formatWhen(isoOrDate) {
  const d = new Date(isoOrDate);
  const tz = CALENDAR_CONFIG.timezone;
  const weekday = d.toLocaleDateString('en-US', { weekday: 'long', timeZone: tz });
  const month = d.toLocaleDateString('en-US', { month: 'long', timeZone: tz });
  const day = Number(d.toLocaleDateString('en-US', { day: 'numeric', timeZone: tz }));
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz });
  return `${weekday}, ${month} ${ordinal(day)} at ${time}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function encodeHeader(value) {
  return /^[\x20-\x7E]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value).toString('base64')}?=`;
}

async function sendEmail({ to, subject, text, html }) {
  const boundary = `b_${Date.now().toString(36)}`;
  const mime = [
    `From: "${CLINIC.name}" <${process.env.GMAIL_SENDER}>`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(text).toString('base64'),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(html).toString('base64'),
    `--${boundary}--`,
  ].join('\r\n');

  const raw = Buffer.from(mime).toString('base64url');
  const res = await getGmail().users.messages.send({ userId: 'me', requestBody: { raw } });
  return res.data.id;
}

function layout(heading, bodyHtml) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1f2937">
  <h2 style="color:#1d4ed8;margin-bottom:8px">${heading}</h2>
  ${bodyHtml}
  <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">
  <p style="font-size:13px;color:#6b7280;margin:0">${CLINIC.name}<br>${CLINIC.address}<br>${CLINIC.phone}</p>
</div>`;
}

async function sendBookingConfirmation({ name, email, startTime, reason }) {
  if (!isEnabled() || !email || !startTime) return null;
  const when = formatWhen(startTime);
  const first = String(name || '').split(/\s+/)[0] || 'there';

  const text =
    `Hi ${first},\n\n` +
    `Your appointment with ${CLINIC.name} is confirmed for ${when}.\n` +
    (reason ? `Reason for visit: ${reason}\n` : '') +
    `\nLocation: ${CLINIC.address}\n` +
    `We'll send you a reminder the day before. To reschedule or cancel, call us at ${CLINIC.phone}.\n\n` +
    `See you soon,\n${CLINIC.name}`;

  const html = layout('Your appointment is confirmed', `
  <p>Hi ${escapeHtml(first)},</p>
  <p>Your appointment with <strong>${CLINIC.name}</strong> is confirmed for:</p>
  <p style="font-size:18px;font-weight:bold;margin:12px 0">${escapeHtml(when)}</p>
  ${reason ? `<p>Reason for visit: ${escapeHtml(reason)}</p>` : ''}
  <p>We'll send you a reminder the day before. To reschedule or cancel, call us at ${CLINIC.phone}.</p>`);

  return sendEmail({ to: email, subject: `Appointment confirmed — ${when}`, text, html });
}

async function sendAppointmentReminder({ name, email, startTime }) {
  if (!isEnabled() || !email || !startTime) return null;
  const when = formatWhen(startTime);
  const first = String(name || '').split(/\s+/)[0] || 'there';

  const text =
    `Hi ${first},\n\n` +
    `This is a reminder that your appointment with ${CLINIC.name} is tomorrow, ${when}.\n\n` +
    `Location: ${CLINIC.address}\n` +
    `Need to reschedule? Call us at ${CLINIC.phone}.\n\n` +
    `See you tomorrow,\n${CLINIC.name}`;

  const html = layout('Your appointment is tomorrow', `
  <p>Hi ${escapeHtml(first)},</p>
  <p>This is a reminder that your appointment with <strong>${CLINIC.name}</strong> is tomorrow:</p>
  <p style="font-size:18px;font-weight:bold;margin:12px 0">${escapeHtml(when)}</p>
  <p>Need to reschedule? Call us at ${CLINIC.phone}.</p>`);

  return sendEmail({ to: email, subject: `Reminder: your appointment is tomorrow, ${when}`, text, html });
}

module.exports = { isEnabled, sendBookingConfirmation, sendAppointmentReminder, formatWhen };
