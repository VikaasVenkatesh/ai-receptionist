'use strict';

/**
 * GoHighLevel (LeadConnector) API v2 adapter.
 *
 * Thin wrappers over the REST endpoints we need for the end-of-call sync, with
 * automatic retry/backoff on 429s and transient 5xx. All functions throw on a
 * non-2xx the retries couldn't clear; the orchestrator decides what to do and
 * never lets these crash the call flow.
 */

const BASE = 'https://services.leadconnectorhq.com';
const VERSION = '2021-07-28';

// Only tags we explicitly know about — GHL auto-creates any tag you send, so we
// filter to prevent typos from spawning phantom tags that no workflow references.
const VALID_TAGS = new Set([
  'ai-call-received', 'ai-call-booked', 'ai-call-no-booking',
  'ai-call-callback-requested', 'ai-call-after-hours', 'ai-call-spam',
]);

function headers() {
  return {
    Authorization: `Bearer ${process.env.GHL_API_KEY}`,
    Version: VERSION,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

/** fetch wrapper with exponential backoff on 429 (rate limit) and transient 5xx. */
async function ghlFetch(url, options, attempt = 1) {
  const res = await fetch(url, options);
  if ((res.status === 429 || (res.status >= 500 && res.status < 600)) && attempt <= 3) {
    const backoffMs = (res.status === 429 ? 1000 : 500) * Math.pow(2, attempt);
    console.warn(`[ghl] ${res.status} on ${url}, retrying in ${backoffMs}ms (attempt ${attempt}/3)`);
    await new Promise((r) => setTimeout(r, backoffMs));
    return ghlFetch(url, options, attempt + 1);
  }
  return res;
}

/**
 * Normalize a phone number to E.164. US-biased but best-effort for international.
 * Returns null if not parseable. GHL requires E.164.
 */
function toE164(phone) {
  if (!phone) return null;
  const s = String(phone).trim();
  if (/^\+[1-9]\d{6,14}$/.test(s)) return s; // already E.164
  const digits = s.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length >= 7 && digits.length <= 15) return `+${digits}`; // other intl, best effort
  return null;
}

async function upsertContact({ phone, firstName, lastName, email }) {
  const normalizedPhone = toE164(phone);
  if (!normalizedPhone) throw new Error(`Invalid phone: ${phone}`);

  const body = { locationId: process.env.GHL_LOCATION_ID, phone: normalizedPhone };
  if (firstName) body.firstName = firstName;
  if (lastName) body.lastName = lastName;
  if (email) body.email = email;

  const res = await ghlFetch(`${BASE}/contacts/upsert`, {
    method: 'POST', headers: headers(), body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`upsertContact failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  return data.contact?.id || data.id;
}

async function setCustomFields(contactId, customFields) {
  const arr = Object.entries(customFields)
    .filter(([_, v]) => v !== undefined && v !== null && v !== '')
    .map(([id, field_value]) => ({ id, field_value }));
  if (arr.length === 0) return;

  const res = await ghlFetch(`${BASE}/contacts/${contactId}`, {
    method: 'PUT', headers: headers(), body: JSON.stringify({ customFields: arr }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`setCustomFields failed: ${res.status} ${text}`);
  }
  return res.json();
}

async function addNote(contactId, body) {
  const res = await ghlFetch(`${BASE}/contacts/${contactId}/notes`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`addNote failed: ${res.status} ${text}`);
  }
  return res.json();
}

async function addTags(contactId, tags) {
  const valid = tags.filter((t) => VALID_TAGS.has(t));
  const invalid = tags.filter((t) => !VALID_TAGS.has(t));
  if (invalid.length) console.warn(`[ghl] Skipping unknown tags: ${invalid.join(', ')}`);
  if (!valid.length) return;

  const res = await ghlFetch(`${BASE}/contacts/${contactId}/tags`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ tags: valid }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`addTags failed: ${res.status} ${text}`);
  }
  return res.json();
}

async function createOpportunity({ contactId, pipelineId, stageId, name, monetaryValue = 0, status = 'open' }) {
  const body = {
    locationId: process.env.GHL_LOCATION_ID,
    pipelineId, pipelineStageId: stageId,
    contactId, name, status, monetaryValue,
  };
  // NOTE: trailing slash is required — POST /opportunities (no slash) 404s.
  // Verified against the live API.
  const res = await ghlFetch(`${BASE}/opportunities/`, {
    method: 'POST', headers: headers(), body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`createOpportunity failed: ${res.status} ${text}`);
  }
  return res.json();
}

async function createAppointment({ contactId, calendarId, startTime, endTime, title, notes }) {
  const body = {
    locationId: process.env.GHL_LOCATION_ID,
    calendarId, contactId,
    startTime, endTime, title,
    appointmentStatus: 'confirmed',
    notes: notes || '',
    // The GHL calendar has no configured availability (it's a mirror, not the
    // booking source of truth — Google Calendar already enforced the slot).
    // Without this, GHL rejects every slot with "slot no longer available".
    ignoreFreeSlotValidation: true,
  };
  const res = await ghlFetch(`${BASE}/calendars/events/appointments`, {
    method: 'POST', headers: headers(), body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`createAppointment failed: ${res.status} ${text}`);
  }
  return res.json();
}

module.exports = {
  toE164, ghlFetch, upsertContact, setCustomFields, addNote, addTags,
  createOpportunity, createAppointment,
};
