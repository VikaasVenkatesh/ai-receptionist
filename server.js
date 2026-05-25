'use strict';

require('dotenv').config();

const express = require('express');
const expressWs = require('express-ws');
const path = require('path');

const { incomingCallTwiml, replyTwiml, goodbyeTwiml, redirectCall } = require('./services/twilio');
const { createDeepgramStream } = require('./services/deepgram');
const { processUtterance, appendSystemNote, clearConversation } = require('./services/llm');
const { bookAppointment } = require('./services/calendar');

const app = express();
expressWs(app);

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use('/audio', express.static(path.join(__dirname, 'audio')));

const PORT = process.env.PORT || 3000;

// Railway sets RAILWAY_PUBLIC_DOMAIN automatically; fall back to BASE_URL for local dev.
const BASE_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : (process.env.BASE_URL || `http://localhost:${PORT}`);

// ─── Routes ──────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.send('✅ AI Receptionist is running. Twilio webhook: POST /incoming-call');
});

/**
 * Twilio hits this when someone calls the Twilio number.
 * We greet the caller and open a bidirectional media stream.
 */
app.post('/incoming-call', (req, res) => {
  const callSid = req.body?.CallSid;
  console.log(`[Server] Incoming call: ${callSid}`);
  res.type('text/xml').send(incomingCallTwiml(BASE_URL));
});

/**
 * Twilio calls this endpoint when it wants to play back the LLM reply.
 * The reply text is passed as a query param to avoid storing state.
 */
app.post('/play-reply', (req, res) => {
  const text = req.query.text || "I'm sorry, something went wrong.";
  const callSid = req.query.callSid;
  console.log(`[Server] Playing reply for ${callSid}: "${text}"`);
  res.type('text/xml').send(replyTwiml(decodeURIComponent(text), BASE_URL));
});

/**
 * Optional: Twilio status callback for logging call lifecycle.
 */
app.post('/call-status', (req, res) => {
  const { CallSid, CallStatus } = req.body;
  console.log(`[Server] Call ${CallSid} status: ${CallStatus}`);
  if (['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(CallStatus)) {
    clearConversation(CallSid);
  }
  res.sendStatus(204);
});

// ─── WebSocket Media Stream ───────────────────────────────────────────────────

/**
 * Twilio connects here for bidirectional audio streaming.
 *
 * Protocol:
 *   Twilio → server:  { event: 'start'|'media'|'stop'|'mark', ... }
 *   server → Twilio:  (we don't push audio back via WS; we redirect the call instead)
 */
app.ws('/media-stream', (ws, req) => {
  console.log('[WS] Media stream connection opened');

  let callSid = null;
  let streamSid = null;
  let deepgramStream = null;
  let processingUtterance = false; // Prevent overlapping LLM calls

  function onTranscript(transcript) {
    if (processingUtterance) {
      console.log('[WS] Ignoring transcript — already processing:', transcript);
      return;
    }
    processingUtterance = true;
    handleUtterance(callSid, transcript).finally(() => {
      processingUtterance = false;
    });
  }

  function onDeepgramError(err) {
    console.error('[WS] Deepgram error — reconnecting in 1s:', err.message);
    setTimeout(() => {
      if (ws.readyState === ws.OPEN) {
        deepgramStream = createDeepgramStream(onTranscript, onDeepgramError);
      }
    }, 1000);
  }

  ws.on('message', (rawMsg) => {
    let msg;
    try {
      msg = JSON.parse(rawMsg);
    } catch {
      return;
    }

    switch (msg.event) {
      case 'start':
        callSid = msg.start?.callSid;
        streamSid = msg.start?.streamSid;
        console.log(`[WS] Stream started — callSid: ${callSid}, streamSid: ${streamSid}`);
        deepgramStream = createDeepgramStream(onTranscript, onDeepgramError);
        break;

      case 'media': {
        const payload = msg.media?.payload;
        if (payload && deepgramStream) {
          const audioBuffer = Buffer.from(payload, 'base64');
          deepgramStream.send(audioBuffer);
        }
        break;
      }

      case 'stop':
        console.log(`[WS] Stream stopped for ${callSid}`);
        if (deepgramStream) {
          deepgramStream.close();
          deepgramStream = null;
        }
        break;

      default:
        break;
    }
  });

  ws.on('close', () => {
    console.log('[WS] WebSocket closed');
    if (deepgramStream) {
      deepgramStream.close();
      deepgramStream = null;
    }
  });

  ws.on('error', (err) => {
    console.error('[WS] WebSocket error:', err.message);
  });
});

// ─── Core call-handling logic ─────────────────────────────────────────────────

/**
 * Processes a single caller utterance end-to-end:
 *   utterance → LLM → (optional booking) → redirect call to play reply
 */
async function handleUtterance(callSid, utterance) {
  if (!callSid) {
    console.warn('[handleUtterance] No callSid — skipping');
    return;
  }

  console.log(`[handleUtterance] ${callSid}: "${utterance}"`);

  let replyText;
  let booking = null;

  try {
    const result = await processUtterance(callSid, utterance);
    replyText = result.text;
    booking = result.booking;
  } catch (err) {
    console.error('[handleUtterance] LLM error:', err.message);
    replyText = "I'm sorry, I'm having a little trouble. Could you say that again?";
  }

  // Handle calendar booking
  if (booking) {
    console.log(`[handleUtterance] Booking detected:`, booking);
    try {
      const calResult = await bookAppointment(booking);
      if (calResult.success) {
        replyText = (replyText + ' ' + calResult.message).trim();
        appendSystemNote(callSid, `Appointment successfully booked: ${JSON.stringify(booking)}`);
      } else {
        replyText = (replyText + ' ' + calResult.message).trim();
      }
    } catch (calErr) {
      console.error('[handleUtterance] Calendar error:', calErr.message);
      replyText += ' Unfortunately I had trouble accessing the calendar right now.';
    }
  }

  // Redirect the call to a TwiML endpoint that will <Say> the reply
  const replyUrl =
    `${BASE_URL}/play-reply` +
    `?callSid=${encodeURIComponent(callSid)}` +
    `&text=${encodeURIComponent(replyText)}`;

  try {
    await redirectCall(callSid, replyUrl);
    console.log(`[handleUtterance] Redirected ${callSid} to play reply`);
  } catch (err) {
    console.error('[handleUtterance] Failed to redirect call:', err.message);
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n✅ AI Receptionist running on port ${PORT}`);
  console.log(`   Public base URL: ${BASE_URL}`);
  console.log(`   Twilio webhook:  ${BASE_URL}/incoming-call  (HTTP POST)\n`);
});
