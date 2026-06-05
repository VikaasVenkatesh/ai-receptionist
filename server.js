'use strict';

require('dotenv').config();

const express = require('express');
const expressWs = require('express-ws');
const path = require('path');

const { incomingCallTwiml, replyTwiml, redirectCall } = require('./services/twilio');
const { createDeepgramStream } = require('./services/deepgram');
const { processUtterance, appendSystemNote, clearConversation } = require('./services/llm');
const { bookAppointment } = require('./services/calendar');
const bus = require('./services/eventBus');

const app = express();
expressWs(app);

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use('/audio', express.static(path.join(__dirname, 'audio')));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// Railway sets RAILWAY_PUBLIC_DOMAIN automatically; fall back to BASE_URL for local dev.
const BASE_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : (process.env.BASE_URL || `http://localhost:${PORT}`);

// ─── SSE — push live events to dashboard browsers ────────────────────────────

const sseClients = new Set();

// Rolling buffer of last 100 events — replayed to any new client on connect
// so reloading the dashboard still shows history
const eventHistory = [];
const MAX_HISTORY = 100;

function broadcast(type, payload) {
  const event = { type, ...payload, ts: Date.now() };
  const data = `data: ${JSON.stringify(event)}\n\n`;
  eventHistory.push(data);
  if (eventHistory.length > MAX_HISTORY) eventHistory.shift();
  for (const client of sseClients) {
    try { client.write(data); } catch (_) {}
  }
}

app.get('/events', (req, res) => {
  res.set({
    'Content-Type':      'text/event-stream',
    'Cache-Control':     'no-cache',
    'Connection':        'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  // Replay history so a fresh page load sees past activity
  for (const item of eventHistory) {
    try { res.write(item); } catch (_) {}
  }

  // Heartbeat every 20 s — keeps Railway + Safari from closing the connection
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch (_) {}
  }, 20000);

  sseClients.add(res);
  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

// Wire all bus events → SSE broadcast
bus.on('call:started',    (p) => broadcast('call:started',    p));
bus.on('call:transcript', (p) => broadcast('call:transcript', p));
bus.on('call:reply',      (p) => broadcast('call:reply',      p));
bus.on('call:booking',    (p) => broadcast('call:booking',    p));
bus.on('call:ended',      (p) => broadcast('call:ended',      p));
bus.on('call:error',      (p) => broadcast('call:error',      p));

// ─── Routes ──────────────────────────────────────────────────────────────────

// Dashboard is served from public/index.html via the static middleware above.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Exposes the Twilio number to the dashboard
app.get('/phone-number', (req, res) => {
  res.json({ number: process.env.TWILIO_PHONE_NUMBER || null });
});

/**
 * Twilio hits this when someone calls the Twilio number.
 */
app.post('/incoming-call', (req, res) => {
  const callSid = req.body?.CallSid;
  const from    = req.body?.From || 'Unknown';
  const to      = req.body?.To   || '';
  console.log(`[Server] Incoming call: ${callSid} from ${from}`);
  bus.emit('call:started', { callSid, from, to });
  res.type('text/xml').send(incomingCallTwiml(BASE_URL));
});

/**
 * Twilio calls this to play back the LLM reply then re-open the stream.
 */
app.post('/play-reply', (req, res) => {
  const text    = req.query.text || "I'm sorry, something went wrong.";
  const callSid = req.query.callSid;
  console.log(`[Server] Playing reply for ${callSid}: "${text}"`);
  res.type('text/xml').send(replyTwiml(decodeURIComponent(text), BASE_URL));
});

/**
 * Twilio status callback — cleans up state when a call ends.
 */
app.post('/call-status', (req, res) => {
  const { CallSid, CallStatus } = req.body;
  console.log(`[Server] Call ${CallSid} status: ${CallStatus}`);
  if (['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(CallStatus)) {
    bus.emit('call:ended', { callSid: CallSid, status: CallStatus });
    clearConversation(CallSid);
  }
  res.sendStatus(204);
});

// ─── WebSocket Media Stream ───────────────────────────────────────────────────

app.ws('/media-stream', (ws, req) => {
  console.log('[WS] Media stream connection opened');

  let callSid = null;
  let deepgramStream = null;
  let processingUtterance = false;

  function onTranscript(transcript) {
    if (processingUtterance) return;
    processingUtterance = true;
    handleUtterance(callSid, transcript).finally(() => {
      processingUtterance = false;
    });
  }

  function onDeepgramError(err) {
    console.error('[WS] Deepgram error — reconnecting in 1s:', err.message);
    if (callSid) bus.emit('call:error', { callSid, message: 'STT connection dropped, reconnecting…' });
    setTimeout(() => {
      if (ws.readyState === ws.OPEN) {
        deepgramStream = createDeepgramStream(onTranscript, onDeepgramError);
      }
    }, 1000);
  }

  ws.on('message', (rawMsg) => {
    let msg;
    try { msg = JSON.parse(rawMsg); } catch { return; }

    switch (msg.event) {
      case 'start':
        callSid = msg.start?.callSid;
        console.log(`[WS] Stream started — callSid: ${callSid}`);
        deepgramStream = createDeepgramStream(onTranscript, onDeepgramError);
        break;

      case 'media': {
        const payload = msg.media?.payload;
        if (payload && deepgramStream) {
          deepgramStream.send(Buffer.from(payload, 'base64'));
        }
        break;
      }

      case 'stop':
        console.log(`[WS] Stream stopped for ${callSid}`);
        if (deepgramStream) { deepgramStream.close(); deepgramStream = null; }
        break;
    }
  });

  ws.on('close', () => {
    if (deepgramStream) { deepgramStream.close(); deepgramStream = null; }
  });

  ws.on('error', (err) => console.error('[WS] error:', err.message));
});

// ─── Core call-handling logic ─────────────────────────────────────────────────

async function handleUtterance(callSid, utterance) {
  if (!callSid) return;
  console.log(`[handleUtterance] ${callSid}: "${utterance}"`);

  let replyText;
  let booking = null;

  try {
    const result = await processUtterance(callSid, utterance);
    replyText = result.text;
    booking   = result.booking;
  } catch (err) {
    console.error('[handleUtterance] LLM error:', err.message);
    replyText = "I'm sorry, I'm having a little trouble. Could you say that again?";
    bus.emit('call:error', { callSid, message: err.message });
  }

  // Handle calendar booking
  if (booking) {
    console.log('[handleUtterance] Booking detected:', booking);
    try {
      const calResult = await bookAppointment(booking);
      replyText = (replyText + ' ' + calResult.message).trim();
      bus.emit('call:booking', { callSid, details: booking, success: calResult.success, message: calResult.message });
      if (calResult.success) {
        appendSystemNote(callSid, `Appointment booked: ${JSON.stringify(booking)}`);
      }
    } catch (calErr) {
      console.error('[handleUtterance] Calendar error:', calErr.message);
      replyText += ' Unfortunately I had trouble accessing the calendar right now.';
    }
  }

  // Redirect call to TwiML that speaks the reply
  const replyUrl =
    `${BASE_URL}/play-reply` +
    `?callSid=${encodeURIComponent(callSid)}` +
    `&text=${encodeURIComponent(replyText)}`;

  try {
    await redirectCall(callSid, replyUrl);
  } catch (err) {
    console.error('[handleUtterance] Failed to redirect call:', err.message);
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n✅ AI Receptionist running on port ${PORT}`);
  console.log(`   Dashboard:      ${BASE_URL}`);
  console.log(`   Twilio webhook: ${BASE_URL}/incoming-call  (HTTP POST)\n`);
});
