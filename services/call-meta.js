'use strict';

/**
 * Per-call metadata, kept in memory keyed by Twilio CallSid.
 *
 * call:started emits the caller's From/To numbers and we need them again at
 * end-of-call (for the GHL sync), long after the original event has passed.
 * This is the small store that holds onto them, plus any bookings made.
 */

const meta = new Map(); // callSid -> { from, to, startedAt, bookings: [] }

function setMeta(callSid, data) {
  const existing = meta.get(callSid) || { bookings: [] };
  meta.set(callSid, { ...existing, ...data });
}

function getMeta(callSid) {
  return meta.get(callSid);
}

function recordBooking(callSid, booking) {
  const m = meta.get(callSid);
  if (m) m.bookings.push({ ...booking, at: Date.now() });
}

function clearMeta(callSid) {
  meta.delete(callSid);
}

module.exports = { setMeta, getMeta, recordBooking, clearMeta };
