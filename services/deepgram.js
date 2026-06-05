'use strict';

const WebSocket = require('ws');

/**
 * Opens a raw WebSocket to Deepgram's live transcription endpoint,
 * configured for Twilio's mulaw 8 kHz audio format.
 *
 * Using a direct ws connection instead of the Deepgram SDK to avoid
 * SDK version quirks with WebSocket lifecycle management.
 *
 * @param {function} onTranscript - called with the final transcript string
 * @param {function} onError      - called with an Error
 * @returns {{ send: function, close: function }}
 */
function createDeepgramStream(onTranscript, onError) {
  const params = new URLSearchParams({
    encoding:        'mulaw',
    sample_rate:     '8000',
    channels:        '1',
    model:           'nova-2',
    language:        'en-US',
    punctuate:       'true',
    interim_results: 'true',   // required for utterance_end_ms to work
    utterance_end_ms:'1500',
    vad_events:      'true',
  });

  const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;

  const ws = new WebSocket(url, {
    headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` },
  });

  ws.on('open', () => {
    console.log('[Deepgram] Connection opened');
  });

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    // Final transcript
    if (data.type === 'Results') {
      const transcript = data?.channel?.alternatives?.[0]?.transcript ?? '';
      const isFinal    = data?.is_final;
      if (isFinal && transcript.trim()) {
        console.log('[Deepgram] Transcript:', transcript);
        onTranscript(transcript.trim());
      }
    }

    // Utterance end (caller stopped talking)
    if (data.type === 'UtteranceEnd') {
      console.log('[Deepgram] Utterance end');
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`[Deepgram] Connection closed (code=${code} reason=${reason})`);
    if (code !== 1000) {
      const err = new Error(`Deepgram closed with code ${code}: ${reason}`);
      err.code = code;
      onError(err);
    }
  });

  ws.on('error', (err) => {
    // Attach HTTP status if present (e.g. 429 rate limit)
    const status = err.message.match(/(\d{3})/)?.[1];
    if (status) err.httpStatus = parseInt(status, 10);
    console.error('[Deepgram] WebSocket error:', err.message);
    onError(err);
  });

  return {
    send(audioBuffer) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(audioBuffer);
      }
    },
    close() {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, 'call ended');
      }
    },
  };
}

module.exports = { createDeepgramStream };
