'use strict';

const twilio = require('twilio');
const VoiceResponse = twilio.twiml.VoiceResponse;

/**
 * Returns TwiML for an incoming call:
 *  1. Greets the caller with <Say>
 *  2. Opens a bidirectional media stream to our WebSocket endpoint
 */
const GREETING_TEXT = "Hi, thanks for calling Dr. Han Kim's office. How can I help you today?";

function incomingCallTwiml(baseUrl, greetingAudioUrl = null) {
  const twiml = new VoiceResponse();

  // Use the pre-generated human voice if available; otherwise Polly.
  if (greetingAudioUrl) {
    twiml.play(greetingAudioUrl);
  } else {
    twiml.say({ voice: 'Polly.Joanna-Neural', language: 'en-US' }, GREETING_TEXT);
  }

  const connect = twiml.connect();
  const wsUrl = baseUrl.replace(/^https?/, 'wss') + '/media-stream';
  connect.stream({ url: wsUrl });

  // Fallback if the stream closes unexpectedly — tells the caller rather than dead air
  twiml.say(
    { voice: 'Polly.Joanna-Neural', language: 'en-US' },
    "I'm sorry, I lost your connection. Please call back and I'll be happy to help."
  );

  return twiml.toString();
}

/**
 * Returns TwiML that speaks a reply and then re-connects the media stream
 * so the caller can keep talking.
 */
function replyTwiml(text, ngrokUrl) {
  const twiml = new VoiceResponse();

  twiml.say({ voice: 'Polly.Joanna-Neural', language: 'en-US' }, text);

  const connect = twiml.connect();
  const wsUrl = ngrokUrl.replace(/^https?/, 'wss') + '/media-stream';
  connect.stream({ url: wsUrl });

  return twiml.toString();
}

/**
 * Like replyTwiml, but plays a pre-generated audio file (e.g. ElevenLabs MP3)
 * instead of using Twilio's built-in <Say>. Re-opens the media stream after.
 */
function replyTwimlAudio(audioUrl, baseUrl) {
  const twiml = new VoiceResponse();

  twiml.play(audioUrl);

  const connect = twiml.connect();
  const wsUrl = baseUrl.replace(/^https?/, 'wss') + '/media-stream';
  connect.stream({ url: wsUrl });

  return twiml.toString();
}

/**
 * Returns TwiML that says a message and hangs up.
 */
function goodbyeTwiml(text = 'Thank you for calling. Goodbye!') {
  const twiml = new VoiceResponse();
  twiml.say({ voice: 'Polly.Joanna-Neural', language: 'en-US' }, text);
  twiml.hangup();
  return twiml.toString();
}

/**
 * Redirects an active call to a new TwiML URL using the Twilio REST API.
 * Used to interrupt the media stream and play back an LLM response.
 */
async function redirectCall(callSid, twimlUrl) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const client = twilio(accountSid, authToken);

  await client.calls(callSid).update({ url: twimlUrl, method: 'POST' });
}

module.exports = { incomingCallTwiml, replyTwiml, replyTwimlAudio, goodbyeTwiml, redirectCall, GREETING_TEXT };
