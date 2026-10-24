const express = require('express');
const { body, validationResult } = require('express-validator');
const Parameter = require('../models/Parameter');
const Reading = require('../models/Reading');
const PriceHistory = require('../models/PriceHistory');
const Woning = require('../models/Woning');
const { authenticate, requireSuperadmin } = require('../middleware/authenticate');
const { authorizeWoning } = require('../middleware/authorizeWoning');
const { ApiError } = require('../middleware/errorHandler');
const { PARAMETER_TYPES } = require('../models/Parameter');
const { haConnectionManager } = require('../services/haConnectionManager');
const { HaClient } = require('../services/haClient');
const { decrypt } = require('../utils/crypto');
const { fetchPriceForecast } = require('../services/priceForecastService');
const { loadPriceHistory, storePricePoints } = require('../services/priceHistoryService');
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

async function pruneToLatestReading(parameterId) {
  const latest = await Reading.findOne({ parameter: parameterId }).sort({ timestamp: -1 }).select('_id').lean();
  if (latest) await Reading.deleteMany({ parameter: parameterId, _id: { $ne: latest._id } });
}

// Counters for energy flowing the other way (a plug's "returned" energy, a
// meter's production) — never a consumer's long-term sensor.
const NOT_CONSUMED = /export|geexporteerd|returned|teruggeleverd|produced|production|productie/i;
const POWER_UNITS = ['w', 'kw'];

// For every power parameter without a long-term energy sensor yet, the
// cumulative kWh sensors on the same HA device — the pairing HA's own
// energy dashboard makes between a device's "power" and "energy" sensors.
// Best candidate first: one that never resets ("total" rather than "today").
router.get('/energy-suggestions', requireSuperadmin, async (req, res, next) => {
  try {
    const woning = await Woning.findById(req.params.woningId).select('+haTokenEncrypted');
    if (!woning) throw new ApiError(404, 'Woning not found');
    const client = new HaClient({ baseUrl: woning.haBaseUrl, token: decrypt(woning.haTokenEncrypted) });
    const [registry, states, parameters] = await Promise.all([
      client.fetchEntityRegistry(),
      client.fetchAllStates(),
      Parameter.find({ woning: req.params.woningId }).lean(),
    ]);

    const deviceOf = new Map(registry.map((e) => [e.entity_id, e.device_id]));
    const energyByDevice = new Map();
    for (const s of states) {
      const unit = String(s.attributes?.unit_of_measurement || '').toLowerCase();
      const stateClass = s.attributes?.state_class;
      if (!['wh', 'kwh'].includes(unit) || !['total', 'total_increasing'].includes(stateClass)) continue;
      const name = s.attributes?.friendly_name || s.entity_id;
      if (NOT_CONSUMED.test(s.entity_id) || NOT_CONSUMED.test(name)) continue;
      const device = deviceOf.get(s.entity_id);
      if (!device) continue;
      if (!energyByDevice.has(device)) energyByDevice.set(device, []);
      energyByDevice.get(device).push({ entityId: s.entity_id, name });
    }
    const resets = (c) => /today|vandaag|dag|daily|_day/i.test(c.entityId + ' ' + c.name);

    const suggestions = [];
    for (const p of parameters) {
      if (p.energyEntityId || !POWER_UNITS.includes(String(p.unit || '').trim().toLowerCase())) continue;
      const candidates = (energyByDevice.get(deviceOf.get(p.entityId)) || [])
        .slice()
        .sort((a, b) => resets(a) - resets(b));
      if (candidates.length > 0) {
        suggestions.push({ parameterId: p._id, label: p.label, entityId: p.entityId, candidates });
      }
    }
    res.json(suggestions);
  } catch (err) {
    if (err.isAxiosError) return next(new ApiError(502, 'Entiteiten ophalen bij Home Assistant mislukt'));
    next(err);
  }
});

// Live hourly price forecast for a parameter backed by a dynamic-prices HA
// entity (e.g. the entso-e integration's "average electricity price"
// sensor). Fetched fresh from HA on every request rather than served from
// stored Readings: the whole point is the sensor's forward-looking forecast
// for hours that haven't happened yet, which by definition has no reading
// history yet. With `from`/`to` (ISO), the hourly curve over that window
// instead: past hours from the stored PriceHistory (see
// priceHistoryService.js), merged with the live curve where it overlaps.
router.get('/:parameterId/price-forecast', async (req, res, next) => {
  try {
    const parameter = await Parameter.findOne({
      _id: req.params.parameterId,
      woning: req.params.woningId,
    });
    if (!parameter) throw new ApiError(404, 'Parameter not found for this woning');

    const woning = await Woning.findById(req.params.woningId).select('+haTokenEncrypted');
    if (!woning) throw new ApiError(404, 'Woning not found');

    const from = req.query.from ? new Date(req.query.from) : null;
    const to = req.query.to ? new Date(req.query.to) : null;
    if (!from || !to) {
      const forecast = await fetchPriceForecast(parameter, woning);
      res.json(forecast);
      return;
    }
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
      throw new ApiError(400, 'Ongeldige periode');
    }

    const stored = await loadPriceHistory(parameter._id, from, to);
    const byTimestamp = new Map(stored.map((p) => [p.timestamp, p.price]));
    let unit = stored.find((p) => p.unit)?.unit || parameter.unit || '';
    // The live curve covers today and tomorrow; only worth fetching when the
    // window reaches past yesterday.
    if (to.getTime() > Date.now() - 24 * 3600 * 1000) {
      try {
        const forecast = await fetchPriceForecast(parameter, woning);
        unit = forecast.unit || unit;
        storePricePoints(parameter, forecast.points, forecast.unit).catch(() => {});
        for (const p of forecast.points) {
          const t = new Date(p.timestamp);
          if (t >= from && t < to) byTimestamp.set(p.timestamp, p.price);
        }
      } catch (err) {
        // Stored history is still worth showing without the live part.
        if (stored.length === 0) throw err;
      }
    }
    const points = [...byTimestamp.entries()]
      .sort((a, b) => new Date(a[0]) - new Date(b[0]))
      .map(([timestamp, price]) => ({ timestamp, price }));
    res.json({ unit, points });
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
    body('energyEntityId').optional().isString(),
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
        energyEntityId: req.body.energyEntityId || '',
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
    body('energyEntityId').optional().isString(),
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
      // With a long-term energy sensor the live sensor's stored history is
      // no longer used (see ingestService): keep only its latest Reading.
      if (parameter.energyEntityId) await pruneToLatestReading(parameter._id);
      // The live ingest holds its own copy of each parameter.
      await haConnectionManager.resubscribe(req.params.woningId);
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
            energyEntityId: parameter.energyEntityId,
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
    // Its history has nothing left to be shown under.
    await Reading.deleteMany({ parameter: parameter._id });
    await PriceHistory.deleteMany({ parameter: parameter._id });
    await haConnectionManager.resubscribe(req.params.woningId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
