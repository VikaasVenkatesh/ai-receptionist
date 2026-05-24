'use strict';

const twilio = require('twilio');
const VoiceResponse = twilio.twiml.VoiceResponse;

/**
 * Returns TwiML for an incoming call:
 *  1. Greets the caller with <Say>
 *  2. Opens a bidirectional media stream to our WebSocket endpoint
 */
function incomingCallTwiml(ngrokUrl) {
  const twiml = new VoiceResponse();

  twiml.say(
    { voice: 'Polly.Joanna', language: 'en-US' },
    'Hi, thanks for calling Acme Clinic. How can I help you today?'
  );

  const connect = twiml.connect();
  const wsUrl = ngrokUrl.replace(/^https?/, 'wss') + '/media-stream';
  connect.stream({ url: wsUrl });

  return twiml.toString();
}

/**
 * Returns TwiML that speaks a reply and then re-connects the media stream
 * so the caller can keep talking.
 */
function replyTwiml(text, ngrokUrl) {
  const twiml = new VoiceResponse();

  twiml.say({ voice: 'Polly.Joanna', language: 'en-US' }, text);

  const connect = twiml.connect();
  const wsUrl = ngrokUrl.replace(/^https?/, 'wss') + '/media-stream';
  connect.stream({ url: wsUrl });

  return twiml.toString();
}

/**
 * Returns TwiML that says a message and hangs up.
 */
function goodbyeTwiml(text = 'Thank you for calling. Goodbye!') {
  const twiml = new VoiceResponse();
  twiml.say({ voice: 'Polly.Joanna', language: 'en-US' }, text);
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

module.exports = { incomingCallTwiml, replyTwiml, goodbyeTwiml, redirectCall };
