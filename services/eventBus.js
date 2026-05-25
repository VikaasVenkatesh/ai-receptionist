'use strict';

const { EventEmitter } = require('events');

/**
 * Central event bus — all services emit here, the SSE endpoint listens here.
 *
 * Events emitted:
 *   call:started   { callSid, from, to }
 *   call:transcript { callSid, text }
 *   call:reply     { callSid, text }
 *   call:booking   { callSid, details, success, message }
 *   call:ended     { callSid }
 *   call:error     { callSid, message }
 */
const bus = new EventEmitter();
bus.setMaxListeners(50);

module.exports = bus;
