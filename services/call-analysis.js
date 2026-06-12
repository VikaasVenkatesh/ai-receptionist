'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

const ANALYSIS_SYSTEM_PROMPT = `You analyze phone call transcripts between a caller and an AI receptionist.

Return ONLY a JSON object (no preamble, no markdown fences) with these exact fields:

{
  "outcome": one of ["booked", "qualified_no_booking", "callback_requested", "after_hours", "spam", "no_qualification"],
  "intent": short string describing what the caller wanted (e.g. "schedule appointment", "ask about hours"),
  "firstName": string or null,
  "lastName": string or null,
  "email": string or null,
  "summary": 2-3 sentence summary of the call,
  "qualificationData": {} // object with any vertical-specific data extracted; empty {} if none
}

Outcome definitions:
- "booked": Appointment was successfully scheduled during the call
- "qualified_no_booking": Caller qualified as ICP but did not book (wanted to think, asked for info)
- "callback_requested": Caller asked to be called back
- "after_hours": Caller reached an after-hours message and did not engage further
- "spam": Robocall, wrong number, sales pitch, accidental dial
- "no_qualification": Caller doesn't fit ICP, couldn't be helped, hung up early

Be conservative: if you're not confident about name or email, return null. Don't guess or hallucinate.`;

/**
 * @param {string} formattedTranscript - "Caller: ...\nAI: ...\n..."
 * @param {object} context - { bookingSucceeded: boolean, callDurationSec: number }
 * @returns {Promise<object>}
 */
async function analyzeCall(formattedTranscript, context = {}) {
  const userContent = `TRANSCRIPT:\n${formattedTranscript}\n\nCONTEXT:\n${JSON.stringify(context)}`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-5', // matches services/llm.js (the live, valid model id)
      max_tokens: 1024,
      system: ANALYSIS_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    });

    const text = response.content[0]?.text || '{}';
    const cleaned = text.replace(/```json|```/g, '').trim();
    return JSON.parse(cleaned);
  } catch (err) {
    console.error('[call-analysis] Failed:', err.message);
    // Safe default so the GHL sync still proceeds with the raw transcript.
    return {
      outcome: 'no_qualification',
      intent: 'analysis_failed',
      firstName: null,
      lastName: null,
      email: null,
      summary: 'Call analysis failed; raw transcript available below.',
      qualificationData: {},
    };
  }
}

/**
 * Convert conversation history (from services/llm.js) to a readable transcript.
 * Drops the internal [System note: ...] lines we inject for booking confirmations.
 */
function formatTranscript(conversation) {
  if (!conversation || !conversation.length) return '(no transcript captured)';
  return conversation
    .filter((m) => !String(m.content).startsWith('[System note:'))
    .map((m) => `${m.role === 'user' ? 'Caller' : 'AI'}: ${m.content}`)
    .join('\n');
}

module.exports = { analyzeCall, formatTranscript };
