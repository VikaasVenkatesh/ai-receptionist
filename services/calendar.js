'use strict';

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { CALENDAR_CONFIG } = require('../config/calendar-config');

let _calendar = null;

/**
 * Converts a wall-clock date+time in a given IANA timezone into the correct
 * absolute UTC Date. Without this, `new Date("2025-06-12T14:00:00")` is parsed
 * in the SERVER's timezone (UTC on Railway), so "2 PM" ends up stored as 2 PM
 * UTC instead of 2 PM Pacific. Handles DST automatically via Intl.
 *
 * @param {string} date  - "YYYY-MM-DD"
 * @param {string} time  - "HH:MM"
 * @param {string} timeZone - IANA zone, e.g. "America/Los_Angeles"
 * @returns {Date} the UTC instant for that local wall-clock time
 */
function zonedTimeToUtc(date, time, timeZone) {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  // Treat the wall-clock numbers as if they were UTC, then measure how far off
  // the target timezone is at that instant and correct for it.
  const utcGuess = Date.UTC(y, mo - 1, d, h, mi, 0);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcGuess));
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  let hour = map.hour === '24' ? 0 : Number(map.hour);
  const asSeenInTz = Date.UTC(map.year, map.month - 1, map.day, hour, map.minute, map.second);
  const offset = asSeenInTz - utcGuess;
  return new Date(utcGuess - offset);
}

function getCalendar() {
  if (_calendar) return _calendar;

  let key;

  // Prefer env var (Railway/production) — paste the full JSON as the value
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } else {
    // Fall back to file path (local dev)
    const keyPath = path.resolve(
      process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './config/google-service-account.json'
    );
    if (!fs.existsSync(keyPath)) {
      throw new Error(
        'Google service account not configured. Set GOOGLE_SERVICE_ACCOUNT_JSON env var or provide the key file.'
      );
    }
    key = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
  }

  const auth = new google.auth.JWT(
    key.client_email,
    null,
    key.private_key,
    ['https://www.googleapis.com/auth/calendar']
  );

  _calendar = google.calendar({ version: 'v3', auth });
  return _calendar;
}

/**
 * Checks whether the requested slot is already taken.
 * Returns true if the slot is free.
 */
async function isSlotAvailable(startISO, endISO) {
  const calendar = getCalendar();
  const res = await calendar.events.list({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    timeMin: startISO,
    timeMax: endISO,
    singleEvents: true,
  });
  return (res.data.items ?? []).length === 0;
}

/**
 * Books an appointment on Google Calendar.
 *
 * @param {{ name: string, email: string, date: string, time: string, duration: number, reason: string }} details
 * @returns {{ success: boolean, message: string }}
 */
async function bookAppointment({ name, email, date, time, duration, reason }) {
  try {
    const calendar = getCalendar();
    const durationMins = duration || CALENDAR_CONFIG.defaultDurationMinutes;

    // Build ISO datetime strings — interpret date/time in the clinic's timezone
    const startDt = zonedTimeToUtc(date, time, CALENDAR_CONFIG.timezone);
    const endDt = new Date(startDt.getTime() + durationMins * 60 * 1000);

    const startISO = startDt.toISOString();
    const endISO = endDt.toISOString();

    // Conflict check
    const available = await isSlotAvailable(startISO, endISO);
    if (!available) {
      return {
        success: false,
        message: `Sorry, that time slot is already taken. Please choose a different time.`,
      };
    }

    const description =
      `Reason: ${reason}\n` +
      (email ? `Email: ${email}\n` : '') +
      `Booked by AI Receptionist`;

    const inserted = await calendar.events.insert({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      requestBody: {
        summary: `Appointment – ${name}`,
        description,
        start: { dateTime: startISO, timeZone: CALENDAR_CONFIG.timezone },
        end: { dateTime: endISO, timeZone: CALENDAR_CONFIG.timezone },
      },
    });

    const friendly = startDt.toLocaleString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: CALENDAR_CONFIG.timezone,
    });

    return {
      success: true,
      message: `Your appointment has been confirmed for ${friendly}.`,
      // ISO 8601 instants for downstream consumers (e.g. the GHL appointment dual-write)
      startTime: startISO,
      endTime: endISO,
      googleEventId: inserted.data.id,
    };
  } catch (err) {
    console.error('[Calendar] Booking error:', err.message);
    return {
      success: false,
      message: `I wasn't able to book the appointment right now. Please call back and we'll get it sorted.`,
    };
  }
}

module.exports = { bookAppointment };
