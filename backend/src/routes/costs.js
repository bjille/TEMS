const express = require('express');
const { body, query, validationResult } = require('express-validator');
const CostTracker = require('../models/CostTracker');
const EnergyCost = require('../models/EnergyCost');
const Parameter = require('../models/Parameter');
const { authenticate } = require('../middleware/authenticate');
const { authorizeWoning } = require('../middleware/authorizeWoning');
const { ApiError } = require('../middleware/errorHandler');
const { costEngine } = require('../services/costEngine');

const router = express.Router({ mergeParams: true });

const POPULATE_FIELDS = 'label unit type entityId';
const POPULATE_PATHS = [
  { path: 'meterParameter', select: POPULATE_FIELDS },
  { path: 'priceParameter', select: POPULATE_FIELDS },
];

const TRACKER_FIELDS = ['name', 'meterParameter', 'priceParameter', 'meterConversionFactor', 'validFrom'];
// Changing any of these changes what past quarters cost, so they trigger a
// full recalculation; renaming doesn't.
const RECOMPUTE_FIELDS = TRACKER_FIELDS.filter((f) => f !== 'name');

function checkValidation(req) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(400, 'Validation failed', errors.array());
}

const trackerValidators = [
  body('name').isString().notEmpty(),
  body('meterParameter').isMongoId(),
  body('priceParameter').isMongoId(),
  body('meterConversionFactor').optional().isFloat({ gt: 0 }),
  body('validFrom').isISO8601(),
];

function pickFields(source) {
  const fields = {};
  for (const key of TRACKER_FIELDS) if (key in source) fields[key] = source[key];
  return fields;
}

async function assertParametersBelongToWoning(fields, woningId) {
  const ids = [fields.meterParameter, fields.priceParameter].filter(Boolean);
  const count = await Parameter.countDocuments({ _id: { $in: ids }, woning: woningId });
  if (count !== new Set(ids.map(String)).size) {
    throw new ApiError(400, 'Eén of meer sensoren horen niet bij deze woning');
  }
}

// Kicks off a (possibly long) full recalculation in the background, so a
// save returns immediately; the page polls `computedUntil` for progress.
function recomputeInBackground(trackerId) {
  costEngine.recompute(trackerId).catch((err) => console.error(`Recompute of tracker ${trackerId} failed:`, err));
}

router.use(authenticate, authorizeWoning());

router.get('/trackers', async (req, res, next) => {
  try {
    const trackers = await CostTracker.find({ woning: req.params.woningId })
      .sort({ createdAt: 1 })
      .populate(POPULATE_PATHS);
    res.json(trackers);
  } catch (err) {
    next(err);
  }
});

router.post('/trackers', authorizeWoning(['owner']), trackerValidators, async (req, res, next) => {
  try {
    checkValidation(req);
    const fields = pickFields(req.body);
    await assertParametersBelongToWoning(fields, req.params.woningId);
    const tracker = await CostTracker.create({ ...fields, woning: req.params.woningId, createdBy: req.user._id });
    recomputeInBackground(tracker._id);
    res.status(201).json(await tracker.populate(POPULATE_PATHS));
  } catch (err) {
    next(err);
  }
});

// `keepHistory: true` swaps a sensor without recalculating what's already
// computed: the calculation simply continues from `computedUntil` with the
// new sensor — e.g. to replace a deleted price sensor.
router.patch(
  '/trackers/:trackerId',
  authorizeWoning(['owner']),
  [...trackerValidators.map((v) => v.optional()), body('keepHistory').optional().isBoolean()],
  async (req, res, next) => {
    try {
      checkValidation(req);
      const updates = pickFields(req.body);
      const keepHistory = req.body.keepHistory === true;
      if (keepHistory) updates.lastError = null;
      await assertParametersBelongToWoning(updates, req.params.woningId);
      const tracker = await CostTracker.findOneAndUpdate(
        { _id: req.params.trackerId, woning: req.params.woningId },
        updates,
        { new: true, runValidators: true }
      );
      if (!tracker) throw new ApiError(404, 'Kostenberekening niet gevonden');
      if (!keepHistory && RECOMPUTE_FIELDS.some((f) => f in updates)) recomputeInBackground(tracker._id);
      res.json(await tracker.populate(POPULATE_PATHS));
    } catch (err) {
      next(err);
    }
  }
);

router.post('/trackers/:trackerId/recompute', authorizeWoning(['owner']), async (req, res, next) => {
  try {
    const tracker = await CostTracker.findOne({ _id: req.params.trackerId, woning: req.params.woningId });
    if (!tracker) throw new ApiError(404, 'Kostenberekening niet gevonden');
    recomputeInBackground(tracker._id);
    res.status(202).json({ status: 'started' });
  } catch (err) {
    next(err);
  }
});

router.delete('/trackers/:trackerId', authorizeWoning(['owner']), async (req, res, next) => {
  try {
    const tracker = await CostTracker.findOneAndDelete({ _id: req.params.trackerId, woning: req.params.woningId });
    if (!tracker) throw new ApiError(404, 'Kostenberekening niet gevonden');
    await EnergyCost.deleteMany({ tracker: tracker._id });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

const ALIGN = {
  hour: (d) => {
    d.setMinutes(0, 0, 0);
    return d;
  },
  day: (d) => {
    d.setHours(0, 0, 0, 0);
    return d;
  },
  month: (d) => {
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    return d;
  },
};

function nextBucket(date, interval) {
  const d = new Date(date);
  if (interval === 'hour') d.setHours(d.getHours() + 1);
  else if (interval === 'day') d.setDate(d.getDate() + 1);
  else d.setMonth(d.getMonth() + 1);
  return d;
}

// The unit quantities are expressed in: the price's per-unit ("€/kWh" ->
// "kWh"; €/MWh is converted to per kWh), since that's what the meter's rise
// was converted into — falling back to the meter's own unit.
function pricedUnit(tracker) {
  const perUnit = (tracker.priceParameter?.unit || '').split('/')[1]?.trim();
  if (perUnit) return /^mwh$/i.test(perUnit) ? 'kWh' : perUnit;
  return tracker.meterParameter?.unit || '';
}

/**
 * Per tracker, its stored hours over [from, to) summed into buckets of
 * `interval`, plus totals: how much was used, what it cost, the average price
 * actually paid per unit (weighted by when it was used) and the plain average
 * price over the same hours — paid below average means usage landed in the
 * cheaper moments.
 */
router.get(
  '/',
  [query('from').isISO8601(), query('to').isISO8601(), query('interval').optional().isIn(['hour', 'day', 'month'])],
  async (req, res, next) => {
    try {
      checkValidation(req);
      const interval = req.query.interval || 'day';
      const from = ALIGN[interval](new Date(req.query.from));
      const to = new Date(req.query.to);

      const trackers = await CostTracker.find({ woning: req.params.woningId })
        .sort({ createdAt: 1 })
        .populate(POPULATE_PATHS)
        .lean();
      const quarters = await EnergyCost.find({
        woning: req.params.woningId,
        start: { $gte: from, $lt: to },
      })
        .sort({ start: 1 })
        .lean();

      const bucketStarts = [];
      for (let d = new Date(from); d < to; d = nextBucket(d, interval)) bucketStarts.push(d);
      const bucketIndex = (t) => {
        let lo = 0;
        let hi = bucketStarts.length - 1;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          if (bucketStarts[mid].getTime() <= t) lo = mid;
          else hi = mid - 1;
        }
        return lo;
      };

      const byTracker = new Map(
        trackers.map((t) => [
          t._id.toString(),
          {
            buckets: bucketStarts.map((s) => ({ start: s.toISOString(), quantity: 0, cost: 0 })),
            priceSum: 0,
            priceCount: 0,
          },
        ])
      );
      for (const q of quarters) {
        const entry = byTracker.get(q.tracker.toString());
        if (!entry || bucketStarts.length === 0) continue;
        const bucket = entry.buckets[bucketIndex(q.start.getTime())];
        bucket.quantity += q.quantity;
        bucket.cost += q.cost;
        entry.priceSum += q.price;
        entry.priceCount += 1;
      }

      res.json({
        interval,
        from: from.toISOString(),
        to: to.toISOString(),
        trackers: trackers.map((t) => {
          const entry = byTracker.get(t._id.toString());
          const quantity = entry.buckets.reduce((s, b) => s + b.quantity, 0);
          const cost = entry.buckets.reduce((s, b) => s + b.cost, 0);
          return {
            _id: t._id,
            name: t.name,
            unit: pricedUnit(t),
            buckets: entry.buckets,
            totals: {
              quantity,
              cost,
              avgPaidPrice: quantity > 0 ? cost / quantity : null,
              avgPrice: entry.priceCount > 0 ? entry.priceSum / entry.priceCount : null,
            },
          };
        }),
      });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
