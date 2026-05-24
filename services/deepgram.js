'use strict';

const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');

/**
 * Opens a Deepgram live-transcription WebSocket configured for Twilio's
 * mulaw 8kHz audio format.
 *
 * @param {function} onTranscript - called with the final transcript string
 * @param {function} onError      - called with an Error
 * @returns {{ send: function, close: function }}
 */
function createDeepgramStream(onTranscript, onError) {
  const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

  const live = deepgram.listen.live({
    encoding: 'mulaw',
    sample_rate: 8000,
    channels: 1,
    model: 'nova-2',
    language: 'en-US',
    punctuate: true,
    interim_results: false,
    utterance_end_ms: 1500,
    vad_events: true,
  });

  live.on(LiveTranscriptionEvents.Open, () => {
    console.log('[Deepgram] Connection opened');
  });

  live.on(LiveTranscriptionEvents.Transcript, (data) => {
    const transcript = data?.channel?.alternatives?.[0]?.transcript ?? '';
    const isFinal = data?.is_final;

    if (isFinal && transcript.trim()) {
      console.log('[Deepgram] Final transcript:', transcript);
      onTranscript(transcript.trim());
    }
  });

  live.on(LiveTranscriptionEvents.UtteranceEnd, () => {
    // Deepgram signals the caller stopped speaking
    console.log('[Deepgram] Utterance end detected');
  });

  live.on(LiveTranscriptionEvents.Error, (err) => {
    console.error('[Deepgram] Error:', err);
    onError(err);
  });

  live.on(LiveTranscriptionEvents.Close, () => {
    console.log('[Deepgram] Connection closed');
  });

  return {
    send(audioBuffer) {
      if (live.getReadyState() === 1 /* OPEN */) {
        live.send(audioBuffer);
      }
    },
    close() {
      try { live.finish(); } catch (_) {}
    },
  };
}

module.exports = { createDeepgramStream };
