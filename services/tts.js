'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * ElevenLabs text-to-speech.
 *
 * Generates a natural human voice for the receptionist's spoken replies. This is
 * OPTIONAL: if ELEVENLABS_API_KEY is not set, the rest of the app falls back to
 * Twilio's built-in Polly Neural voice, so the service deploys safely either way.
 *
 * Generated MP3s are written to ./audio (statically served at /audio) and cleaned
 * up after a short TTL so the directory doesn't grow without bound.
 */

const AUDIO_DIR = path.join(__dirname, '..', 'audio');

// Default voice "Rachel" — warm, natural US-English female, good for a clinic line.
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';

// Turbo/flash models keep latency low enough for a live phone call.
const MODEL_ID = process.env.ELEVENLABS_MODEL_ID || 'eleven_turbo_v2_5';

// Delete generated clips older than this so /audio doesn't fill up.
const FILE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function isEnabled() {
  return Boolean(process.env.ELEVENLABS_API_KEY);
}

function ensureAudioDir() {
  if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });
}

/** Best-effort cleanup of old generated audio files. */
function cleanupOldFiles() {
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(AUDIO_DIR)) {
      if (!f.endsWith('.mp3')) continue;
      if (f.startsWith('greeting-')) continue; // keep the long-lived greeting clip
      const full = path.join(AUDIO_DIR, f);
      try {
        if (now - fs.statSync(full).mtimeMs > FILE_TTL_MS) fs.unlinkSync(full);
      } catch (_) {}
    }
  } catch (_) {}
}

/**
 * Synthesizes `text` to an MP3 and returns the public filename (e.g.
 * "reply-ab12cd34.mp3") to be served from /audio. Returns null on any failure
 * so the caller can fall back to Polly.
 *
 * @param {string} text
 * @param {string} [prefix] - filename prefix, e.g. "reply" or "greeting"
 * @returns {Promise<string|null>}
 */
async function generateSpeech(text, prefix = 'reply') {
  if (!isEnabled() || !text || !text.trim()) return null;

  ensureAudioDir();
  cleanupOldFiles();

  // Stable name per (text, voice) so identical replies reuse a cached file.
  const hash = crypto
    .createHash('sha1')
    .update(`${VOICE_ID}:${MODEL_ID}:${text}`)
    .digest('hex')
    .slice(0, 12);
  const filename = `${prefix}-${hash}.mp3`;
  const filepath = path.join(AUDIO_DIR, filename);

  // Reuse cached audio if we already generated this exact line.
  if (fs.existsSync(filepath)) return filename;

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: MODEL_ID,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.0,
          use_speaker_boost: true,
        },
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error(`[TTS] ElevenLabs error ${res.status}: ${detail.slice(0, 200)}`);
      return null;
    }

    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(filepath, buf);
    console.log(`[TTS] Generated ${filename} (${buf.length} bytes)`);
    return filename;
  } catch (err) {
    console.error('[TTS] ElevenLabs request failed:', err.message);
    return null;
  }
}

module.exports = { isEnabled, generateSpeech };
