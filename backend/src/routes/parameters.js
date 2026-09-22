const express = require('express');
const { body, validationResult } = require('express-validator');
const Parameter = require('../models/Parameter');
const Reading = require('../models/Reading');
const Woning = require('../models/Woning');
const { authenticate, requireSuperadmin } = require('../middleware/authenticate');
const { authorizeWoning } = require('../middleware/authorizeWoning');
const { ApiError } = require('../middleware/errorHandler');
const { PARAMETER_TYPES } = require('../models/Parameter');
const { haConnectionManager } = require('../services/haConnectionManager');
const { HaClient } = require('../services/haClient');
const { decrypt } = require('../utils/crypto');

const router = express.Router({ mergeParams: true });

function checkValidation(req) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(400, 'Validation failed', errors.array());
}

// Normalizes an entso-e-style "dynamic prices" entity's forecast attributes
// into a flat, sorted, de-duplicated list of hourly points. Prefers the
// `prices_today` + `prices_tomorrow` split (today's full curve, extended
// with tomorrow's once ENTSO-E publishes it, usually mid-afternoon) over
// the raw `prices` attribute, which on at least the integration this was
// built against is a rolling window that includes yesterday's — already
// irrelevant — hours instead of only what's ahead. Falls back to `prices`
// when the split isn't present, for other integrations that only expose
// that one attribute.
function normalizePricePoints(attributes) {
  const today = Array.isArray(attributes?.prices_today) ? attributes.prices_today : [];
  const tomorrow = Array.isArray(attributes?.prices_tomorrow) ? attributes.prices_tomorrow : [];
  const combined = [...today, ...tomorrow];
  const source = combined.length > 0 ? combined : Array.isArray(attributes?.prices) ? attributes.prices : [];

  const byTimestampMs = new Map();
  for (const entry of source) {
    const rawTime = entry?.time ?? entry?.timestamp ?? entry?.datetime;
    const price = entry?.price ?? entry?.value;
    if (!rawTime || typeof price !== 'number') continue;
    // HA's entso-e integration formats `time` as "2026-09-22 00:00:00+02:00"
    // (a space instead of the "T" ISO needs to parse reliably everywhere).
    const date = new Date(String(rawTime).replace(' ', 'T'));
    if (Number.isNaN(date.getTime())) continue;
    byTimestampMs.set(date.getTime(), price);
  }

  return [...byTimestampMs.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ms, price]) => ({ timestamp: new Date(ms).toISOString(), price }));
}

router.use(authenticate, authorizeWoning());

// List parameters for a woning, each enriched with its latest reading.
router.get('/', async (req, res, next) => {
  try {
    const parameters = await Parameter.find({ woning: req.params.woningId }).sort({
      createdAt: 1,
    });

    const withLatest = await Promise.all(
      parameters.map(async (p) => {
        const latest = await Reading.findOne({ parameter: p._id }).sort({ timestamp: -1 });
        return {
          // flattenMaps: plain toObject() leaves optionLabels as a Map
          // instance, which JSON.stringify then serializes as "{}".
          ...p.toObject({ flattenMaps: true }),
          latest: latest ? { value: latest.value, timestamp: latest.timestamp } : null,
        };
      })
    );

    res.json(withLatest);
  } catch (err) {
    next(err);
  }
});

// Live hourly price forecast for a parameter backed by a dynamic-prices HA
// entity (e.g. the entso-e integration's "average electricity price"
// sensor). Fetched fresh from HA on every request rather than served from
// stored Readings: the whole point is the sensor's forward-looking forecast
// for hours that haven't happened yet, which by definition has no reading
// history yet.
router.get('/:parameterId/price-forecast', async (req, res, next) => {
  try {
    const parameter = await Parameter.findOne({
      _id: req.params.parameterId,
      woning: req.params.woningId,
    });
    if (!parameter) throw new ApiError(404, 'Parameter not found for this woning');

    const woning = await Woning.findById(req.params.woningId).select('+haTokenEncrypted');
    if (!woning) throw new ApiError(404, 'Woning not found');

    const client = new HaClient({
      baseUrl: woning.haBaseUrl,
      token: decrypt(woning.haTokenEncrypted),
    });
    const state = await client.fetchState(parameter.entityId);
    const points = normalizePricePoints(state.attributes);

    res.json({ unit: state.attributes?.unit_of_measurement || parameter.unit || '', points });
  } catch (err) {
    if (err.isAxiosError) {
      return next(new ApiError(502, 'Prijsdata ophalen bij Home Assistant mislukt'));
    }
    next(err);
  }
});

router.post(
  '/',
  requireSuperadmin,
  [
    body('entityId').isString().notEmpty(),
    body('type').isIn(PARAMETER_TYPES),
    body('label').isString().notEmpty(),
    body('unit').optional().isString(),
    body('icon').optional().isString(),
    body('category').optional().isString(),
    body('controllable').optional().isBoolean(),
    body('controlDomain').optional().isString(),
    body('favorite').optional().isBoolean(),
    body('invert').optional().isBoolean(),
    body('options').optional().isArray(),
    body('options.*').optional().isString(),
    body('optionLabels').optional().isObject(),
  ],
  async (req, res, next) => {
    try {
      checkValidation(req);
      const parameter = await Parameter.create({
        woning: req.params.woningId,
        entityId: req.body.entityId,
        type: req.body.type,
        label: req.body.label,
        unit: req.body.unit,
        icon: req.body.icon,
        category: req.body.category || '',
        controllable: req.body.controllable || false,
        controlDomain: req.body.controlDomain,
        favorite: req.body.favorite || false,
        invert: req.body.invert || false,
        options: req.body.options || [],
        optionLabels: req.body.optionLabels,
        createdBy: req.user._id,
      });

      await haConnectionManager.resubscribe(req.params.woningId);
      res.status(201).json(parameter);
    } catch (err) {
      next(err);
    }
  }
);

router.patch(
  '/:parameterId',
  requireSuperadmin,
  [
    body('label').optional().isString().notEmpty(),
    body('unit').optional().isString(),
    body('icon').optional().isString(),
    body('category').optional().isString(),
    body('controllable').optional().isBoolean(),
    body('controlDomain').optional().isString(),
    body('type').optional().isIn(PARAMETER_TYPES),
    body('favorite').optional().isBoolean(),
    body('invert').optional().isBoolean(),
    body('options').optional().isArray(),
    body('options.*').optional().isString(),
    body('optionLabels').optional().isObject(),
  ],
  async (req, res, next) => {
    try {
      checkValidation(req);
      const parameter = await Parameter.findOneAndUpdate(
        { _id: req.params.parameterId, woning: req.params.woningId },
        req.body,
        { new: true }
      );
      if (!parameter) throw new ApiError(404, 'Parameter not found');
      res.json(parameter);
    } catch (err) {
      next(err);
    }
  }
);

// Copies this parameter's definition (entityId, type, label, settings — a
// fresh document, not linked to this one) into one or more other woningen.
// Always creates rather than upserting: since an entity can now be mapped
// more than once per woning (see `invert`), matching an existing target
// parameter to overwrite would be ambiguous.
router.post(
  '/:parameterId/copy',
  requireSuperadmin,
  [body('targetWoningIds').isArray({ min: 1 }), body('targetWoningIds.*').isMongoId()],
  async (req, res, next) => {
    try {
      checkValidation(req);
      const parameter = await Parameter.findOne({
        _id: req.params.parameterId,
        woning: req.params.woningId,
      });
      if (!parameter) throw new ApiError(404, 'Parameter not found');

      const targetIds = [...new Set(req.body.targetWoningIds)].filter(
        (id) => id !== req.params.woningId
      );
      const existingWoningen = await Woning.find({ _id: { $in: targetIds } }, '_id');
      const existingIds = new Set(existingWoningen.map((w) => w._id.toString()));

      const results = [];
      for (const targetWoningId of targetIds) {
        if (!existingIds.has(targetWoningId)) {
          results.push({ woningId: targetWoningId, status: 'error', message: 'Woning niet gevonden' });
          continue;
        }
        try {
          const copy = await Parameter.create({
            woning: targetWoningId,
            entityId: parameter.entityId,
            type: parameter.type,
            label: parameter.label,
            unit: parameter.unit,
            icon: parameter.icon,
            category: parameter.category,
            controllable: parameter.controllable,
            favorite: parameter.favorite,
            invert: parameter.invert,
            controlDomain: parameter.controlDomain,
            options: parameter.options,
            optionLabels: parameter.optionLabels,
            createdBy: req.user._id,
          });
          await haConnectionManager.resubscribe(targetWoningId);
          results.push({ woningId: targetWoningId, status: 'created', parameterId: copy._id });
        } catch (err) {
          results.push({ woningId: targetWoningId, status: 'error', message: err.message });
        }
      }

      res.json({ results });
    } catch (err) {
      next(err);
    }
  }
);

router.delete('/:parameterId', requireSuperadmin, async (req, res, next) => {
  try {
    const parameter = await Parameter.findOneAndDelete({
      _id: req.params.parameterId,
      woning: req.params.woningId,
    });
    if (!parameter) throw new ApiError(404, 'Parameter not found');
    await haConnectionManager.resubscribe(req.params.woningId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
