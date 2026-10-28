const express = require('express');
const { body, query, validationResult } = require('express-validator');
const DashboardChart = require('../models/DashboardChart');
const Parameter = require('../models/Parameter');
const CostTracker = require('../models/CostTracker');
const SmartChargePlan = require('../models/SmartChargePlan');
const Woning = require('../models/Woning');
const { buildParameterRemap } = require('../services/parameterRemap');
const { authenticate, requireSuperadmin } = require('../middleware/authenticate');
const { authorizeWoning } = require('../middleware/authorizeWoning');
const { ApiError } = require('../middleware/errorHandler');
const { CHART_TYPES, RANGE_PERIODS } = require('../models/DashboardChart');
const { PARAMETER_TYPES } = require('../models/Parameter');
const { HaClient } = require('../services/haClient');
const { flowEnergy } = require('../services/energyTotals');
const { decrypt } = require('../utils/crypto');

const router = express.Router({ mergeParams: true });

const FLOW_ROLE_KEYS = ['pv', 'battery', 'grid', 'thuis', 'gas'];
const POPULATE_FIELDS = 'label unit type';
const POPULATE_PATHS = [
  { path: 'parameters', select: POPULATE_FIELDS },
  { path: 'flowRoles.pv', select: POPULATE_FIELDS },
  { path: 'flowRoles.battery', select: POPULATE_FIELDS },
  { path: 'flowRoles.grid', select: POPULATE_FIELDS },
  { path: 'flowRoles.thuis', select: POPULATE_FIELDS },
  { path: 'flowRoles.gas', select: POPULATE_FIELDS },
  { path: 'devices.parameter', select: POPULATE_FIELDS },
  { path: 'devices.parent', select: POPULATE_FIELDS },
  { path: 'costTrackers', select: 'name' },
  { path: 'smartChargePlans', select: 'name' },
  { path: 'gridConsumptionParameter', select: POPULATE_FIELDS },
  { path: 'batteryPowerParameter', select: POPULATE_FIELDS },
];

function checkValidation(req) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(400, 'Validation failed', errors.array());
}

router.use(authenticate, authorizeWoning());

async function assertParametersBelongToWoning(parameterIds, woningId) {
  if (parameterIds.length === 0) return;
  const count = await Parameter.countDocuments({
    _id: { $in: parameterIds },
    woning: woningId,
  });
  if (count !== new Set(parameterIds).size) {
    throw new ApiError(400, 'Eén of meer parameters horen niet bij deze woning');
  }
}

async function assertCostTrackersBelongToWoning(trackerIds, woningId) {
  if (!trackerIds || trackerIds.length === 0) return;
  const count = await CostTracker.countDocuments({ _id: { $in: trackerIds }, woning: woningId });
  if (count !== new Set(trackerIds.map(String)).size) {
    throw new ApiError(400, 'Eén of meer kostenberekeningen horen niet bij deze woning');
  }
}

async function assertSmartChargePlansBelongToWoning(planIds, woningId) {
  if (!planIds || planIds.length === 0) return;
  const count = await SmartChargePlan.countDocuments({ _id: { $in: planIds }, woning: woningId });
  if (count !== new Set(planIds.map(String)).size) {
    throw new ApiError(400, 'Eén of meer slim-laadplannen horen niet bij deze woning');
  }
}

const idOf = (ref) => String(ref?._id || ref);

/**
 * Turns chart documents into plain objects with their `autoInclude` rule
 * applied: every parameter of the woning matching its type + unit that isn't
 * excluded or already in the chart is appended — to `parameters`, or for an
 * energyflow diagram to `devices` (top level, and never a sensor already
 * used as one of its flow roles). Appended entries carry `auto: true`, so the
 * admin form can tell them apart from the explicitly chosen ones (which are
 * the only ones stored).
 */
async function expandAutoInclude(charts, woningId) {
  const plain = charts.map((c) => (c.toObject ? c.toObject({ flattenMaps: true }) : c));
  if (!plain.some((c) => c.autoInclude?.type)) return plain;
  const all = await Parameter.find({ woning: woningId }).select(POPULATE_FIELDS).sort({ label: 1 }).lean();

  return plain.map((chart) => {
    const rule = chart.autoInclude;
    if (!rule?.type) return chart;
    const excluded = new Set((chart.excludedParameters || []).map(idOf));
    const matches = all.filter(
      (p) =>
        p.type === rule.type &&
        (p.unit || '').trim().toLowerCase() === (rule.unit || '').trim().toLowerCase() &&
        !excluded.has(String(p._id))
    );
    if (chart.type === 'energyflow') {
      const taken = new Set([
        ...(chart.devices || []).map((d) => idOf(d.parameter)),
        ...FLOW_ROLE_KEYS.map((k) => chart.flowRoles?.[k]).filter(Boolean).map(idOf),
      ]);
      const extra = matches
        .filter((p) => !taken.has(String(p._id)))
        .map((p) => ({ parameter: p, parent: null, auto: true }));
      return { ...chart, devices: [...(chart.devices || []), ...extra] };
    }
    const taken = new Set((chart.parameters || []).map(idOf));
    const extra = matches.filter((p) => !taken.has(String(p._id))).map((p) => ({ ...p, auto: true }));
    return { ...chart, parameters: [...(chart.parameters || []), ...extra] };
  });
}

async function expandOne(chart, woningId) {
  return (await expandAutoInclude([chart], woningId))[0];
}

function collectFlowRoleIds(flowRoles) {
  if (!flowRoles) return [];
  return FLOW_ROLE_KEYS.map((k) => flowRoles[k]).filter(Boolean);
}

// Every device's `parent` (when set) must itself be another device's
// `parameter` in the same list — i.e. you can only nest a device under one
// of the other devices you're configuring, never under an arbitrary
// parameter — and the resulting parent chain must be acyclic.
function assertValidDeviceTree(devices) {
  const ownParameterIds = new Set(devices.map((d) => String(d.parameter)));
  const parentById = new Map(devices.map((d) => [String(d.parameter), d.parent ? String(d.parent) : null]));

  for (const d of devices) {
    if (d.parent && !ownParameterIds.has(String(d.parent))) {
      throw new ApiError(400, 'De parent van een toestel moet zelf ook een geselecteerd toestel zijn');
    }
  }

  for (const startId of ownParameterIds) {
    const seen = new Set();
    let current = startId;
    while (current !== null && current !== undefined) {
      if (seen.has(current)) throw new ApiError(400, 'Toestellen mogen geen cirkelvormige hiërarchie vormen');
      seen.add(current);
      current = parentById.get(current) ?? null;
    }
  }
}

// A chart is either a time series over one or more `parameters` (line/area/
// bar), a `price_forecast` chart driven by exactly one `parameters` entry
// (the dynamic-prices entity whose HA attributes carry the hourly curve),
// an `energyflow` diagram driven by up to three `flowRoles` (mutually
// exclusive with `parameters`, and at least one role required), or a `cost`
// chart over `costTrackers` (none selected meaning all of them). `devices`
// (the per-appliance breakdown of "Thuis") is optional either way.
function validateShape(req) {
  const type = req.body.type || 'line';
  if (type === 'energyflow') {
    if (collectFlowRoleIds(req.body.flowRoles).length === 0) {
      throw new ApiError(400, 'Kies minstens één parameter (PV, batterij of net) voor een energieflow-diagram');
    }
  } else if (type === 'cost' || type === 'smart_charge_savings') {
    // No parameters needed: the cost calculations / smart-charge plans carry
    // their own sensors — gridConsumptionParameter (smart_charge_savings
    // only) is optional, not required for the chart to be meaningful.
  } else if (type === 'price_forecast') {
    if (!Array.isArray(req.body.parameters) || req.body.parameters.length !== 1) {
      throw new ApiError(400, 'Kies precies 1 parameter (de dynamische-prijzensensor) voor een prijzengrafiek');
    }
  } else if (
    (!Array.isArray(req.body.parameters) || req.body.parameters.length === 0) &&
    !req.body.autoInclude?.type
  ) {
    throw new ApiError(400, 'Kies minstens één parameter, of laat parameters automatisch toevoegen');
  }
  if (req.body.devices) assertValidDeviceTree(req.body.devices);
}

// List charts for a woning, each enriched with its parameters' display info.
router.get('/', async (req, res, next) => {
  try {
    const charts = await DashboardChart.find({ woning: req.params.woningId })
      .sort({ createdAt: 1 })
      .populate(POPULATE_PATHS);
    res.json(await expandAutoInclude(charts, req.params.woningId));
  } catch (err) {
    next(err);
  }
});

// The energy (kWh) behind an energy flow chart over a period — what its
// diagram shows for a day, week, ... instead of the live power (see
// services/energyTotals.js flowEnergy).
router.get('/:chartId/energy', [query('from').isISO8601(), query('to').isISO8601()], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw new ApiError(400, 'Validation failed', errors.array());
    const [chart] = await expandAutoInclude(
      await DashboardChart.find({ _id: req.params.chartId, woning: req.params.woningId, type: 'energyflow' }),
      req.params.woningId
    );
    if (!chart) throw new ApiError(404, 'Grafiek niet gevonden');
    const woning = await Woning.findById(req.params.woningId).select('+haTokenEncrypted');
    if (!woning) throw new ApiError(404, 'Woning not found');

    const parameters = await Parameter.find({ woning: woning._id }).lean();
    const client = new HaClient({ baseUrl: woning.haBaseUrl, token: decrypt(woning.haTokenEncrypted) });
    const start = new Date(req.query.from);
    const end = new Date(Math.min(new Date(req.query.to).getTime(), Date.now()));
    res.json(await flowEnergy(client, chart, new Map(parameters.map((p) => [String(p._id), p])), start, end));
  } catch (err) {
    next(err);
  }
});

router.post(
  '/',
  requireSuperadmin,
  [
    body('name').isString().notEmpty(),
    body('type').optional().isIn(CHART_TYPES),
    body('rangeHours').optional().isInt({ min: 1 }),
    body('rangePeriod').optional().isIn(RANGE_PERIODS),
    body('parameters').optional().isArray(),
    body('parameters.*').optional().isMongoId(),
    body('flowRoles').optional().isObject(),
    body('flowRoles.pv').optional().isMongoId(),
    body('flowRoles.battery').optional().isMongoId(),
    body('flowRoles.grid').optional().isMongoId(),
    body('flowRoles.thuis').optional().isMongoId(),
    body('flowRoles.gas').optional().isMongoId(),
    body('devices').optional().isArray(),
    body('devices.*.parameter').isMongoId(),
    body('devices.*.parent').optional({ nullable: true }).isMongoId(),
    body('autoInclude').optional().isObject(),
    body('autoInclude.type').optional({ nullable: true, checkFalsy: true }).isIn(PARAMETER_TYPES),
    body('autoInclude.unit').optional({ nullable: true }).isString(),
    body('excludedParameters').optional().isArray(),
    body('excludedParameters.*').optional().isMongoId(),
    body('costTrackers').optional().isArray(),
    body('costTrackers.*').optional().isMongoId(),
    body('smartChargePlans').optional().isArray(),
    body('smartChargePlans.*').optional().isMongoId(),
    body('gridConsumptionParameter').optional({ nullable: true, checkFalsy: true }).isMongoId(),
    body('batteryPowerParameter').optional({ nullable: true, checkFalsy: true }).isMongoId(),
    body('circular').optional().isBoolean(),
    body('showOnDashboard').optional().isBoolean(),
  ],
  async (req, res, next) => {
    try {
      checkValidation(req);
      validateShape(req);
      const parameterIds = req.body.parameters || [];
      const devices = req.body.devices || [];
      await assertParametersBelongToWoning(
        [
          ...parameterIds,
          ...devices.map((d) => d.parameter),
          ...collectFlowRoleIds(req.body.flowRoles),
          ...(req.body.excludedParameters || []),
          ...(req.body.gridConsumptionParameter ? [req.body.gridConsumptionParameter] : []),
          ...(req.body.batteryPowerParameter ? [req.body.batteryPowerParameter] : []),
        ],
        req.params.woningId
      );
      await assertCostTrackersBelongToWoning(req.body.costTrackers, req.params.woningId);
      await assertSmartChargePlansBelongToWoning(req.body.smartChargePlans, req.params.woningId);

      const chart = await DashboardChart.create({
        woning: req.params.woningId,
        name: req.body.name,
        type: req.body.type || 'line',
        rangeHours: req.body.rangeHours || 24,
        rangePeriod: req.body.rangePeriod || 'rolling',
        parameters: parameterIds,
        flowRoles: req.body.flowRoles || {},
        devices,
        costTrackers: req.body.costTrackers || [],
        smartChargePlans: req.body.smartChargePlans || [],
        gridConsumptionParameter: req.body.gridConsumptionParameter || undefined,
        batteryPowerParameter: req.body.batteryPowerParameter || undefined,
        autoInclude: req.body.autoInclude || { type: null, unit: '' },
        excludedParameters: req.body.excludedParameters || [],
        circular: req.body.circular || false,
        showOnDashboard: req.body.showOnDashboard || false,
        createdBy: req.user._id,
      });

      const populated = await chart.populate(POPULATE_PATHS);
      res.status(201).json(await expandOne(populated, req.params.woningId));
    } catch (err) {
      next(err);
    }
  }
);

router.patch(
  '/:chartId',
  requireSuperadmin,
  [
    body('name').optional().isString().notEmpty(),
    body('type').optional().isIn(CHART_TYPES),
    body('rangeHours').optional().isInt({ min: 1 }),
    body('rangePeriod').optional().isIn(RANGE_PERIODS),
    body('parameters').optional().isArray(),
    body('parameters.*').optional().isMongoId(),
    body('flowRoles').optional().isObject(),
    body('flowRoles.pv').optional().isMongoId(),
    body('flowRoles.battery').optional().isMongoId(),
    body('flowRoles.grid').optional().isMongoId(),
    body('flowRoles.thuis').optional().isMongoId(),
    body('flowRoles.gas').optional().isMongoId(),
    body('devices').optional().isArray(),
    body('devices.*.parameter').isMongoId(),
    body('devices.*.parent').optional({ nullable: true }).isMongoId(),
    body('autoInclude').optional().isObject(),
    body('autoInclude.type').optional({ nullable: true, checkFalsy: true }).isIn(PARAMETER_TYPES),
    body('autoInclude.unit').optional({ nullable: true }).isString(),
    body('excludedParameters').optional().isArray(),
    body('excludedParameters.*').optional().isMongoId(),
    body('costTrackers').optional().isArray(),
    body('costTrackers.*').optional().isMongoId(),
    body('smartChargePlans').optional().isArray(),
    body('smartChargePlans.*').optional().isMongoId(),
    body('gridConsumptionParameter').optional({ nullable: true, checkFalsy: true }).isMongoId(),
    body('batteryPowerParameter').optional({ nullable: true, checkFalsy: true }).isMongoId(),
    body('circular').optional().isBoolean(),
    body('showOnDashboard').optional().isBoolean(),
  ],
  async (req, res, next) => {
    try {
      checkValidation(req);
      // Only re-validate the parameters/flowRoles/devices shape when one of
      // them is part of this update — a PATCH that only flips
      // showOnDashboard shouldn't need to resend the whole chart definition.
      if (
        req.body.parameters !== undefined ||
        req.body.flowRoles !== undefined ||
        req.body.devices !== undefined ||
        req.body.autoInclude !== undefined
      ) {
        const existing = await DashboardChart.findOne({
          _id: req.params.chartId,
          woning: req.params.woningId,
        });
        if (!existing) throw new ApiError(404, 'Chart not found');
        validateShape({
          body: {
            type: req.body.type || existing.type,
            parameters: req.body.parameters ?? existing.parameters,
            flowRoles: req.body.flowRoles ?? existing.flowRoles,
            devices: req.body.devices ?? existing.devices,
            autoInclude: req.body.autoInclude ?? existing.autoInclude,
          },
        });
        const devices = req.body.devices || [];
        await assertParametersBelongToWoning(
          [
            ...(req.body.parameters || []),
            ...devices.map((d) => d.parameter),
            ...collectFlowRoleIds(req.body.flowRoles),
            ...(req.body.excludedParameters || []),
            ...(req.body.gridConsumptionParameter ? [req.body.gridConsumptionParameter] : []),
            ...(req.body.batteryPowerParameter ? [req.body.batteryPowerParameter] : []),
          ],
          req.params.woningId
        );
      } else if (req.body.gridConsumptionParameter || req.body.batteryPowerParameter) {
        await assertParametersBelongToWoning(
          [req.body.gridConsumptionParameter, req.body.batteryPowerParameter].filter(Boolean),
          req.params.woningId
        );
      }

      await assertCostTrackersBelongToWoning(req.body.costTrackers, req.params.woningId);
      await assertSmartChargePlansBelongToWoning(req.body.smartChargePlans, req.params.woningId);

      const updates = { ...req.body };
      // An empty selection clears the (optional) grid-consumption parameter
      // rather than being cast to an ObjectId, which would throw.
      for (const key of ['gridConsumptionParameter', 'batteryPowerParameter']) {
        if (key in updates && !updates[key]) updates[key] = null;
      }

      const chart = await DashboardChart.findOneAndUpdate(
        { _id: req.params.chartId, woning: req.params.woningId },
        updates,
        { new: true }
      ).populate(POPULATE_PATHS);
      if (!chart) throw new ApiError(404, 'Chart not found');
      res.json(await expandOne(chart, req.params.woningId));
    } catch (err) {
      next(err);
    }
  }
);

// Copies this chart into one or more other woningen. Every parameter it
// references (series, flow roles, device breakdown) is remapped to the
// equivalent parameter in the target woning by identity (entityId +
// invert) — if any referenced parameter has no match there, that target is
// skipped with an error instead of silently dropping a series. The copy
// always starts off the target's dashboard (showOnDashboard: false) so it
// can be reviewed before it appears there.
router.post(
  '/:chartId/copy',
  requireSuperadmin,
  [body('targetWoningIds').isArray({ min: 1 }), body('targetWoningIds.*').isMongoId()],
  async (req, res, next) => {
    try {
      checkValidation(req);
      const chart = await DashboardChart.findOne({
        _id: req.params.chartId,
        woning: req.params.woningId,
      });
      if (!chart) throw new ApiError(404, 'Chart not found');

      const targetIds = [...new Set(req.body.targetWoningIds)].filter(
        (id) => id !== req.params.woningId
      );
      const existingWoningen = await Woning.find({ _id: { $in: targetIds } }, '_id');
      const existingIds = new Set(existingWoningen.map((w) => w._id.toString()));

      const sourceParamIds = [
        ...chart.parameters,
        ...collectFlowRoleIds(chart.flowRoles),
        ...chart.devices.map((d) => d.parameter),
      ];

      const results = [];
      for (const targetWoningId of targetIds) {
        if (!existingIds.has(targetWoningId)) {
          results.push({ woningId: targetWoningId, status: 'error', message: 'Woning niet gevonden' });
          continue;
        }
        const { map, missing } = await buildParameterRemap(sourceParamIds, targetWoningId);
        const { map: excludedMap } = await buildParameterRemap(chart.excludedParameters || [], targetWoningId);
        const { map: gridMap } = await buildParameterRemap(
          [chart.gridConsumptionParameter, chart.batteryPowerParameter].filter(Boolean),
          targetWoningId
        );
        if (missing.length > 0) {
          results.push({
            woningId: targetWoningId,
            status: 'error',
            message: `Ontbrekende parameter(s) in doelwoning: ${missing.join(', ')}`,
          });
          continue;
        }
        const copy = await DashboardChart.create({
          woning: targetWoningId,
          name: chart.name,
          type: chart.type,
          rangeHours: chart.rangeHours,
          rangePeriod: chart.rangePeriod,
          parameters: chart.parameters.map((id) => map.get(id.toString())),
          flowRoles: {
            pv: chart.flowRoles?.pv ? map.get(chart.flowRoles.pv.toString()) : undefined,
            battery: chart.flowRoles?.battery ? map.get(chart.flowRoles.battery.toString()) : undefined,
            grid: chart.flowRoles?.grid ? map.get(chart.flowRoles.grid.toString()) : undefined,
            gas: chart.flowRoles?.gas ? map.get(chart.flowRoles.gas.toString()) : undefined,
          },
          devices: chart.devices.map((d) => ({
            parameter: map.get(d.parameter.toString()),
            parent: d.parent ? map.get(d.parent.toString()) : null,
          })),
          // Cost calculations and smart-charge plans are per woning, so the
          // copy shows all of the target's own instead of pointing at the
          // source's.
          costTrackers: [],
          smartChargePlans: [],
          gridConsumptionParameter: chart.gridConsumptionParameter
            ? gridMap.get(chart.gridConsumptionParameter.toString())
            : undefined,
          batteryPowerParameter: chart.batteryPowerParameter
            ? gridMap.get(chart.batteryPowerParameter.toString())
            : undefined,
          autoInclude: chart.autoInclude,
          // Exclusions are only a refinement of the auto-include rule, so
          // one that has no counterpart in the target is simply dropped
          // rather than blocking the copy.
          excludedParameters: (chart.excludedParameters || [])
            .map((id) => excludedMap.get(id.toString()))
            .filter(Boolean),
          circular: chart.circular,
          showOnDashboard: false,
          createdBy: req.user._id,
        });
        results.push({ woningId: targetWoningId, status: 'created', chartId: copy._id });
      }

      res.json({ results });
    } catch (err) {
      next(err);
    }
  }
);

router.delete('/:chartId', requireSuperadmin, async (req, res, next) => {
  try {
    const chart = await DashboardChart.findOneAndDelete({
      _id: req.params.chartId,
      woning: req.params.woningId,
    });
    if (!chart) throw new ApiError(404, 'Chart not found');
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.POPULATE_PATHS = POPULATE_PATHS;
module.exports.expandAutoInclude = expandAutoInclude;
