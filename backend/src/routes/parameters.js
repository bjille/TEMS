const express = require('express');
const { body, validationResult } = require('express-validator');
const Parameter = require('../models/Parameter');
const Reading = require('../models/Reading');
const { authenticate, requireSuperadmin } = require('../middleware/authenticate');
const { authorizeWoning } = require('../middleware/authorizeWoning');
const { ApiError } = require('../middleware/errorHandler');
const { PARAMETER_TYPES } = require('../models/Parameter');
const { haConnectionManager } = require('../services/haConnectionManager');

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

router.post(
  '/',
  requireSuperadmin,
  [
    body('entityId').isString().notEmpty(),
    body('type').isIn(PARAMETER_TYPES),
    body('label').isString().notEmpty(),
    body('unit').optional().isString(),
    body('icon').optional().isString(),
    body('controllable').optional().isBoolean(),
    body('controlDomain').optional().isString(),
    body('favorite').optional().isBoolean(),
    body('realtime').optional().isBoolean(),
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
        controllable: req.body.controllable || false,
        controlDomain: req.body.controlDomain,
        favorite: req.body.favorite || false,
        realtime: req.body.realtime || false,
        options: req.body.options || [],
        optionLabels: req.body.optionLabels,
        createdBy: req.user._id,
      });

      await haConnectionManager.resubscribe(req.params.woningId);
      res.status(201).json(parameter);
    } catch (err) {
      if (err.code === 11000) {
        return next(new ApiError(409, 'This entity is already mapped for this woning'));
      }
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
    body('controllable').optional().isBoolean(),
    body('controlDomain').optional().isString(),
    body('type').optional().isIn(PARAMETER_TYPES),
    body('favorite').optional().isBoolean(),
    body('realtime').optional().isBoolean(),
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
      if (req.body.realtime !== undefined) {
        await haConnectionManager.resubscribe(req.params.woningId);
      }
      res.json(parameter);
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
