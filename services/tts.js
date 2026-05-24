'use strict';

/**
 * TTS via Twilio's built-in <Say voice="Polly.Joanna"> — zero additional API.
 *
 * This module is a thin wrapper so swapping to Deepgram or Google TTS later
 * only requires changing this file.  The "synthesize" function here simply
 * returns the text unchanged; the actual speech synthesis happens in the
 * TwiML <Say> element inside services/twilio.js.
 */

/**
 * Returns the text as-is.  Twilio handles synthesis via <Say>.
 * Signature intentionally mirrors what a real TTS service would return
 * so swapping is easy.
 *
 * @param {string} text
 * @returns {Promise<{ text: string }>}
 */
async function synthesize(text) {
  return { text };
}

module.exports = { synthesize };

/*
 * --------------------------------------------------------------------------
 * SWAP-IN: Deepgram TTS (uncomment to use)
 * --------------------------------------------------------------------------
 * const fetch = require('node-fetch');
 * const fs = require('fs');
 * const path = require('path');
 * const crypto = require('crypto');
 *
 * async function synthesize(text) {
 *   const response = await fetch('https://api.deepgram.com/v1/speak?model=aura-asteria-en', {
 *     method: 'POST',
 *     headers: {
 *       Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
 *       'Content-Type': 'application/json',
 *     },
 *     body: JSON.stringify({ text }),
 *   });
 *   const buffer = Buffer.from(await response.arrayBuffer());
 *   const filename = crypto.randomUUID() + '.mp3';
 *   const filepath = path.join(__dirname, '..', 'audio', filename);
 *   fs.writeFileSync(filepath, buffer);
 *   return { text, audioFile: filename };
 * }
 * --------------------------------------------------------------------------
 */
