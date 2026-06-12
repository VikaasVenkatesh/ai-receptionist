'use strict';

/**
 * GoHighLevel (LeadConnector) API v2 adapter.
 *
 * Thin wrappers over the REST endpoints we need for the end-of-call sync.
 * All functions throw on non-2xx so the orchestrator can decide what to do;
 * the orchestrator itself never lets these crash the call flow.
 */

const BASE = 'https://services.leadconnectorhq.com';
const VERSION = '2021-07-28';

function headers() {
  return {
    Authorization: `Bearer ${process.env.GHL_API_KEY}`,
    Version: VERSION,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

/**
 * Normalize a phone number to E.164 (US-biased). Returns null if not parseable.
 * GHL requires E.164 — anything else gets silently rejected or mis-stored.
 */
function toE164(phone) {
  if (!phone) return null;
  if (String(phone).startsWith('+')) return phone;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

async function upsertContact({ phone, firstName, lastName, email }) {
  const normalizedPhone = toE164(phone);
  if (!normalizedPhone) throw new Error(`Invalid phone: ${phone}`);

  const body = {
    locationId: process.env.GHL_LOCATION_ID,
    phone: normalizedPhone,
  };
  if (firstName) body.firstName = firstName;
  if (lastName) body.lastName = lastName;
  if (email) body.email = email;

  const res = await fetch(`${BASE}/contacts/upsert`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
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

  const res = await fetch(`${BASE}/contacts/${contactId}`, {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify({ customFields: arr }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`setCustomFields failed: ${res.status} ${text}`);
  }
  return res.json();
}

async function addNote(contactId, body) {
  const res = await fetch(`${BASE}/contacts/${contactId}/notes`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`addNote failed: ${res.status} ${text}`);
  }
  return res.json();
}

async function addTags(contactId, tags) {
  if (!tags || tags.length === 0) return;
  const res = await fetch(`${BASE}/contacts/${contactId}/tags`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ tags }),
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
    pipelineId,
    pipelineStageId: stageId,
    contactId,
    name,
    status,
    monetaryValue,
  };
  // NOTE: GHL requires the trailing slash here — POST /opportunities (no slash)
  // returns 404, while /opportunities/ works. Verified against the live API.
  const res = await fetch(`${BASE}/opportunities/`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`createOpportunity failed: ${res.status} ${text}`);
  }
  return res.json();
}

module.exports = {
  toE164,
  upsertContact,
  setCustomFields,
  addNote,
  addTags,
  createOpportunity,
};
