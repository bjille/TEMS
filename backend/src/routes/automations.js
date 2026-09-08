const express = require('express');
const cron = require('node-cron');
const { body, validationResult } = require('express-validator');
const Automation = require('../models/Automation');
const Parameter = require('../models/Parameter');
const Woning = require('../models/Woning');
const WoningUser = require('../models/WoningUser');
const { authenticate } = require('../middleware/authenticate');
const { authorizeWoning } = require('../middleware/authorizeWoning');
const { ApiError } = require('../middleware/errorHandler');
const { OPERATORS } = require('../models/Automation');
const { automationEngine } = require('../services/automationEngine');
const { buildParameterRemap } = require('../services/parameterRemap');

const router = express.Router({ mergeParams: true });

function checkValidation(req) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(400, 'Validation failed', errors.array());
}

const CLOCK_TIME_RE = /^([01]?\d|2[0-3]):([0-5]?\d)$/;

const automationValidators = [
  body('name').isString().notEmpty(),
  body('enabled').optional().isBoolean(),
  body('trigger.type').isIn(['state', 'schedule', 'timer']),
  body('trigger.cronExpression').optional().isString(),
  body('trigger.timerMode').optional().isIn(['countdown', 'clock']),
  body('trigger.timerClockTime').optional().matches(CLOCK_TIME_RE),
  body('trigger.timerDurationMinutes').optional().isInt({ min: 1 }),
  body('conditions').isArray(),
  body('conditions.*.parameter').isMongoId(),
  body('conditions.*.operator').isIn(OPERATORS),
  body('conditions.*.value').exists(),
  body('action.parameter').isMongoId(),
  body('action.action').isString().notEmpty(),
  body('action.payload').optional().isObject(),
  body('cooldownMinutes').optional().isInt({ min: 0 }),
];

function assertBusinessRules(payload) {
  if (payload.trigger?.type === 'schedule') {
    if (!payload.trigger.cronExpression || !cron.validate(payload.trigger.cronExpression)) {
      throw new ApiError(400, 'Invalid or missing cron expression for a schedule trigger');
    }
  } else if (payload.trigger?.type === 'timer') {
    if (!['countdown', 'clock'].includes(payload.trigger.timerMode)) {
      throw new ApiError(400, 'A timer trigger requires timerMode "countdown" or "clock"');
    }
    if (payload.trigger.timerMode === 'clock' && !payload.trigger.timerClockTime) {
      throw new ApiError(400, 'A clock timer requires a timerClockTime ("HH:MM")');
    }
  } else if (payload.trigger?.type === 'state' || !payload.trigger) {
    if (!Array.isArray(payload.conditions) || payload.conditions.length === 0) {
      throw new ApiError(400, 'At least one condition is required for a state trigger');
    }
  }
}

router.use(authenticate, authorizeWoning());

router.get('/', async (req, res, next) => {
  try {
    const automations = await Automation.find({ woning: req.params.woningId })
      .populate('conditions.parameter', 'label entityId unit')
      .populate('action.parameter', 'label entityId')
      .sort({ createdAt: 1 });
    res.json(automations);
  } catch (err) {
    next(err);
  }
});

router.post('/', authorizeWoning(['owner']), automationValidators, async (req, res, next) => {
  try {
    checkValidation(req);
    assertBusinessRules(req.body);

    const conditionParamIds = req.body.conditions.map((c) => c.parameter);
    const allParamIds = [...conditionParamIds, req.body.action.parameter];
    const found = await Parameter.countDocuments({
      _id: { $in: allParamIds },
      woning: req.params.woningId,
    });
    if (found !== new Set(allParamIds).size) {
      throw new ApiError(400, 'One or more parameters do not belong to this woning');
    }

    const automation = await Automation.create({
      woning: req.params.woningId,
      name: req.body.name,
      enabled: req.body.enabled ?? true,
      trigger: req.body.trigger,
      conditions: req.body.conditions,
      action: req.body.action,
      cooldownMinutes: req.body.cooldownMinutes,
      createdBy: req.user._id,
    });
    await automation.populate('conditions.parameter', 'label entityId unit');
    await automation.populate('action.parameter', 'label entityId');

    await automationEngine.refreshWoning(req.params.woningId);
    res.status(201).json(automation);
  } catch (err) {
    next(err);
  }
});

router.patch(
  '/:automationId',
  authorizeWoning(['owner']),
  automationValidators.map((v) => v.optional()),
  async (req, res, next) => {
    try {
      checkValidation(req);
      if (req.body.trigger) assertBusinessRules(req.body);

      const automation = await Automation.findOneAndUpdate(
        { _id: req.params.automationId, woning: req.params.woningId },
        req.body,
        { new: true, runValidators: true }
      );
      if (!automation) throw new ApiError(404, 'Automation not found');
      await automation.populate('conditions.parameter', 'label entityId unit');
      await automation.populate('action.parameter', 'label entityId');

      await automationEngine.refreshWoning(req.params.woningId);
      res.json(automation);
    } catch (err) {
      next(err);
    }
  }
);

router.delete('/:automationId', authorizeWoning(['owner']), async (req, res, next) => {
  try {
    const automation = await Automation.findOneAndDelete({
      _id: req.params.automationId,
      woning: req.params.woningId,
    });
    if (!automation) throw new ApiError(404, 'Automation not found');

    await automationEngine.refreshWoning(req.params.woningId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// Copies this automation into one or more other woningen. Its condition and
// action parameters are remapped to the equivalent parameter in the target
// woning by identity (entityId + invert) — a target missing any of them is
// skipped with an error rather than silently pointing at nothing. Requires
// 'owner' (or superadmin) on *both* the source and each target woning, since
// unlike parameters/charts this isn't a superadmin-only admin resource.
router.post(
  '/:automationId/copy',
  authorizeWoning(['owner']),
  [body('targetWoningIds').isArray({ min: 1 }), body('targetWoningIds.*').isMongoId()],
  async (req, res, next) => {
    try {
      checkValidation(req);
      const automation = await Automation.findOne({
        _id: req.params.automationId,
        woning: req.params.woningId,
      });
      if (!automation) throw new ApiError(404, 'Automation not found');

      const targetIds = [...new Set(req.body.targetWoningIds)].filter(
        (id) => id !== req.params.woningId
      );
      const existingWoningen = await Woning.find({ _id: { $in: targetIds } }, '_id');
      const existingIds = new Set(existingWoningen.map((w) => w._id.toString()));

      const sourceParamIds = [
        ...automation.conditions.map((c) => c.parameter),
        automation.action.parameter,
      ];

      const results = [];
      for (const targetWoningId of targetIds) {
        if (!existingIds.has(targetWoningId)) {
          results.push({ woningId: targetWoningId, status: 'error', message: 'Woning niet gevonden' });
          continue;
        }
        if (req.user.role !== 'superadmin') {
          const link = await WoningUser.findOne({ user: req.user._id, woning: targetWoningId });
          if (!link || link.role !== 'owner') {
            results.push({ woningId: targetWoningId, status: 'error', message: 'Geen rechten op deze woning' });
            continue;
          }
        }
        const { map, missing } = await buildParameterRemap(sourceParamIds, targetWoningId);
        if (missing.length > 0) {
          results.push({
            woningId: targetWoningId,
            status: 'error',
            message: `Ontbrekende parameter(s) in doelwoning: ${missing.join(', ')}`,
          });
          continue;
        }
        const copy = await Automation.create({
          woning: targetWoningId,
          name: automation.name,
          enabled: automation.enabled,
          trigger: {
            type: automation.trigger.type,
            cronExpression: automation.trigger.cronExpression,
            timerMode: automation.trigger.timerMode,
            timerClockTime: automation.trigger.timerClockTime,
            timerDurationMinutes: automation.trigger.timerDurationMinutes,
            // Never copy an in-progress countdown into another woning.
            timerArmed: false,
            timerTargetAt: undefined,
          },
          conditions: automation.conditions.map((c) => ({
            parameter: map.get(c.parameter.toString()),
            operator: c.operator,
            value: c.value,
          })),
          action: {
            parameter: map.get(automation.action.parameter.toString()),
            action: automation.action.action,
            payload: automation.action.payload,
          },
          cooldownMinutes: automation.cooldownMinutes,
          createdBy: req.user._id,
        });
        await automationEngine.refreshWoning(targetWoningId);
        results.push({ woningId: targetWoningId, status: 'created', automationId: copy._id });
      }

      res.json({ results });
    } catch (err) {
      next(err);
    }
  }
);

// --- Dashboard timer controls ---------------------------------------------
// These are deliberately available to any woning member (not just 'owner',
// like the routes above): the automation's *definition* (which device, which
// mode) is set once by an owner in the automation editor, but the actual
// clock time / countdown duration is meant to be adjusted live from the
// dashboard by anyone who can already control the device, mirroring the
// permission level of /woningen/:woningId/control/:parameterId.

async function loadTimerAutomation(req, expectedMode) {
  const automation = await Automation.findOne({
    _id: req.params.automationId,
    woning: req.params.woningId,
  });
  if (!automation) throw new ApiError(404, 'Automation not found');
  if (automation.trigger.type !== 'timer' || automation.trigger.timerMode !== expectedMode) {
    throw new ApiError(400, `Automation is not a "${expectedMode}" timer`);
  }
  return automation;
}

// Keeps the response shape consistent with GET / (which populates these),
// so the frontend store doesn't lose the device label after a dashboard
// timer action.
async function respondWithPopulated(res, automation) {
  await automation.populate('conditions.parameter', 'label entityId unit');
  await automation.populate('action.parameter', 'label entityId');
  res.json(automation);
}

router.post(
  '/:automationId/timer/arm',
  body('durationMinutes').isInt({ min: 1, max: 1440 }),
  async (req, res, next) => {
    try {
      checkValidation(req);
      const automation = await loadTimerAutomation(req, 'countdown');

      const durationMinutes = Number(req.body.durationMinutes);
      automation.trigger.timerDurationMinutes = durationMinutes;
      automation.trigger.timerTargetAt = new Date(Date.now() + durationMinutes * 60 * 1000);
      automation.trigger.timerArmed = true;
      await automation.save();

      await automationEngine.refreshWoning(req.params.woningId);
      await respondWithPopulated(res, automation);
    } catch (err) {
      next(err);
    }
  }
);

router.post('/:automationId/timer/disarm', async (req, res, next) => {
  try {
    const automation = await loadTimerAutomation(req, 'countdown');

    automation.trigger.timerArmed = false;
    automation.trigger.timerTargetAt = undefined;
    await automation.save();

    await automationEngine.refreshWoning(req.params.woningId);
    await respondWithPopulated(res, automation);
  } catch (err) {
    next(err);
  }
});

router.patch(
  '/:automationId/timer/clock',
  body('timerClockTime').matches(CLOCK_TIME_RE),
  async (req, res, next) => {
    try {
      checkValidation(req);
      const automation = await loadTimerAutomation(req, 'clock');

      automation.trigger.timerClockTime = req.body.timerClockTime;
      await automation.save();

      await automationEngine.refreshWoning(req.params.woningId);
      await respondWithPopulated(res, automation);
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
