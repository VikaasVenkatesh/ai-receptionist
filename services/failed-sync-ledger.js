'use strict';

/**
 * Best-effort ledger of GHL syncs that failed or were skipped, for runtime
 * visibility and manual retry.
 *
 * NOTE: Railway's filesystem is ephemeral — this does NOT survive a redeploy.
 * It's "best-effort visibility during a runtime session." V2 swaps to Supabase.
 * Don't rely on it as the primary alerting tool; watch logs for "❌ Failed to sync".
 */

const fs = require('fs').promises;
const path = require('path');

const LEDGER_PATH = path.join(__dirname, '..', 'data', 'failed-syncs.json');

async function writeFailedSync(callSid, payload) {
  try {
    let ledger = [];
    try {
      const raw = await fs.readFile(LEDGER_PATH, 'utf8');
      ledger = JSON.parse(raw);
    } catch { /* file doesn't exist yet */ }

    ledger.push({ callSid, timestamp: new Date().toISOString(), payload });

    if (ledger.length > 1000) ledger = ledger.slice(-1000); // keep last 1000

    await fs.mkdir(path.dirname(LEDGER_PATH), { recursive: true });
    await fs.writeFile(LEDGER_PATH, JSON.stringify(ledger, null, 2));
  } catch (err) {
    console.error('[failed-sync-ledger] Could not write:', err.message);
  }
}

async function readFailedSync(callSid) {
  try {
    const raw = await fs.readFile(LEDGER_PATH, 'utf8');
    const ledger = JSON.parse(raw);
    // Most recent entry for this callSid wins.
    return [...ledger].reverse().find((e) => e.callSid === callSid) || null;
  } catch {
    return null;
  }
}

async function listFailedSyncs() {
  try {
    const raw = await fs.readFile(LEDGER_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

module.exports = { writeFailedSync, readFailedSync, listFailedSyncs };
