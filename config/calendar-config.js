'use strict';

const CALENDAR_CONFIG = {
  timezone: 'America/New_York',
  defaultDurationMinutes: 30,
  businessHours: {
    start: 9,   // 9am
    end: 17,    // 5pm
    days: [1, 2, 3, 4, 5], // Monday–Friday (0=Sunday)
  },
};

module.exports = { CALENDAR_CONFIG };
