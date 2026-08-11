const express = require('express');
const cron = require('node-cron');
const { body, validationResult } = require('express-validator');
const GlobalAutomation = require('../models/GlobalAutomation');
const { PARAMETER_TYPES } = require('../models/Parameter');
const { OPERATORS } = require('../models/Automation');
const { RECIPIENT_MODES } = require('../models/GlobalAutomation');
const { authenticate, requireSuperadmin } = require('../middleware/authenticate');
const { ApiError } = require('../middleware/errorHandler');
const { globalAutomationEngine } = require('../services/globalAutomationEngine');

const router = express.Router();

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
  body('conditions.*.parameterType').isIn(PARAMETER_TYPES),
  body('conditions.*.operator').isIn(OPERATORS),
  body('conditions.*.value').exists(),
  body('action.subject').optional().isString(),
  body('action.message').optional().isString(),
  body('action.recipients').optional().isIn(RECIPIENT_MODES),
  body('action.customEmails').optional().isArray(),
  body('action.customEmails.*').optional().isEmail(),
  body('cooldownMinutes').optional().isInt({ min: 0 }),
];

function assertBusinessRules(payload) {
  if (payload.trigger?.type === 'schedule') {
    if (!payload.trigger.cronExpression || !cron.validate(payload.trigger.cronExpression)) {
      throw new ApiError(400, 'Invalid or missing cron expression for a schedule trigger');
    }
  }
}

router.use(authenticate, requireSuperadmin);

router.get('/', async (req, res, next) => {
  try {
    const automations = await GlobalAutomation.find().sort({ createdAt: 1 });
    res.json(automations);
  } catch (err) {
    next(err);
  }
});

router.post('/', automationValidators, async (req, res, next) => {
  try {
    checkValidation(req);
    assertBusinessRules(req.body);

    const automation = await GlobalAutomation.create({
      name: req.body.name,
      enabled: req.body.enabled ?? true,
      trigger: req.body.trigger,
      conditions: req.body.conditions,
      action: {
        type: 'email',
        subject: req.body.action.subject,
        message: req.body.action.message,
        recipients: req.body.action.recipients || 'woning_owners',
        customEmails: req.body.action.customEmails,
      },
      cooldownMinutes: req.body.cooldownMinutes,
      createdBy: req.user._id,
    });

    await globalAutomationEngine.loadAll();
    res.status(201).json(automation);
  } catch (err) {
    next(err);
  }
});

router.patch(
  '/:automationId',
  automationValidators.map((v) => v.optional()),
  async (req, res, next) => {
    try {
      checkValidation(req);
      if (req.body.trigger) assertBusinessRules(req.body);

      const automation = await GlobalAutomation.findByIdAndUpdate(req.params.automationId, req.body, {
        new: true,
        runValidators: true,
      });
      if (!automation) throw new ApiError(404, 'Automation not found');

      await globalAutomationEngine.loadAll();
      res.json(automation);
    } catch (err) {
      next(err);
    }
  }
);

router.delete('/:automationId', async (req, res, next) => {
  try {
    const automation = await GlobalAutomation.findByIdAndDelete(req.params.automationId);
    if (!automation) throw new ApiError(404, 'Automation not found');

    await globalAutomationEngine.loadAll();
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
