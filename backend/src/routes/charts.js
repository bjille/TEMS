const express = require('express');
const { body, validationResult } = require('express-validator');
const DashboardChart = require('../models/DashboardChart');
const Parameter = require('../models/Parameter');
const { authenticate, requireSuperadmin } = require('../middleware/authenticate');
const { authorizeWoning } = require('../middleware/authorizeWoning');
const { ApiError } = require('../middleware/errorHandler');
const { CHART_TYPES } = require('../models/DashboardChart');

const router = express.Router({ mergeParams: true });

const FLOW_ROLE_KEYS = ['pv', 'battery', 'grid'];
const POPULATE_FIELDS = 'label unit type';
const POPULATE_PATHS = [
  { path: 'parameters', select: POPULATE_FIELDS },
  { path: 'flowRoles.pv', select: POPULATE_FIELDS },
  { path: 'flowRoles.battery', select: POPULATE_FIELDS },
  { path: 'flowRoles.grid', select: POPULATE_FIELDS },
  { path: 'devices.parameter', select: POPULATE_FIELDS },
  { path: 'devices.parent', select: POPULATE_FIELDS },
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
// bar), or an `energyflow` diagram driven by up to three `flowRoles`
// (mutually exclusive with `parameters`, and at least one role required).
// `devices` (the per-appliance breakdown of "Thuis") is optional either way.
function validateShape(req) {
  const type = req.body.type || 'line';
  if (type === 'energyflow') {
    if (collectFlowRoleIds(req.body.flowRoles).length === 0) {
      throw new ApiError(400, 'Kies minstens één parameter (PV, batterij of net) voor een energieflow-diagram');
    }
  } else if (!Array.isArray(req.body.parameters) || req.body.parameters.length === 0) {
    throw new ApiError(400, 'Kies minstens één parameter');
  }
  if (req.body.devices) assertValidDeviceTree(req.body.devices);
}

// List charts for a woning, each enriched with its parameters' display info.
router.get('/', async (req, res, next) => {
  try {
    const charts = await DashboardChart.find({ woning: req.params.woningId })
      .sort({ createdAt: 1 })
      .populate(POPULATE_PATHS);
    res.json(charts);
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
    body('parameters').optional().isArray(),
    body('parameters.*').optional().isMongoId(),
    body('flowRoles').optional().isObject(),
    body('flowRoles.pv').optional().isMongoId(),
    body('flowRoles.battery').optional().isMongoId(),
    body('flowRoles.grid').optional().isMongoId(),
    body('devices').optional().isArray(),
    body('devices.*.parameter').isMongoId(),
    body('devices.*.parent').optional({ nullable: true }).isMongoId(),
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
        [...parameterIds, ...devices.map((d) => d.parameter), ...collectFlowRoleIds(req.body.flowRoles)],
        req.params.woningId
      );

      const chart = await DashboardChart.create({
        woning: req.params.woningId,
        name: req.body.name,
        type: req.body.type || 'line',
        rangeHours: req.body.rangeHours || 24,
        parameters: parameterIds,
        flowRoles: req.body.flowRoles || {},
        devices,
        circular: req.body.circular || false,
        showOnDashboard: req.body.showOnDashboard || false,
        createdBy: req.user._id,
      });

      const populated = await chart.populate(POPULATE_PATHS);
      res.status(201).json(populated);
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
    body('parameters').optional().isArray(),
    body('parameters.*').optional().isMongoId(),
    body('flowRoles').optional().isObject(),
    body('flowRoles.pv').optional().isMongoId(),
    body('flowRoles.battery').optional().isMongoId(),
    body('flowRoles.grid').optional().isMongoId(),
    body('devices').optional().isArray(),
    body('devices.*.parameter').isMongoId(),
    body('devices.*.parent').optional({ nullable: true }).isMongoId(),
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
        req.body.devices !== undefined
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
          },
        });
        const devices = req.body.devices || [];
        await assertParametersBelongToWoning(
          [
            ...(req.body.parameters || []),
            ...devices.map((d) => d.parameter),
            ...collectFlowRoleIds(req.body.flowRoles),
          ],
          req.params.woningId
        );
      }

      const chart = await DashboardChart.findOneAndUpdate(
        { _id: req.params.chartId, woning: req.params.woningId },
        req.body,
        { new: true }
      ).populate(POPULATE_PATHS);
      if (!chart) throw new ApiError(404, 'Chart not found');
      res.json(chart);
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
