const express = require('express');
const { body, validationResult } = require('express-validator');
const SmartChargePlan = require('../models/SmartChargePlan');
const Parameter = require('../models/Parameter');
const { authenticate } = require('../middleware/authenticate');
const { authorizeWoning } = require('../middleware/authorizeWoning');
const { ApiError } = require('../middleware/errorHandler');
const { smartChargeEngine, evaluatePlan } = require('../services/smartChargeEngine');

const router = express.Router({ mergeParams: true });

// Includes controlDomain (unlike the display-only fields alone) because
// evaluateAndAct needs it to know which HA service domain to call for
// chargeSwitchParameter.
const POPULATE_FIELDS = 'label unit type entityId controlDomain';
const POPULATE_PATHS = [
  { path: 'socParameter', select: POPULATE_FIELDS },
  { path: 'solarRemainingParameter', select: POPULATE_FIELDS },
  { path: 'consumptionParameter', select: POPULATE_FIELDS },
  { path: 'priceParameter', select: POPULATE_FIELDS },
  { path: 'chargeSwitchParameter', select: POPULATE_FIELDS },
];

function checkValidation(req) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(400, 'Validation failed', errors.array());
}

async function assertParametersBelongToWoning(parameterIds, woningId) {
  const ids = parameterIds.filter(Boolean);
  if (ids.length === 0) return;
  const count = await Parameter.countDocuments({ _id: { $in: ids }, woning: woningId });
  if (count !== new Set(ids.map(String)).size) {
    throw new ApiError(400, 'Eén of meer parameters horen niet bij deze woning');
  }
}

const planFieldValidators = [
  body('name').isString().notEmpty(),
  body('capacityKwh').isFloat({ min: 0.1 }),
  body('targetSocPercent').optional().isFloat({ min: 1, max: 100 }),
  body('maxChargePowerKw').isFloat({ min: 0.01 }),
  body('priority').optional().isInt(),
  body('socParameter').isMongoId(),
  body('solarRemainingParameter').isMongoId(),
  body('consumptionParameter').optional({ checkFalsy: true }).isMongoId(),
  body('priceParameter').isMongoId(),
  body('chargeSwitchParameter').isMongoId(),
];

router.use(authenticate, authorizeWoning());

// List smart-charge plans for a woning, each enriched with a live computed
// status — same computation the engine itself acts on, so what a user sees
// here is exactly what's driving (or would drive, once enabled) the switch.
router.get('/', async (req, res, next) => {
  try {
    const plans = await SmartChargePlan.find({ woning: req.params.woningId })
      .sort({ createdAt: 1 })
      .populate(POPULATE_PATHS);
    const withStatus = await Promise.all(
      plans.map(async (p) => ({ ...p.toObject(), status: await evaluatePlan(p).catch(() => null) }))
    );
    res.json(withStatus);
  } catch (err) {
    next(err);
  }
});

// Live recommendation for a single plan — polled by the dashboard card.
router.get('/:planId/status', async (req, res, next) => {
  try {
    const plan = await SmartChargePlan.findOne({
      _id: req.params.planId,
      woning: req.params.woningId,
    }).populate(POPULATE_PATHS);
    if (!plan) throw new ApiError(404, 'Smart charge plan not found');
    res.json(await evaluatePlan(plan));
  } catch (err) {
    next(err);
  }
});

router.post('/', authorizeWoning(['owner']), planFieldValidators, async (req, res, next) => {
  try {
    checkValidation(req);
    await assertParametersBelongToWoning(
      [
        req.body.socParameter,
        req.body.solarRemainingParameter,
        req.body.consumptionParameter,
        req.body.priceParameter,
        req.body.chargeSwitchParameter,
      ],
      req.params.woningId
    );

    const plan = await SmartChargePlan.create({
      woning: req.params.woningId,
      name: req.body.name,
      capacityKwh: req.body.capacityKwh,
      targetSocPercent: req.body.targetSocPercent ?? 100,
      maxChargePowerKw: req.body.maxChargePowerKw,
      priority: req.body.priority ?? 0,
      socParameter: req.body.socParameter,
      solarRemainingParameter: req.body.solarRemainingParameter,
      consumptionParameter: req.body.consumptionParameter || undefined,
      priceParameter: req.body.priceParameter,
      chargeSwitchParameter: req.body.chargeSwitchParameter,
      createdBy: req.user._id,
    });

    const populated = await plan.populate(POPULATE_PATHS);
    // A fresh plan defaults to enabled:false, so this only computes the
    // recommendation (never actuates) — but it means the very first view
    // of a new plan already shows a real status instead of "laden...".
    const status = await smartChargeEngine.evaluateAndAct(populated);
    res.status(201).json({ ...populated.toObject(), status });
  } catch (err) {
    next(err);
  }
});

router.patch(
  '/:planId',
  authorizeWoning(['owner']),
  planFieldValidators.map((v) => v.optional()),
  async (req, res, next) => {
    try {
      checkValidation(req);
      if (
        req.body.socParameter ||
        req.body.solarRemainingParameter ||
        req.body.consumptionParameter ||
        req.body.priceParameter ||
        req.body.chargeSwitchParameter
      ) {
        await assertParametersBelongToWoning(
          [
            req.body.socParameter,
            req.body.solarRemainingParameter,
            req.body.consumptionParameter,
            req.body.priceParameter,
            req.body.chargeSwitchParameter,
          ],
          req.params.woningId
        );
      }

      const updates = { ...req.body };
      // An empty selection clears the (optional) consumption parameter
      // rather than being cast to an ObjectId, which would throw.
      if ('consumptionParameter' in updates && !updates.consumptionParameter) {
        updates.consumptionParameter = null;
      }

      const plan = await SmartChargePlan.findOneAndUpdate(
        { _id: req.params.planId, woning: req.params.woningId },
        updates,
        { new: true, runValidators: true }
      ).populate(POPULATE_PATHS);
      if (!plan) throw new ApiError(404, 'Smart charge plan not found');

      // Recompute (and, if this plan is enabled, act on) right away rather
      // than leaving the old recommendation showing until the next tick —
      // changing which parameter feeds the plan, or its capacity/target/
      // power, changes what the plan should now be doing.
      const status = await smartChargeEngine.evaluateAndAct(plan);
      res.json({ ...plan.toObject(), status });
    } catch (err) {
      next(err);
    }
  }
);

// Lightweight on/off switch for the plan itself, separate from the full
// PATCH so the dashboard card can flip it without resending the whole
// config. Gated the same as the rest of plan management ('owner', matching
// how Automation's own `enabled` field requires 'owner' too) rather than
// opened to any woning member: unlike a timer's arm/disarm, this doesn't
// just trigger a one-off action — it hands the engine standing permission
// to operate real grid-charge hardware on its own until switched off again.
router.patch(
  '/:planId/toggle',
  authorizeWoning(['owner']),
  [body('enabled').isBoolean()],
  async (req, res, next) => {
    try {
      checkValidation(req);
      const plan = await SmartChargePlan.findOneAndUpdate(
        { _id: req.params.planId, woning: req.params.woningId },
        { enabled: req.body.enabled },
        { new: true }
      ).populate(POPULATE_PATHS);
      if (!plan) throw new ApiError(404, 'Smart charge plan not found');

      // Switching on shouldn't wait up to 10 minutes for the next tick
      // before the switch actually follows the plan.
      const status = await smartChargeEngine.evaluateAndAct(plan);
      res.json({ ...plan.toObject(), status });
    } catch (err) {
      next(err);
    }
  }
);

router.delete('/:planId', authorizeWoning(['owner']), async (req, res, next) => {
  try {
    const plan = await SmartChargePlan.findOneAndDelete({
      _id: req.params.planId,
      woning: req.params.woningId,
    });
    if (!plan) throw new ApiError(404, 'Smart charge plan not found');
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
