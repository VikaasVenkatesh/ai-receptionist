# AI Receptionist — Barebones Demo

An AI-powered phone receptionist that answers incoming calls, understands caller intent in real-time, responds intelligently, and books appointments on Google Calendar.

```
Caller dials → Twilio → Deepgram STT → Claude (Anthropic) → Twilio <Say> (Polly) → Caller hears reply
                                                         ↓
                                               Google Calendar (if booking)
```

## Tech stack

| Component | Service | Free tier |
|-----------|---------|-----------|
| Phone     | Twilio  | $15.50 trial credit |
| STT       | Deepgram| 45,000 min/year |
| LLM       | Claude claude-sonnet-4-20250514 | Pay-per-use (~$0.01–0.05/call) |
| TTS       | Twilio `<Say voice="Polly.Joanna">` | Included with Twilio |
| Calendar  | Google Calendar API | Free |
| Tunnel    | ngrok   | 1 free tunnel |

---

## Quick start

### 1. Install dependencies

```bash
npm install
```

### 2. Sign up for accounts (all free)

- **Twilio** — [twilio.com](https://twilio.com) — get a trial phone number (+$15.50 credit)
- **Deepgram** — [deepgram.com](https://deepgram.com) — free tier, no card needed
- **Google Cloud** — [console.cloud.google.com](https://console.cloud.google.com) — for Calendar API
- **ngrok** — [ngrok.com](https://ngrok.com) — free static domain available

### 3. Configure environment

```bash
cp .env.example .env
# Fill in all values in .env
```

### 4. Set up Google Calendar service account

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project (or use existing)
3. Enable **Google Calendar API**
4. Go to **IAM & Admin → Service Accounts** → Create a service account
5. Create a JSON key for the service account, download it
6. Save the key as `config/google-service-account.json`
7. Open **Google Calendar** in your browser
8. Find your calendar → **Settings** → **Share with specific people**
9. Add the service account email (`...@....iam.gserviceaccount.com`) with **"Make changes to events"** permission
10. Copy your **Calendar ID** (under "Integrate calendar") into `.env`

### 5. Run ngrok

```bash
ngrok http 3000
# Copy the https://xxxxx.ngrok-free.app URL into NGROK_URL in .env
```

Optional: claim a free static ngrok domain so the URL doesn't change:
```bash
ngrok http 3000 --domain=your-name.ngrok-free.app
```

### 6. Configure Twilio

1. Go to **Twilio Console → Phone Numbers → Manage → Active Numbers**
2. Click your number
3. Under **Voice & Fax → A call comes in**, set:
   - Webhook: `https://your-ngrok-url.ngrok-free.app/incoming-call`
   - HTTP Method: `POST`
4. Optionally set the status callback to `https://your-ngrok-url.ngrok-free.app/call-status`

### 7. Start the server

```bash
node server.js
# or for auto-restart on changes:
node --watch server.js
```

### 8. Make a test call

Call your Twilio number from any phone. You should hear the greeting and be able to have a conversation.

---

## Call flow

```
1. Twilio POST /incoming-call
2. Server returns TwiML: <Say> greeting + <Connect><Stream url="/media-stream">
3. WebSocket opens → server opens Deepgram STT stream
4. Caller speaks → Twilio streams mulaw audio → forwarded to Deepgram
5. Deepgram emits final transcript
6. Server sends transcript to Claude with conversation history
7. Claude replies (possibly with {{BOOK_APPOINTMENT: {...}}} JSON)
8. If booking found → Google Calendar API called → confirmation appended to reply
9. Server redirects call to /play-reply?text=... 
10. Twilio <Say voice="Polly.Joanna"> speaks the reply
11. New <Connect><Stream> reopens → loop back to step 4
```

---

## Customising the receptionist

Edit `config/prompts.js` to change:
- Business name, address, hours, services
- Appointment duration defaults
- Persona and tone

Edit `config/calendar-config.js` to change timezone and business hours.

---

## Upgrading TTS (optional)

The default uses Twilio's built-in Polly voices (no extra API needed).  
To switch to higher-quality Deepgram TTS, see the commented-out swap-in block in `services/tts.js`.

---

## Cost breakdown

| Service | Demo cost |
|---------|-----------|
| Twilio | ~$1/mo number + $0.0085/min (trial credit covers it) |
| Deepgram | Free (45k min/year) |
| Claude claude-sonnet-4-20250514 | ~$0.01–0.05 per call |
| Google TTS | $0 (using Twilio Polly) |
| Google Calendar | $0 |
| ngrok | $0 |

**Total: effectively free for a demo.**

---

## Project structure

```
ai-receptionist/
├── server.js                   # Express + WebSocket server, main call logic
├── services/
│   ├── twilio.js               # TwiML generation + call redirect via REST API
│   ├── deepgram.js             # Deepgram real-time STT WebSocket
│   ├── llm.js                  # Claude API, conversation history, booking parser
│   ├── tts.js                  # TTS abstraction (default: Twilio Polly)
│   └── calendar.js             # Google Calendar event creation + conflict check
├── config/
│   ├── prompts.js              # Receptionist system prompt
│   └── calendar-config.js      # Business hours, timezone, duration defaults
├── audio/                      # Temp audio files (if switching to file-based TTS)
├── .env.example
└── README.md
```
