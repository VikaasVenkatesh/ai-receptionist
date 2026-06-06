'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Text-to-speech with provider fallback.
 *
 * Produces a natural human voice for the receptionist's spoken replies. We try
 * providers in order and use the first that succeeds:
 *
 *   1. ElevenLabs  — best quality, but their FREE tier blocks API calls from
 *                    datacenter/cloud IPs ("unusual activity"), so it only works
 *                    here on a PAID plan. Enabled when ELEVENLABS_API_KEY is set.
 *   2. Deepgram Aura — natural neural voice that works fine from cloud IPs and
 *                    reuses the Deepgram key we already have for speech-to-text.
 *   3. (none)      — caller falls back to Twilio's Polly Neural <Say>.
 *
 * Generated MP3s are written to ./audio (statically served at /audio) and cleaned
 * up after a short TTL so the directory doesn't grow without bound.
 */

const AUDIO_DIR = path.join(__dirname, '..', 'audio');

// ── ElevenLabs config ────────────────────────────────────────────────────────
// Default voice "Sarah" — mature, reassuring; works on free voices list.
const EL_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL';
const EL_MODEL_ID = process.env.ELEVENLABS_MODEL_ID || 'eleven_turbo_v2_5';

// ── Deepgram Aura config ─────────────────────────────────────────────────────
// "Asteria" — warm, natural US-English female, good for a clinic line.
const AURA_MODEL = process.env.DEEPGRAM_TTS_MODEL || 'aura-asteria-en';

// Delete generated clips older than this so /audio doesn't fill up.
const FILE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** Which provider, if any, is configured. Used for startup logging. */
function activeProvider() {
  if (process.env.ELEVENLABS_API_KEY) return 'elevenlabs';
  if (process.env.DEEPGRAM_API_KEY) return 'deepgram-aura';
  return null;
}

function isEnabled() {
  return activeProvider() !== null;
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

/** ElevenLabs synthesis → MP3 Buffer, or null on failure. */
async function elevenLabs(text) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${EL_VOICE_ID}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': process.env.ELEVENLABS_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: EL_MODEL_ID,
      voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true },
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error(`[TTS] ElevenLabs error ${res.status}: ${detail.slice(0, 160)}`);
    return null;
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Deepgram Aura synthesis → MP3 Buffer, or null on failure. */
async function deepgramAura(text) {
  const url = `https://api.deepgram.com/v1/speak?model=${encodeURIComponent(AURA_MODEL)}&encoding=mp3`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error(`[TTS] Deepgram Aura error ${res.status}: ${detail.slice(0, 160)}`);
    return null;
  }
  return Buffer.from(await res.arrayBuffer());
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
  const provider = activeProvider();
  if (!provider || !text || !text.trim()) return null;

  ensureAudioDir();
  cleanupOldFiles();

  // Stable name per (provider, voice, text) so identical replies reuse a file.
  const voiceTag = provider === 'elevenlabs' ? `${EL_VOICE_ID}:${EL_MODEL_ID}` : AURA_MODEL;
  const hash = crypto
    .createHash('sha1')
    .update(`${provider}:${voiceTag}:${text}`)
    .digest('hex')
    .slice(0, 12);
  const filename = `${prefix}-${hash}.mp3`;
  const filepath = path.join(AUDIO_DIR, filename);

  // Reuse cached audio if we already generated this exact line.
  if (fs.existsSync(filepath)) return filename;

  try {
    let buf = null;

    // Try the preferred provider first; on failure, fall through to Aura if we
    // have a Deepgram key (covers ElevenLabs free-tier datacenter-IP blocks).
    if (provider === 'elevenlabs') {
      buf = await elevenLabs(text);
      if (!buf && process.env.DEEPGRAM_API_KEY) buf = await deepgramAura(text);
    } else {
      buf = await deepgramAura(text);
    }

    if (!buf) return null;

    fs.writeFileSync(filepath, buf);
    console.log(`[TTS] Generated ${filename} (${buf.length} bytes)`);
    return filename;
  } catch (err) {
    console.error('[TTS] Synthesis failed:', err.message);
    return null;
  }
}

module.exports = { isEnabled, generateSpeech, activeProvider };
