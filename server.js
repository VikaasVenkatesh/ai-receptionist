'use strict';

require('dotenv').config();

const express = require('express');
const expressWs = require('express-ws');
const path = require('path');
const fs = require('fs');

const { incomingCallTwiml, replyTwiml, replyTwimlAudio, redirectCall, GREETING_TEXT } = require('./services/twilio');
const { createDeepgramStream } = require('./services/deepgram');
const { processUtterance, appendSystemNote, clearConversation, getConversation } = require('./services/llm');
const { bookAppointment, nextWeekdayAt, createDemoEvent } = require('./services/calendar');
const tts = require('./services/tts');
const bus = require('./services/eventBus');
const { setMeta, getMeta, recordBooking, clearMeta } = require('./services/call-meta');
const { syncCallToGHL } = require('./services/orchestrator');
const { readFailedSync } = require('./services/failed-sync-ledger');
const email = require('./services/email');
const { startReminderLoop } = require('./services/reminders');

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

// Server-side stats — survive page reloads
const serverStats = { totalCalls: 0, totalBookings: 0 };

// Rolling history — only meaningful events (no error spam)
const HISTORY_TYPES = new Set(['call:started','call:transcript','call:reply','call:booking','call:ended']);
const eventHistory  = [];
const MAX_HISTORY   = 80;

// Live calls, keyed by callSid → last-activity timestamp. Used to auto-close
// "stale" calls so the dashboard never shows a phantom active call when an
// end-of-call signal never arrives (e.g. a test POST, or a missed Twilio
// status callback). A real call has transcript/reply activity every few
// seconds, so a gap means the call is actually over.
const activeCalls = new Map();
const STALE_CALL_MS = 3 * 60 * 1000; // no activity for 3 min → treat as ended

// Monotonic event id so dashboards can ignore events they've already rendered
// when the SSE stream reconnects and the server replays history.
let eventSeq = 0;

function broadcast(type, payload) {
  // Track stats server-side
  if (type === 'call:started')  serverStats.totalCalls++;
  if (type === 'call:booking' && payload.success) serverStats.totalBookings++;

  // Track live-call activity for the stale-call sweeper
  const sid = payload.callSid;
  if (sid) {
    if (type === 'call:started') activeCalls.set(sid, Date.now());
    else if (type === 'call:ended') activeCalls.delete(sid);
    else if (activeCalls.has(sid)) activeCalls.set(sid, Date.now()); // transcript/reply/booking
  }

  const event = { type, ...payload, ts: Date.now(), id: ++eventSeq };
  const data  = `data: ${JSON.stringify(event)}\n\n`;

  // Only persist meaningful events in history (skip error spam)
  if (HISTORY_TYPES.has(type)) {
    eventHistory.push(data);
    if (eventHistory.length > MAX_HISTORY) eventHistory.shift();
  }

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

  // Send current stats immediately so counters are correct on reload
  try {
    res.write(`data: ${JSON.stringify({ type: 'stats', ...serverStats, ts: Date.now() })}\n\n`);
  } catch (_) {}

  // Replay meaningful event history
  for (const item of eventHistory) {
    try { res.write(item); } catch (_) {}
  }

  // Heartbeat every 20 s
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

// Persist per-call metadata so the end-of-call GHL sync has the caller's number,
// start time, and any bookings available after the live events have passed.
bus.on('call:started', ({ callSid, from, to }) => {
  setMeta(callSid, { from, to, startedAt: Date.now() });
});
bus.on('call:booking', ({ callSid, details, success }) => {
  recordBooking(callSid, { ...details, success });
});

// Sweep stale calls: if a "live" call has had no activity for STALE_CALL_MS,
// the real end-of-call signal never arrived — close it out so the dashboard
// clears instead of showing a phantom call that ticks up forever.
setInterval(() => {
  const now = Date.now();
  for (const [sid, lastTs] of activeCalls) {
    if (now - lastTs > STALE_CALL_MS) {
      console.log(`[Sweeper] Auto-ending stale call ${sid} (no activity for ${Math.round((now - lastTs) / 1000)}s)`);
      // Read state before clearing so the CRM sync still has it. The orchestrator
      // is idempotent per callSid, so if Twilio's callback later arrives too,
      // it won't double-sync.
      const conversation = getConversation(sid);
      const meta = getMeta(sid);
      bus.emit('call:ended', { callSid: sid, status: 'timeout' });
      if (conversation.length > 0) {
        syncCallToGHL({ callSid: sid, status: 'timeout', conversation, meta })
          .catch((err) => console.error('[Sweeper] GHL sync error:', err.message));
      }
      clearConversation(sid);
      clearMeta(sid);
      lastUtterance.delete(sid);
      callQueues.delete(sid);
    }
  }
}, 30 * 1000).unref();

// ─── Routes ──────────────────────────────────────────────────────────────────

// Dashboard is served from public/index.html via the static middleware above.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Website demo (embeddable clickthrough) ──────────────────────────────────

// The AI's spoken lines in public/demo.html, voiced with the same TTS the real
// receptionist uses. Generated once at startup so the page has real audio.
const DEMO_LINES = {
  l1: "Hi, thanks for calling Doctor Hahn Kim's office. How can I help you today?",
  l2: "I'm sorry to hear that. I can get you in. What day and time work best? We're open Tuesday through Friday, nine to six, and Saturday mornings.",
  l3: 'Thursday, September 24th at 2:00 PM is open. Can I get your full name?',
  l4: 'Thanks, John. And your email address for the confirmation?',
  l5: 'Let me read that back: j, o, h, n, dot, s, m, i, t, h, at gmail dot com. Did I get that right?',
  l6: "Perfect. You're booked for Thursday, September 24th at 2:00 PM for lower back pain, and the confirmation is on its way. See you then!",
};
const demoAudio = {}; // line id -> public /audio URL

// Pre-rendered ElevenLabs clips (see the DJ demo note below); falls back to
// the Aura voice for any line without a committed file.
async function generateDemoAudio() {
  for (const [id, text] of Object.entries(DEMO_LINES)) {
    const clip = path.join(__dirname, 'public', 'demo-audio', 'clinic', `${id}.mp3`);
    if (fs.existsSync(clip)) {
      demoAudio[id] = `${BASE_URL}/demo-audio/clinic/${id}.mp3`;
      continue;
    }
    if (!tts.isEnabled()) continue;
    try {
      const file = await tts.generateSpeech(text, 'demo');
      if (file) demoAudio[id] = `${BASE_URL}/audio/${encodeURIComponent(file)}`;
    } catch (err) {
      console.error(`[Demo] Audio failed for ${id}:`, err.message);
    }
  }
  console.log(`   Demo audio:     ${Object.keys(demoAudio).length}/${Object.keys(DEMO_LINES).length} lines ready`);
}

app.get('/demo', (req, res) => {
  // Embeddable on the marketing site, so don't send X-Frame-Options here.
  res.sendFile(path.join(__dirname, 'public', 'demo.html'));
});

app.get('/demo-manifest', (req, res) => {
  res.json({ audio: demoAudio });
});

// ─── DJ Tanveer demo (second brand, same deployment) ─────────────────────────

const DJ_DEMO_LINES = {
  l1: 'Hi, thanks for calling DJ Tonveer. How can I help you today?',
  l2: "Congratulations! Tonveer would love to hear about it. The best next step is a quick consultation call. What day and time work for you? We're available Monday through Saturday, ten to eight.",
  l3: 'Thursday, October 15th at 2:00 PM is open. Can I get your full name?',
  l4: 'Thanks, Priya. And your email address for the confirmation?',
  l5: 'Let me read that back: p, r, i, y, a, dot, s, h, a, r, m, a, at gmail dot com. Did I get that right?',
  l6: 'Perfect. Your consultation is set for Thursday, October 15th at 2:00 PM to plan the wedding reception, and the confirmation is on its way. Talk soon!',
};
const djDemoAudio = {};

// The DJ demo uses ElevenLabs clips committed under public/demo-audio/dj.
// They're pre-rendered because ElevenLabs' free tier refuses API calls from
// datacenter IPs, so the server can't generate them at runtime. Any line
// without a file falls back to the Aura voice.
async function generateDjDemoAudio() {
  for (const [id, text] of Object.entries(DJ_DEMO_LINES)) {
    const clip = path.join(__dirname, 'public', 'demo-audio', 'dj', `${id}.mp3`);
    if (fs.existsSync(clip)) {
      djDemoAudio[id] = `${BASE_URL}/demo-audio/dj/${id}.mp3`;
      continue;
    }
    if (!tts.isEnabled()) continue;
    try {
      const file = await tts.generateSpeech(text, 'demo');
      if (file) djDemoAudio[id] = `${BASE_URL}/audio/${encodeURIComponent(file)}`;
    } catch (err) {
      console.error(`[DJ demo] Audio failed for ${id}:`, err.message);
    }
  }
  console.log(`   DJ demo audio:  ${Object.keys(djDemoAudio).length}/${Object.keys(DJ_DEMO_LINES).length} lines ready`);
}

app.get('/demo/dj', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'demo-dj.html'));
});
app.get('/demo/dj/manifest', (req, res) => res.json({ audio: djDemoAudio }));

// Lets a demo viewer drop a genuine event on the DJ booking calendar. Public,
// so it's rate limited per IP and every event is clearly marked as a demo.
const djDemoHits = new Map(); // ip -> [timestamps]
const DJ_DEMO_MAX_PER_HOUR = 5;

app.post('/demo/dj/book', async (req, res) => {
  const calendarId = process.env.GOOGLE_CALENDAR_ID_DJ;
  if (!calendarId) return res.status(503).json({ error: 'Demo calendar is not configured.' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
  const now = Date.now();
  const recent = (djDemoHits.get(ip) || []).filter((t) => now - t < 3600 * 1000);
  if (recent.length >= DJ_DEMO_MAX_PER_HOUR) {
    return res.status(429).json({ error: 'Demo limit reached, try again later.' });
  }
  recent.push(now);
  djDemoHits.set(ip, recent);

  // Next Thursday at 2:00 PM Pacific, matching the scripted call.
  const start = nextWeekdayAt(4, 14, 0);
  const end = new Date(start.getTime() + 30 * 60 * 1000);

  try {
    const result = await createDemoEvent({
      calendarId,
      summary: '[Demo] Consultation – Priya Sharma',
      description:
        'Wedding reception consultation.\n' +
        'Email: priya.sharma@gmail.com\n' +
        'Booked from the DJ Tanveer website demo.',
      start,
      end,
    });
    res.json({ ok: true, link: result.htmlLink, start: start.toISOString() });
  } catch (err) {
    console.error('[DJ demo] Booking failed:', err.message);
    res.status(500).json({ error: 'Could not add the booking right now.' });
  }
});

app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});

// Exposes the Twilio number to the dashboard
app.get('/phone-number', (req, res) => {
  res.json({ number: process.env.TWILIO_PHONE_NUMBER || null });
});

/**
 * Twilio hits this when someone calls the Twilio number.
 */
// Greeting audio is generated once at startup (see bottom) so the very first
// thing the caller hears is the same human voice as the replies, with no
// per-call latency. Null when ElevenLabs is disabled → falls back to Polly.
let greetingAudioFile = null;

app.post('/incoming-call', (req, res) => {
  const callSid = req.body?.CallSid;
  const from    = req.body?.From || 'Unknown';
  const to      = req.body?.To   || '';
  console.log(`[Server] Incoming call: ${callSid} from ${from}`);
  bus.emit('call:started', { callSid, from, to });
  const greetingUrl = greetingAudioFile
    ? `${BASE_URL}/audio/${encodeURIComponent(greetingAudioFile)}`
    : null;
  res.type('text/xml').send(incomingCallTwiml(BASE_URL, greetingUrl));
});

/**
 * Twilio calls this to play back the LLM reply then re-open the stream.
 */
app.post('/play-reply', (req, res) => {
  const text    = req.query.text || "I'm sorry, something went wrong.";
  const callSid = req.query.callSid;
  const audio   = req.query.audio; // ElevenLabs filename, when available
  console.log(`[Server] Playing reply for ${callSid}: "${text}"${audio ? ' [audio]' : ''}`);

  // Prefer the pre-generated human voice; fall back to Polly <Say> if absent.
  if (audio) {
    const audioUrl = `${BASE_URL}/audio/${encodeURIComponent(audio)}`;
    return res.type('text/xml').send(replyTwimlAudio(audioUrl, BASE_URL));
  }
  res.type('text/xml').send(replyTwiml(decodeURIComponent(text), BASE_URL));
});

/**
 * Twilio status callback — cleans up state when a call ends.
 */
app.post('/call-status', (req, res) => {
  const { CallSid, CallStatus } = req.body;
  console.log(`[Server] Call ${CallSid} status: ${CallStatus}`);

  if (['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(CallStatus)) {
    // Read call state BEFORE we clear it — the orchestrator needs the transcript
    // and metadata. References stay valid even after the maps are cleared.
    const conversation = getConversation(CallSid);
    const meta = getMeta(CallSid);

    bus.emit('call:ended', { callSid: CallSid, status: CallStatus });

    if (CallStatus === 'completed' && conversation.length > 0) {
      // Grace period: Deepgram may still have a trailing final transcript that
      // hasn't been appended when Twilio fires this callback. Wait briefly, then
      // re-read so the analysis sees the complete conversation. We've already
      // answered 204, so the delayed cleanup doesn't affect Twilio.
      setTimeout(() => {
        const finalConversation = getConversation(CallSid);
        const convForSync = finalConversation.length > conversation.length ? finalConversation : conversation;
        syncCallToGHL({ callSid: CallSid, status: CallStatus, conversation: convForSync, meta })
          .catch((err) => console.error('[Server] GHL sync error:', err.message));

        clearConversation(CallSid);
        clearMeta(CallSid);
        lastUtterance.delete(CallSid);
        callQueues.delete(CallSid);
      }, 1500);
    } else {
      // Non-completed statuses: clear immediately, no sync.
      clearConversation(CallSid);
      clearMeta(CallSid);
      lastUtterance.delete(CallSid);
      callQueues.delete(CallSid);
    }
  }
  res.sendStatus(204);
});

/**
 * Admin: manually re-trigger a failed GHL sync from the ledger.
 * Protected by the ADMIN_SECRET header. Best-effort (ledger is ephemeral on Railway).
 */
app.post('/admin/retry-sync/:callSid', async (req, res) => {
  if (!process.env.ADMIN_SECRET || req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) {
    return res.sendStatus(403);
  }
  const { callSid } = req.params;
  const failed = await readFailedSync(callSid);
  if (!failed) return res.status(404).json({ error: 'No failed sync found for callSid' });

  try {
    await syncCallToGHL({
      callSid,
      status: 'completed',
      conversation: failed.payload?.conversation || [],
      meta: failed.payload?.meta || {},
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── WebSocket Media Stream ───────────────────────────────────────────────────

app.ws('/media-stream', (ws, req) => {
  console.log('[WS] Media stream connection opened');

  let callSid = null;
  let deepgramStream = null;
  let retryCount  = 0;
  let retryTimer  = null;
  const MAX_RETRIES = 8;

  function onTranscript(transcript) {
    retryCount = 0; // successful data — reset backoff
    // Hand off to the per-call queue. Because every reply reconnects a fresh
    // media stream (with its own Deepgram), the same call can have overlapping
    // WebSocket connections briefly. A per-connection flag would let two
    // utterances be processed concurrently and interleave their Claude calls,
    // which corrupts the shared conversation history (turns get dropped). The
    // queue serializes everything per callSid instead.
    enqueueUtterance(callSid, transcript);
  }

  function scheduleReconnect(err) {
    if (ws.readyState !== ws.OPEN) return; // call already ended
    if (retryCount >= MAX_RETRIES) {
      console.error('[WS] Deepgram: max retries reached, giving up');
      if (callSid) bus.emit('call:error', { callSid, message: 'Speech recognition unavailable. Please call back.' });
      return;
    }

    // If Deepgram rate-limited us (429), wait much longer
    const is429   = err?.httpStatus === 429 || err?.message?.includes('429');
    const baseMs  = is429 ? 30000 : 1000;
    const delayMs = Math.min(baseMs * Math.pow(2, retryCount), 60000);
    retryCount++;

    console.log(`[WS] Deepgram reconnect in ${delayMs}ms (attempt ${retryCount}/${MAX_RETRIES})`);
    if (callSid) bus.emit('call:error', { callSid, message: `STT reconnecting (${retryCount}/${MAX_RETRIES})…` });

    retryTimer = setTimeout(() => {
      if (ws.readyState === ws.OPEN) {
        deepgramStream = createDeepgramStream(onTranscript, scheduleReconnect);
      }
    }, delayMs);
  }

  ws.on('message', (rawMsg) => {
    let msg;
    try { msg = JSON.parse(rawMsg); } catch { return; }

    switch (msg.event) {
      case 'start':
        callSid = msg.start?.callSid;
        console.log(`[WS] Stream started — callSid: ${callSid}`);
        deepgramStream = createDeepgramStream(onTranscript, scheduleReconnect);
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
    clearTimeout(retryTimer); // stop any pending reconnect
    if (deepgramStream) { deepgramStream.close(); deepgramStream = null; }
  });

  ws.on('error', (err) => console.error('[WS] error:', err.message));
});

// ─── Core call-handling logic ─────────────────────────────────────────────────

// One serialized work queue per call, so utterances are processed strictly in
// order and never interleave (see onTranscript for why). Also de-dupes the same
// transcript arriving twice from briefly-overlapping Deepgram streams.
const callQueues = new Map();      // callSid -> Promise (tail of the chain)
const lastUtterance = new Map();   // callSid -> { text, at }

// Idempotency for bookings. The model sometimes re-emits the booking JSON on a
// follow-up turn ("yes that's correct" then "thank you"), and Google Calendar's
// read-after-write is eventually consistent, so the conflict check can miss a
// near-simultaneous duplicate. We remember recently-booked appointments and
// suppress an identical one within the TTL so the same slot is never booked twice.
const recentBookings = new Map();  // "name|date|time" -> timestamp
const BOOKING_DEDUP_MS = 5 * 60 * 1000;

function bookingKey(b) {
  return `${String(b.name || '').toLowerCase().trim()}|${b.date}|${b.time}`;
}

function enqueueUtterance(callSid, transcript) {
  if (!callSid || !transcript) return;

  // Drop an exact-duplicate transcript that lands within 4s (overlapping streams).
  const prevU = lastUtterance.get(callSid);
  if (prevU && prevU.text === transcript && Date.now() - prevU.at < 4000) {
    console.log(`[queue] Dropping duplicate utterance for ${callSid}: "${transcript}"`);
    return;
  }
  lastUtterance.set(callSid, { text: transcript, at: Date.now() });

  const prev = callQueues.get(callSid) || Promise.resolve();
  const next = prev
    .then(() => handleUtterance(callSid, transcript))
    .catch((err) => console.error('[queue] handleUtterance failed:', err.message));
  callQueues.set(callSid, next);
  next.finally(() => {
    if (callQueues.get(callSid) === next) callQueues.delete(callSid); // tail settled
  });
}

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
    const key = bookingKey(booking);
    const prior = recentBookings.get(key);

    if (prior && Date.now() - prior < BOOKING_DEDUP_MS) {
      // Already booked this exact appointment moments ago — don't book again.
      console.log(`[handleUtterance] Duplicate booking suppressed: ${key}`);
    } else {
      console.log('[handleUtterance] Booking detected:', booking);
      // Reserve the key up-front so a concurrent/rapid retry can't slip past the
      // eventually-consistent calendar conflict check.
      recentBookings.set(key, Date.now());
      try {
        const calResult = await bookAppointment(booking);
        replyText = (replyText + ' ' + calResult.message).trim();
        // Enrich the booking details with the ISO 8601 start/end (and Google
        // event id) so the end-of-call GHL appointment dual-write has a real
        // time window to anchor reminders to.
        const details = {
          ...booking,
          startTime: calResult.startTime,
          endTime: calResult.endTime,
          googleEventId: calResult.googleEventId,
        };
        bus.emit('call:booking', { callSid, details, success: calResult.success, message: calResult.message });
        if (calResult.success) {
          // Fire-and-forget: a slow or failed email must never stall the call.
          email.sendBookingConfirmation(details)
            .then((id) => id && console.log(`[Email] Confirmation sent to ${details.email}`))
            .catch((err) => console.error('[Email] Confirmation failed:', err.message));
          appendSystemNote(callSid, `Appointment booked: ${JSON.stringify(booking)}`);
        } else {
          recentBookings.delete(key); // booking failed — allow a genuine retry
        }
      } catch (calErr) {
        console.error('[handleUtterance] Calendar error:', calErr.message);
        replyText += ' Unfortunately I had trouble accessing the calendar right now.';
        recentBookings.delete(key);
      }
    }
  }

  // Pre-generate a natural human voice clip (ElevenLabs). If TTS is disabled or
  // fails, audioFile stays null and we fall back to Twilio's Polly <Say>.
  let audioFile = null;
  try {
    audioFile = await tts.generateSpeech(replyText, 'reply');
  } catch (err) {
    console.error('[handleUtterance] TTS error:', err.message);
  }

  // Redirect call to TwiML that speaks the reply
  let replyUrl =
    `${BASE_URL}/play-reply` +
    `?callSid=${encodeURIComponent(callSid)}` +
    `&text=${encodeURIComponent(replyText)}`;
  if (audioFile) replyUrl += `&audio=${encodeURIComponent(audioFile)}`;

  try {
    await redirectCall(callSid, replyUrl);
  } catch (err) {
    console.error('[handleUtterance] Failed to redirect call:', err.message);
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`\n✅ AI Receptionist running on port ${PORT}`);
  console.log(`   Patient email:  ${email.isEnabled() ? `on (from ${process.env.GMAIL_SENDER})` : 'off (set GMAIL_* vars)'}`);
  startReminderLoop();
  generateDemoAudio().then(generateDjDemoAudio);
  console.log(`   Dashboard:      ${BASE_URL}`);
  console.log(`   Twilio webhook: ${BASE_URL}/incoming-call  (HTTP POST)`);

  if (tts.isEnabled()) {
    try {
      greetingAudioFile = await tts.generateSpeech(GREETING_TEXT, 'greeting');
      console.log(`   Voice:          ${tts.activeProvider()} (greeting ${greetingAudioFile ? 'ready' : 'fallback→Polly'})\n`);
    } catch (err) {
      console.error('   Voice:          TTS greeting failed, using Polly —', err.message, '\n');
    }
  } else {
    console.log(`   Voice:          Polly Neural (set DEEPGRAM_API_KEY or ELEVENLABS_API_KEY for human voice)\n`);
  }
});
