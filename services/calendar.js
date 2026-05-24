'use strict';

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { CALENDAR_CONFIG } = require('../config/calendar-config');

let _calendar = null;

function getCalendar() {
  if (_calendar) return _calendar;

  const keyPath = path.resolve(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH);

  if (!fs.existsSync(keyPath)) {
    throw new Error(`Google service account key not found at: ${keyPath}`);
  }

  const key = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
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
 * @param {{ name: string, date: string, time: string, duration: number, reason: string }} details
 * @returns {{ success: boolean, message: string }}
 */
async function bookAppointment({ name, date, time, duration, reason }) {
  try {
    const calendar = getCalendar();
    const durationMins = duration || CALENDAR_CONFIG.defaultDurationMinutes;

    // Build ISO datetime strings
    const startDt = new Date(`${date}T${time}:00`);
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

    await calendar.events.insert({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      requestBody: {
        summary: `Appointment – ${name}`,
        description: `Reason: ${reason}\nBooked by AI Receptionist`,
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
