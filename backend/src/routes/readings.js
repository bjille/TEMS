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

// Collapses raw readings into one point per hour (averaging whatever values
// fall in that hour), filling every hour in [start, end] — even ones with no
// readings — with 0. Used for the stacked hourly bar chart, where every
// series (device) needs the exact same set of x-values to stack correctly.
function bucketHourly(readings, start, end) {
  const sums = new Map();
  for (const r of readings) {
    const hourStart = new Date(r.timestamp);
    hourStart.setMinutes(0, 0, 0);
    const key = hourStart.getTime();
    const bucket = sums.get(key) || { sum: 0, count: 0 };
    bucket.sum += r.value;
    bucket.count += 1;
    sums.set(key, bucket);
  }

  const bucketed = [];
  const cursor = new Date(start);
  cursor.setMinutes(0, 0, 0);
  for (let t = cursor.getTime(); t <= end.getTime(); t += 3600 * 1000) {
    const bucket = sums.get(t);
    bucketed.push({
      timestamp: new Date(t).toISOString(),
      value: bucket ? Math.round((bucket.sum / bucket.count) * 10) / 10 : 0,
    });
  }
  return bucketed;
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
    query('interval').optional().isIn(['hour']),
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
      const states = await client.fetchHistory(parameter.entityId, {
        start: start.toISOString(),
        end: end.toISOString(),
      });

      let readings = states
        .map((s) => ({
          value: coerceValue(s.state),
          timestamp: s.last_changed || s.last_updated,
        }))
        .filter((r) => typeof r.value === 'number');

      if (interval === 'hour') readings = bucketHourly(readings, start, end);

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
