const express = require('express');
const cron = require('node-cron');
const { body, validationResult } = require('express-validator');
const Automation = require('../models/Automation');
const Parameter = require('../models/Parameter');
const { authenticate } = require('../middleware/authenticate');
const { authorizeWoning } = require('../middleware/authorizeWoning');
const { ApiError } = require('../middleware/errorHandler');
const { OPERATORS } = require('../models/Automation');
const { automationEngine } = require('../services/automationEngine');

const router = express.Router({ mergeParams: true });

function checkValidation(req) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(400, 'Validation failed', errors.array());
}

const automationValidators = [
  body('name').isString().notEmpty(),
  body('enabled').optional().isBoolean(),
  body('trigger.type').isIn(['state', 'schedule']),
  body('trigger.cronExpression').optional().isString(),
  body('conditions').isArray({ min: 1 }),
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

module.exports = router;
