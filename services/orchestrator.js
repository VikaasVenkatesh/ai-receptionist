'use strict';

const ghl = require('./crm/ghl');
const { analyzeCall, formatTranscript } = require('./call-analysis');
const { writeFailedSync } = require('./failed-sync-ledger');

const processedCalls = new Map();
const DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_NOTE_CHARS = 4800; // GHL note limit is ~5000; leave headroom

const TWILIO_TEST_NUMBERS = new Set([
  '+15005550006', '+15005550001', '+15005550009',
]);

const OUTCOME_TO_TAG = {
  booked: 'ai-call-booked',
  qualified_no_booking: 'ai-call-no-booking',
  callback_requested: 'ai-call-callback-requested',
  after_hours: 'ai-call-after-hours',
  spam: 'ai-call-spam',
  no_qualification: null,
};

function stageForOutcome(outcome) {
  switch (outcome) {
    case 'booked':               return process.env.GHL_STAGE_ID_BOOKED;
    case 'qualified_no_booking': return process.env.GHL_STAGE_ID_QUALIFIED;
    case 'callback_requested':   return process.env.GHL_STAGE_ID_NEW_CALL;
    default:                     return null;
  }
}

function getLatestSuccessfulBooking(meta) {
  if (!meta?.bookings?.length) return null;
  const successful = meta.bookings.filter((b) => b.success);
  if (!successful.length) return null;
  return successful.sort((a, b) => b.at - a.at)[0];
}

function buildNoteBody({ analysis, transcript, status, durationSec }) {
  const header = [
    `AI Receptionist Call — ${new Date().toISOString()}`,
    `Outcome: ${analysis.outcome}`,
    `Intent: ${analysis.intent}`,
    `Duration: ${durationSec}s`,
    `Status: ${status}`,
    ``,
    `Summary: ${analysis.summary}`,
    ``,
    `--- Transcript ---`,
    ``,
  ].join('\n');

  const remainingChars = MAX_NOTE_CHARS - header.length - 100;
  let transcriptSection = transcript;
  if (transcript.length > remainingChars) {
    transcriptSection = transcript.slice(0, remainingChars) +
      '\n\n[Transcript truncated for note length. Full transcript in receptionist logs.]';
  }
  return header + transcriptSection;
}

/** Whether the GHL integration is configured. Lets us deploy safely without a key. */
function isEnabled() {
  return Boolean(process.env.GHL_API_KEY && process.env.GHL_LOCATION_ID);
}

/**
 * End-of-call orchestration. Fire-and-forget; logs but never throws.
 */
async function syncCallToGHL({ callSid, status, conversation, meta }) {
  // Skip entirely if GHL isn't configured — keeps the call flow safe to deploy.
  if (!isEnabled()) return;

  // Idempotency (also guards Twilio status-callback retries)
  if (processedCalls.has(callSid)) {
    console.log(`[orchestrator] Skipping duplicate sync for ${callSid}`);
    return;
  }
  processedCalls.set(callSid, Date.now());

  // Occasional cleanup of old entries
  if (processedCalls.size > 1000) {
    const cutoff = Date.now() - DEDUP_TTL_MS;
    for (const [sid, ts] of processedCalls) {
      if (ts < cutoff) processedCalls.delete(sid);
    }
  }

  // ── Pre-flight filters ──────────────────────────────────────────────────
  if (!meta?.from) {
    console.warn(`[orchestrator] ${callSid}: no caller phone, skipping`);
    processedCalls.delete(callSid);
    return;
  }

  const validatedPhone = ghl.toE164(meta.from);
  if (!validatedPhone) {
    console.warn(`[orchestrator] ${callSid}: anonymous/invalid caller (${meta.from})`);
    await writeFailedSync(callSid, { reason: 'anonymous_caller', meta, conversation });
    processedCalls.delete(callSid);
    return;
  }

  if (TWILIO_TEST_NUMBERS.has(validatedPhone)) {
    console.log(`[orchestrator] Skipping Twilio test number: ${validatedPhone}`);
    return;
  }

  try {
    const transcript = formatTranscript(conversation);
    const durationSec = meta.startedAt ? Math.round((Date.now() - meta.startedAt) / 1000) : 0;

    // 1. Analyze
    const analysis = await analyzeCall(transcript, {
      bookingSucceeded: meta.bookings?.some((b) => b.success) || false,
      callDurationSec: durationSec,
    });
    console.log(`[orchestrator] ${callSid} analysis:`, JSON.stringify(analysis));

    // Spam filter: don't even create a contact for spam calls
    if (analysis.outcome === 'spam') {
      console.log(`[orchestrator] ${callSid}: classified as spam, skipping GHL`);
      await writeFailedSync(callSid, { reason: 'spam', analysis, meta });
      return;
    }

    const booking = getLatestSuccessfulBooking(meta);
    // Email is collected during booking, so prefer the confirmed booking email
    // over whatever the transcript analysis inferred.
    const contactEmail = booking?.email || analysis.email || null;

    // 2. Upsert contact
    const contactId = await ghl.upsertContact({
      phone: validatedPhone,
      firstName: analysis.firstName,
      lastName: analysis.lastName,
      email: contactEmail,
    });

    // 3. Set custom fields
    const fieldsToSet = {
      [process.env.GHL_FIELD_ID_AI_CALL_INTENT]: analysis.intent || '',
      [process.env.GHL_FIELD_ID_AI_CALL_OUTCOME]: analysis.outcome,
      [process.env.GHL_FIELD_ID_AI_CALL_DURATION]: durationSec,
      [process.env.GHL_FIELD_ID_AI_CALL_QUALIFICATION_DATA]: JSON.stringify(analysis.qualificationData || {}),
      [process.env.GHL_FIELD_ID_LAST_AI_CALL_TIMESTAMP]: new Date().toISOString(),
    };
    if (analysis.outcome === 'booked' && booking?.startTime && process.env.GHL_FIELD_ID_AI_NEXT_APPOINTMENT_DATETIME) {
      fieldsToSet[process.env.GHL_FIELD_ID_AI_NEXT_APPOINTMENT_DATETIME] = booking.startTime;
    }
    await ghl.setCustomFields(contactId, fieldsToSet);

    // 4. Note with transcript + summary (truncated to GHL's note limit)
    await ghl.addNote(contactId, buildNoteBody({ analysis, transcript, status, durationSec }));

    // 5. Opportunity (conditional)
    const stageId = stageForOutcome(analysis.outcome);
    if (stageId) {
      await ghl.createOpportunity({
        contactId,
        pipelineId: process.env.GHL_PIPELINE_ID,
        stageId,
        name: `Call ${callSid.slice(-6)} — ${analysis.intent || 'Inbound'}`,
        monetaryValue: 0,
      });
    }

    // 5b. GHL appointment dual-write (only if booked + we have a real time window).
    //     Non-blocking: the appointment is a nice-to-have for reminder workflows.
    if (analysis.outcome === 'booked' && booking?.startTime && booking?.endTime && process.env.GHL_CALENDAR_ID) {
      try {
        await ghl.createAppointment({
          contactId,
          calendarId: process.env.GHL_CALENDAR_ID,
          startTime: booking.startTime,
          endTime: booking.endTime,
          title: `${analysis.intent || 'Appointment'} - ${analysis.firstName || 'Caller'}`,
          notes: analysis.summary,
        });
        console.log(`[orchestrator] Created GHL appointment for ${callSid}`);
      } catch (err) {
        console.error('[orchestrator] GHL appointment failed (non-blocking):', err.message);
      }
    } else if (analysis.outcome === 'booked' && !booking?.startTime) {
      console.warn(`[orchestrator] ${callSid}: outcome=booked but no booking time in meta`);
    }

    // 6. Tags LAST — GHL workflows trigger on tag-added and need fields (and the
    //    appointment) already in place when they fire.
    const tagsToApply = ['ai-call-received'];
    const outcomeTag = OUTCOME_TO_TAG[analysis.outcome];
    if (outcomeTag) tagsToApply.push(outcomeTag);
    await ghl.addTags(contactId, tagsToApply);

    console.log(`[orchestrator] ✅ Synced ${callSid} → contact ${contactId}`);
  } catch (err) {
    console.error(`[orchestrator] ❌ Failed to sync ${callSid}:`, err.message);
    await writeFailedSync(callSid, { reason: 'sync_error', error: err.message, meta, conversation });
    processedCalls.delete(callSid); // allow manual/future retry
  }
}

module.exports = { syncCallToGHL, isEnabled };
