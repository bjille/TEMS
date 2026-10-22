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
const { fetchPriceForecast } = require('../services/priceForecastService');
const DashboardChart = require('../models/DashboardChart');
const Automation = require('../models/Automation');
const CostTracker = require('../models/CostTracker');
const SmartChargePlan = require('../models/SmartChargePlan');

const router = express.Router({ mergeParams: true });

function checkValidation(req) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(400, 'Validation failed', errors.array());
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

    const forecast = await fetchPriceForecast(parameter, woning);
    res.json(forecast);
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
    body('badge').optional().isBoolean(),
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
        badge: req.body.badge || false,
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
    body('badge').optional().isBoolean(),
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
            badge: parameter.badge,
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

// Everything in the woning that still points at a parameter, so deleting it
// can warn about what would break: [{ kind, name, roles }], roles being how
// it's used there (e.g. "toestel", "actie"). An auto-include rule match isn't
// listed — such a parameter simply drops out of that chart.
async function parameterUsages(woningId, parameterId) {
  const id = String(parameterId);
  const is = (ref) => ref && String(ref) === id;
  const usages = [];
  const add = (kind, name, roles) => roles.length > 0 && usages.push({ kind, name, roles: [...new Set(roles)] });

  const [charts, automations, trackers, plans] = await Promise.all([
    DashboardChart.find({ woning: woningId }).lean(),
    Automation.find({ woning: woningId }).lean(),
    CostTracker.find({ woning: woningId }).lean(),
    SmartChargePlan.find({ woning: woningId }).lean(),
  ]);

  const FLOW_ROLE_LABELS = { pv: 'PV', battery: 'batterij', grid: 'net', thuis: 'thuis' };
  for (const c of charts) {
    const roles = [];
    if ((c.parameters || []).some(is)) roles.push('reeks');
    for (const [key, label] of Object.entries(FLOW_ROLE_LABELS)) if (is(c.flowRoles?.[key])) roles.push(`stroom ${label}`);
    for (const d of c.devices || []) {
      if (is(d.parameter)) roles.push('toestel');
      if (is(d.parent)) roles.push('bovenliggend toestel');
    }
    if (is(c.gridConsumptionParameter)) roles.push('totaal netverbruik');
    if (is(c.batteryPowerParameter)) roles.push('batterijvermogen');
    if ((c.excludedParameters || []).some(is)) roles.push('uitgesloten van automatisch toevoegen');
    add('Grafiek', c.name, roles);
  }
  for (const a of automations) {
    const roles = [];
    if ((a.conditions || []).some((cond) => is(cond.parameter))) roles.push('voorwaarde');
    if (is(a.action?.parameter)) roles.push('actie');
    add('Automatisatie', a.name, roles);
  }
  for (const t of trackers) {
    const roles = [];
    if (is(t.meterParameter)) roles.push('meter');
    if (is(t.priceParameter)) roles.push('prijs');
    add('Kostenberekening', t.name, roles);
  }
  const PLAN_ROLE_LABELS = {
    socParameter: 'laadtoestand',
    solarRemainingParameter: 'resterende zonneproductie',
    consumptionParameter: 'verbruik',
    priceParameter: 'prijs',
    chargeSwitchParameter: 'laadschakelaar',
  };
  for (const plan of plans) {
    add('Slim-laadplan', plan.name, Object.entries(PLAN_ROLE_LABELS).filter(([k]) => is(plan[k])).map(([, l]) => l));
  }
  return usages;
}

router.get('/:parameterId/usages', async (req, res, next) => {
  try {
    const parameter = await Parameter.findOne({ _id: req.params.parameterId, woning: req.params.woningId });
    if (!parameter) throw new ApiError(404, 'Parameter not found');
    res.json(await parameterUsages(req.params.woningId, parameter._id));
  } catch (err) {
    next(err);
  }
});

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
