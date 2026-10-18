const express = require('express');
const { query, validationResult } = require('express-validator');
const Parameter = require('../models/Parameter');
const Woning = require('../models/Woning');
const { authenticate } = require('../middleware/authenticate');
const { authorizeWoning } = require('../middleware/authorizeWoning');
const { ApiError } = require('../middleware/errorHandler');
const { HaClient } = require('../services/haClient');
const { decrypt } = require('../utils/crypto');
const { coerceValue } = require('../services/ingestService');

const router = express.Router({ mergeParams: true });

const DEFAULT_RANGE_MS = 24 * 3600 * 1000;

function checkValidation(req) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(400, 'Validation failed', errors.array());
}

// Spreads each reading's value across the wall-clock time it was in effect
// (up to the next reading, or `end`) into fixed-size buckets, and returns
// each bucket's time-weighted value sum alongside how much of it is covered.
//
// HA sensors only report on change (zero-order hold: a value holds until the
// next reading), and how often a device toggles is unrelated to how long it
// actually draws power — a boiler cycling on/off reports far more readings
// while it's *on* than a device that just sits at a steady wattage. A plain
// per-bucket average (sum of values / number of readings) over-weights
// whichever device happens to report more often, not whichever one actually
// consumed more. Weighting by duration instead fixes that, for both an
// hourly average (weightedSum / coveredMs) and a daily total in kWh
// (weightedSum, treated as W·ms, converted below).
function weightedBuckets(readings, start, end, bucketMs, alignToBucketStart) {
  const startMs = alignToBucketStart(new Date(start)).getTime();
  const endMs = end.getTime();

  const sorted = readings
    .slice()
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  const weighted = new Map(); // bucketStartMs -> { weightedSum, coveredMs }

  function addSpan(value, fromMs, toMs) {
    let cursor = Math.max(fromMs, startMs);
    const spanEnd = Math.min(toMs, endMs);
    while (cursor < spanEnd) {
      const bucketStartMs = alignToBucketStart(new Date(cursor)).getTime();
      const bucketEndMs = bucketStartMs + bucketMs;
      const segmentEndMs = Math.min(spanEnd, bucketEndMs);
      const durationMs = segmentEndMs - cursor;
      const entry = weighted.get(bucketStartMs) || { weightedSum: 0, coveredMs: 0 };
      entry.weightedSum += value * durationMs;
      entry.coveredMs += durationMs;
      weighted.set(bucketStartMs, entry);
      cursor = segmentEndMs;
    }
  }

  for (let i = 0; i < sorted.length; i++) {
    const readingMs = new Date(sorted[i].timestamp).getTime();
    const nextMs = i + 1 < sorted.length ? new Date(sorted[i + 1].timestamp).getTime() : endMs;
    addSpan(sorted[i].value, readingMs, nextMs);
  }

  const buckets = [];
  for (let t = startMs; t <= endMs; t += bucketMs) {
    buckets.push({ timestampMs: t, ...(weighted.get(t) || { weightedSum: 0, coveredMs: 0 }) });
  }
  return buckets;
}

const alignToHour = (d) => {
  d.setMinutes(0, 0, 0);
  return d;
};
const alignToDay = (d) => {
  d.setHours(0, 0, 0, 0);
  return d;
};

// One point per hour: the time-weighted average value that hour. Used for
// the stacked hourly bar chart, where every series (device) needs the exact
// same set of x-values to stack correctly.
function bucketHourly(readings, start, end) {
  return weightedBuckets(readings, start, end, 3600 * 1000, alignToHour).map((b) => ({
    timestamp: new Date(b.timestampMs).toISOString(),
    value: b.coveredMs > 0 ? Math.round((b.weightedSum / b.coveredMs) * 10) / 10 : 0,
  }));
}

// One point per calendar day: total energy that day in kWh, treating each
// reading as an instantaneous power value in Watts (weightedSum is W·ms;
// dividing by 3.6e9 converts W·ms to kWh) — i.e. the actual "total verbruik"
// for that day, not an average power.
function bucketDaily(readings, start, end) {
  return weightedBuckets(readings, start, end, 24 * 3600 * 1000, alignToDay).map((b) => ({
    timestamp: new Date(b.timestampMs).toISOString(),
    value: Math.round((b.weightedSum / 3.6e9) * 100) / 100,
  }));
}

// Average value per calendar day (e.g. a temperature or average power), the
// time-weighted counterpart of bucketHourly at day granularity.
function bucketDailyAverage(readings, start, end) {
  return weightedBuckets(readings, start, end, 24 * 3600 * 1000, alignToDay).map((b) => ({
    timestamp: new Date(b.timestampMs).toISOString(),
    value: b.coveredMs > 0 ? Math.round((b.weightedSum / b.coveredMs) * 10) / 10 : 0,
  }));
}

// Daily kWh totals (see bucketDaily) summed per calendar month.
function bucketMonthly(readings, start, end) {
  const byMonth = new Map();
  for (const day of bucketDaily(readings, start, end)) {
    const key = alignToMonth(new Date(day.timestamp)).getTime();
    byMonth.set(key, (byMonth.get(key) || 0) + day.value);
  }
  return [...byMonth.entries()].map(([ms, value]) => ({
    timestamp: new Date(ms).toISOString(),
    value: Math.round(value * 100) / 100,
  }));
}

const alignToMonth = (d) => {
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
};

// HA's recorder purges raw state history after this long by default; older
// data only survives as long-term statistics.
const HA_HISTORY_RETENTION_MS = 10 * 24 * 3600 * 1000;

/**
 * The same buckets as the history-based functions above, built from HA's
 * hourly long-term statistics instead: those are kept indefinitely (for any
 * sensor with a state_class), so month and year views work even though raw
 * history is gone after ~10 days — and a year of hourly rows is far lighter
 * than a year of raw state changes. Each hourly `mean` is that hour's
 * time-weighted average, so summing means of a W sensor gives Wh. Returns
 * null when the sensor has no statistics, for the caller to fall back to
 * raw history.
 */
async function statisticsBuckets(client, parameter, start, end, interval) {
  const result = await client.fetchStatistics([parameter.entityId], {
    start: start.toISOString(),
    end: end.toISOString(),
    period: 'hour',
    types: ['mean'],
  });
  const sign = parameter.invert ? -1 : 1;
  const hourly = (result[parameter.entityId] || [])
    .filter((r) => typeof r.mean === 'number')
    .map((r) => ({
      t: typeof r.start === 'number' ? r.start : new Date(r.start).getTime(),
      v: r.mean * sign,
    }));
  if (hourly.length === 0) return null;

  if (!interval || interval === 'hour') {
    return hourly.map((p) => ({ timestamp: new Date(p.t).toISOString(), value: Math.round(p.v * 10) / 10 }));
  }

  const align = interval === 'month' ? alignToMonth : alignToDay;
  const advance = (d) => {
    if (interval === 'month') d.setMonth(d.getMonth() + 1);
    else d.setDate(d.getDate() + 1);
    return d;
  };
  const sums = new Map(); // bucketStartMs -> { sum, count }
  for (const p of hourly) {
    const key = align(new Date(p.t)).getTime();
    const entry = sums.get(key) || { sum: 0, count: 0 };
    entry.sum += p.v;
    entry.count += 1;
    sums.set(key, entry);
  }
  const buckets = [];
  for (let d = align(new Date(start)); d <= end; d = advance(d)) {
    const entry = sums.get(d.getTime());
    let value = 0;
    if (entry && interval === 'day_avg') value = Math.round((entry.sum / entry.count) * 10) / 10;
    else if (entry) value = Math.round((entry.sum / 1000) * 100) / 100; // Wh -> kWh
    buckets.push({ timestamp: d.toISOString(), value });
  }
  return buckets;
}

router.use(authenticate, authorizeWoning());

// History for a single parameter, for the drill-down chart. Fetched live
// from Home Assistant's REST history API (/api/history/period) instead of
// being persisted in MongoDB. Defaults to the last 24 hours; a custom start
// timestamp can be passed via `from`.
router.get(
  '/',
  [
    query('parameterId').isMongoId(),
    query('from').optional().isISO8601(),
    query('to').optional().isISO8601(),
    // hour: average per hour · day/month: kWh total per day/month (from a W
    // sensor) · day_avg: average per day.
    query('interval').optional().isIn(['hour', 'day', 'month', 'day_avg']),
  ],
  async (req, res, next) => {
    try {
      checkValidation(req);
      const { parameterId, from, to, interval } = req.query;

      const parameter = await Parameter.findOne({
        _id: parameterId,
        woning: req.params.woningId,
      });
      if (!parameter) throw new ApiError(404, 'Parameter not found for this woning');

      const woning = await Woning.findById(req.params.woningId).select('+haTokenEncrypted');
      if (!woning) throw new ApiError(404, 'Woning not found');

      const start = from ? new Date(from) : new Date(Date.now() - DEFAULT_RANGE_MS);
      // HA's /api/history/period defaults end_time to start + 1 day when it's
      // omitted, silently truncating any longer range. Always pass an
      // explicit end so a multi-day query actually returns multiple days.
      const end = to ? new Date(to) : new Date();

      const client = new HaClient({
        baseUrl: woning.haBaseUrl,
        token: decrypt(woning.haTokenEncrypted),
      });

      // Aggregated views come from long-term statistics when the sensor has
      // them; so does anything reaching back past HA's raw history.
      const reachesPastHistory = Date.now() - start.getTime() > HA_HISTORY_RETENTION_MS;
      if (interval === 'day' || interval === 'month' || interval === 'day_avg' || reachesPastHistory) {
        const fromStats = await statisticsBuckets(client, parameter, start, end, interval).catch(() => null);
        if (fromStats) return res.json(fromStats);
      }

      const states = await client.fetchHistory(parameter.entityId, {
        start: start.toISOString(),
        end: end.toISOString(),
      });

      let readings = states
        .map((s) => {
          const value = coerceValue(s.state);
          return {
            value: parameter.invert && typeof value === 'number' ? -value : value,
            timestamp: s.last_changed || s.last_updated,
          };
        })
        .filter((r) => typeof r.value === 'number');

      if (interval === 'hour') readings = bucketHourly(readings, start, end);
      else if (interval === 'day') readings = bucketDaily(readings, start, end);
      else if (interval === 'month') readings = bucketMonthly(readings, start, end);
      else if (interval === 'day_avg') readings = bucketDailyAverage(readings, start, end);

      res.json(readings);
    } catch (err) {
      if (err.isAxiosError) {
        return next(new ApiError(502, 'Historiek ophalen bij Home Assistant mislukt'));
      }
      next(err);
    }
  }
);

module.exports = router;
