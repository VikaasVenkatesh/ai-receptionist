'use strict';

const ghl = require('./crm/ghl');
const { analyzeCall, formatTranscript } = require('./call-analysis');

// In-memory idempotency: callSid -> processedAt timestamp
const processedCalls = new Map();
const DEDUP_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// Outcome → tag mapping. Base tag 'ai-call-received' always applied.
const OUTCOME_TO_TAG = {
  booked: 'ai-call-booked',
  qualified_no_booking: 'ai-call-no-booking',
  callback_requested: 'ai-call-callback-requested',
  after_hours: 'ai-call-after-hours',
  spam: 'ai-call-spam',
  no_qualification: null, // base tag only
};

// Outcome → pipeline stage. Only some outcomes get opportunities.
function stageForOutcome(outcome) {
  switch (outcome) {
    case 'booked':               return process.env.GHL_STAGE_ID_BOOKED;
    case 'qualified_no_booking': return process.env.GHL_STAGE_ID_QUALIFIED;
    case 'callback_requested':   return process.env.GHL_STAGE_ID_NEW_CALL;
    default:                     return null; // no opp for after_hours/spam/no_qualification
  }
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

  // Idempotency (also guards against Twilio status-callback retries)
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

  try {
    if (!meta?.from) {
      console.warn(`[orchestrator] No caller phone for ${callSid}, skipping`);
      processedCalls.delete(callSid);
      return;
    }

    const transcript = formatTranscript(conversation);
    const durationSec = meta.startedAt ? Math.round((Date.now() - meta.startedAt) / 1000) : 0;

    // 1. Analyze
    const analysis = await analyzeCall(transcript, {
      bookingSucceeded: meta.bookings?.some((b) => b.success) || false,
      callDurationSec: durationSec,
    });
    console.log(`[orchestrator] ${callSid} analysis:`, JSON.stringify(analysis));

    // 2. Upsert contact
    const contactId = await ghl.upsertContact({
      phone: meta.from,
      firstName: analysis.firstName,
      lastName: analysis.lastName,
      email: analysis.email,
    });

    // 3. Set custom fields
    await ghl.setCustomFields(contactId, {
      [process.env.GHL_FIELD_ID_AI_CALL_INTENT]: analysis.intent || '',
      [process.env.GHL_FIELD_ID_AI_CALL_OUTCOME]: analysis.outcome,
      [process.env.GHL_FIELD_ID_AI_CALL_DURATION]: durationSec,
      [process.env.GHL_FIELD_ID_AI_CALL_QUALIFICATION_DATA]: JSON.stringify(analysis.qualificationData || {}),
      [process.env.GHL_FIELD_ID_LAST_AI_CALL_TIMESTAMP]: new Date().toISOString(),
      // ai_call_transcript_url intentionally left empty in V1; transcript lives in the note
    });

    // 4. Note with transcript + summary
    const noteBody = [
      `AI Receptionist Call — ${new Date().toISOString()}`,
      `Outcome: ${analysis.outcome}`,
      `Intent: ${analysis.intent}`,
      `Duration: ${durationSec}s`,
      `Status: ${status}`,
      ``,
      `Summary: ${analysis.summary}`,
      ``,
      `--- Transcript ---`,
      transcript,
    ].join('\n');
    await ghl.addNote(contactId, noteBody);

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

    // 6. Tags LAST — GHL workflows trigger on tag-added and need the fields in
    //    place when they fire, so this must come after everything else.
    const tagsToApply = ['ai-call-received'];
    const outcomeTag = OUTCOME_TO_TAG[analysis.outcome];
    if (outcomeTag) tagsToApply.push(outcomeTag);
    await ghl.addTags(contactId, tagsToApply);

    console.log(`[orchestrator] ✅ Synced ${callSid} → contact ${contactId}`);
  } catch (err) {
    console.error(`[orchestrator] ❌ Failed to sync ${callSid}:`, err.message);
    // Allow a manual or future retry by removing from the dedup set
    processedCalls.delete(callSid);
  }
}

module.exports = { syncCallToGHL, isEnabled };
