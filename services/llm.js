'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { SYSTEM_PROMPT } = require('../config/prompts');
const bus = require('./eventBus');

const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

// In-memory conversation history keyed by Twilio CallSid
const conversations = new Map();

const BOOK_PATTERN = /\{\{BOOK_APPOINTMENT:\s*(\{[\s\S]*?\})\}\}/;

/**
 * Sends the caller's utterance to Claude and returns:
 *   { text: string, booking: object|null }
 *
 * `text`    — the spoken reply (JSON block stripped out)
 * `booking` — parsed booking details, or null if no booking requested
 */
async function processUtterance(callSid, utterance) {
  if (!conversations.has(callSid)) {
    conversations.set(callSid, []);
  }

  const history = conversations.get(callSid);
  history.push({ role: 'user', content: utterance });
  bus.emit('call:transcript', { callSid, text: utterance });

  let rawReply;
  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: history,
    });
    rawReply = response.content[0]?.text ?? "I'm sorry, I didn't catch that. Could you repeat?";
  } catch (err) {
    console.error('[LLM] Claude API error:', err.message);
    return {
      text: "I'm sorry, I'm having trouble right now. Could you please repeat that?",
      booking: null,
    };
  }

  // Parse optional booking JSON
  let booking = null;
  const match = rawReply.match(BOOK_PATTERN);
  if (match) {
    try {
      booking = JSON.parse(match[1]);
    } catch (parseErr) {
      console.error('[LLM] Failed to parse booking JSON:', parseErr.message);
    }
  }

  // Strip the JSON block from the spoken text
  const spokenText = rawReply.replace(BOOK_PATTERN, '').trim();
  bus.emit('call:reply', { callSid, text: spokenText });

  history.push({ role: 'assistant', content: rawReply });

  return { text: spokenText, booking };
}

/** Appends a system-level note to the conversation (e.g. booking confirmation). */
function appendSystemNote(callSid, note) {
  const history = conversations.get(callSid);
  if (history) {
    history.push({ role: 'user', content: `[System note: ${note}]` });
  }
}

/** Clears conversation state when a call ends. */
function clearConversation(callSid) {
  conversations.delete(callSid);
  console.log(`[LLM] Cleared conversation for ${callSid}`);
}

module.exports = { processUtterance, appendSystemNote, clearConversation };
