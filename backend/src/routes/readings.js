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
  ],
  async (req, res, next) => {
    try {
      checkValidation(req);
      const { parameterId, from, to } = req.query;

      const parameter = await Parameter.findOne({
        _id: parameterId,
        woning: req.params.woningId,
      });
      if (!parameter) throw new ApiError(404, 'Parameter not found for this woning');

      const woning = await Woning.findById(req.params.woningId).select('+haTokenEncrypted');
      if (!woning) throw new ApiError(404, 'Woning not found');

      const start = from ? new Date(from) : new Date(Date.now() - DEFAULT_RANGE_MS);
      const end = to ? new Date(to) : undefined;

      const client = new HaClient({
        baseUrl: woning.haBaseUrl,
        token: decrypt(woning.haTokenEncrypted),
      });
      const states = await client.fetchHistory(parameter.entityId, {
        start: start.toISOString(),
        end: end?.toISOString(),
      });

      const readings = states
        .map((s) => ({
          value: coerceValue(s.state),
          timestamp: s.last_changed || s.last_updated,
        }))
        .filter((r) => r.value !== null);

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
