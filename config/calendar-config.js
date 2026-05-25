'use strict';

const CALENDAR_CONFIG = {
  timezone: 'America/Los_Angeles',
  defaultDurationMinutes: 30,
  businessHours: {
    // Tue–Fri: 9am–6pm, Sat: 9am–1pm. Closed Sun & Mon.
    // For simplicity, the booking logic uses a single window per day.
    // Saturday's shorter end (1pm) is handled by the LLM prompt instruction.
    start: 9,   // 9am
    end: 18,    // 6pm (Tue–Fri); LLM is prompted to cap Sat at 1pm
    days: [2, 3, 4, 5, 6], // Tuesday(2)–Friday(5) + Saturday(6)
  },
};

module.exports = { CALENDAR_CONFIG };
