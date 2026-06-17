'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

const MAX_TRANSCRIPT_CHARS = 40000; // ~10K tokens, safe for Claude context

const ALLOWED_OUTCOMES = new Set([
  'booked', 'qualified_no_booking', 'callback_requested',
  'after_hours', 'spam', 'no_qualification',
]);

const ANALYSIS_SYSTEM_PROMPT = `You analyze phone call transcripts between a caller and an AI receptionist.

Return ONLY a JSON object (no preamble, no markdown fences) with these exact fields:

{
  "outcome": one of ["booked", "qualified_no_booking", "callback_requested", "after_hours", "spam", "no_qualification"],
  "intent": short string describing what the caller wanted,
  "firstName": string or null,
  "lastName": string or null,
  "email": string or null,
  "summary": 2-3 sentence summary of the call (in the language of the conversation),
  "qualificationData": {}
}

Outcome definitions:
- "booked": Appointment was scheduled during the call
- "qualified_no_booking": Caller qualified as ICP but did not book
- "callback_requested": Caller explicitly asked to be called back
- "after_hours": Reached after-hours message, no engagement
- "spam": Robocall, wrong number, sales pitch, accidental dial
- "no_qualification": Doesn't fit ICP, couldn't be helped, hung up early

firstName/lastName extraction rules:
- Only extract if the caller clearly states it ("This is John", "My name is Sarah")
- Strip honorifics and company suffixes (e.g. "John from Acme" -> "John")
- If only a vague intro with no name, return null
- Single-word names only for firstName field

email extraction rules:
- Only extract if explicitly spelled out or clearly stated
- Must look like a real email format
- Do not fabricate or guess

Language handling:
- The transcript may be in any language
- Return all field values in English EXCEPT "summary" which should be in the conversation's language
- Outcome enum values are always English

Be conservative. When in doubt, return null rather than guess.`;

function truncateTranscript(transcript) {
  if (transcript.length <= MAX_TRANSCRIPT_CHARS) return transcript;
  const head = transcript.slice(0, MAX_TRANSCRIPT_CHARS / 2);
  const tail = transcript.slice(-MAX_TRANSCRIPT_CHARS / 2);
  return `${head}\n\n[... transcript truncated for length ...]\n\n${tail}`;
}

/** Coerce Claude's output into the allowed shape — never trust the model blindly. */
function validateAnalysis(analysis) {
  if (!ALLOWED_OUTCOMES.has(analysis.outcome)) {
    console.warn(`[analysis] Invalid outcome "${analysis.outcome}", defaulting to no_qualification`);
    analysis.outcome = 'no_qualification';
  }
  if (analysis.firstName && /\s/.test(analysis.firstName)) {
    analysis.firstName = analysis.firstName.split(/\s/)[0]; // first word only
  }
  if (analysis.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(analysis.email)) {
    analysis.email = null;
  }
  if (!analysis.qualificationData || typeof analysis.qualificationData !== 'object') {
    analysis.qualificationData = {};
  }
  return analysis;
}

/**
 * @param {string} formattedTranscript - "Caller: ...\nAI: ...\n..."
 * @param {object} context - { bookingSucceeded: boolean, callDurationSec: number }
 * @returns {Promise<object>}
 */
async function analyzeCall(formattedTranscript, context = {}) {
  const truncated = truncateTranscript(formattedTranscript);
  const userContent = `TRANSCRIPT:\n${truncated}\n\nCONTEXT:\n${JSON.stringify(context)}`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-5', // the live, valid model id (matches services/llm.js)
      max_tokens: 1024,
      system: ANALYSIS_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    });

    const text = response.content[0]?.text || '{}';
    const cleaned = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return validateAnalysis(parsed);
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
