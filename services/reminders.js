'use strict';

const { listUpcomingAppointments, markReminderSent } = require('./calendar');
const email = require('./email');

/**
 * Day-before reminder emails. Every 15 minutes, finds bot-booked appointments
 * starting within the next 24 hours that haven't been reminded yet, emails the
 * patient, and flags the calendar event so no reminder goes out twice — even
 * across restarts, since the flag lives on the event itself.
 */

const CHECK_INTERVAL_MS = 15 * 60 * 1000;
const WINDOW_HOURS = 24;

async function runReminderCheck() {
  if (!email.isEnabled()) return;
  let events;
  try {
    events = await listUpcomingAppointments(WINDOW_HOURS);
  } catch (err) {
    console.error('[Reminders] Could not list appointments:', err.message);
    return;
  }

  for (const event of events) {
    const props = event.extendedProperties.private;
    if (props.reminderSent === 'true') continue;

    const start = new Date(event.start.dateTime);
    // Booked less than a day ahead: the confirmation email already covers it,
    // so an immediate "your appointment is tomorrow" would be a duplicate.
    if (event.created && start - new Date(event.created) < WINDOW_HOURS * 3600 * 1000) continue;

    try {
      await email.sendAppointmentReminder({
        name: props.patientName,
        email: props.patientEmail,
        startTime: event.start.dateTime,
      });
      await markReminderSent(event);
      console.log(`[Reminders] Sent reminder for event ${event.id}`);
    } catch (err) {
      console.error(`[Reminders] Failed for event ${event.id}:`, err.message);
    }
  }
}

function startReminderLoop() {
  if (!email.isEnabled()) return;
  runReminderCheck();
  setInterval(runReminderCheck, CHECK_INTERVAL_MS).unref();
}

module.exports = { startReminderLoop, runReminderCheck };
