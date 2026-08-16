const express = require('express');
const { body, validationResult } = require('express-validator');
const GlobalParameter = require('../models/GlobalParameter');
const { PARAMETER_TYPES } = require('../models/Parameter');
const { authenticate, requireSuperadmin } = require('../middleware/authenticate');
const { ApiError } = require('../middleware/errorHandler');
const { applyToAllWoningen, removeFromAllWoningen } = require('../services/globalParameterService');

const router = express.Router();

function checkValidation(req) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(400, 'Validation failed', errors.array());
}

const createValidators = [
  body('entityId').isString().notEmpty(),
  body('type').isIn(PARAMETER_TYPES),
  body('label').isString().notEmpty(),
  body('unit').optional().isString(),
  body('icon').optional().isString(),
  body('controllable').optional().isBoolean(),
  body('controlDomain').optional().isString(),
  body('favorite').optional().isBoolean(),
  body('options').optional().isArray(),
  body('options.*').optional().isString(),
  body('optionLabels').optional().isObject(),
];

router.use(authenticate, requireSuperadmin);

router.get('/', async (req, res, next) => {
  try {
    const items = await GlobalParameter.find().sort({ createdAt: 1 });
    res.json(items);
  } catch (err) {
    next(err);
  }
});

router.post('/', createValidators, async (req, res, next) => {
  try {
    checkValidation(req);
    const globalParameter = await GlobalParameter.create({
      entityId: req.body.entityId,
      type: req.body.type,
      label: req.body.label,
      unit: req.body.unit,
      icon: req.body.icon,
      controllable: req.body.controllable || false,
      controlDomain: req.body.controlDomain,
      favorite: req.body.favorite || false,
      options: req.body.options || [],
      optionLabels: req.body.optionLabels,
      createdBy: req.user._id,
    });

    await applyToAllWoningen(globalParameter);
    res.status(201).json(globalParameter);
  } catch (err) {
    if (err.code === 11000) {
      return next(new ApiError(409, 'A global parameter for this entity_id already exists'));
    }
    next(err);
  }
});

router.patch(
  '/:globalParameterId',
  [
    body('type').optional().isIn(PARAMETER_TYPES),
    body('label').optional().isString().notEmpty(),
    body('unit').optional().isString(),
    body('icon').optional().isString(),
    body('controllable').optional().isBoolean(),
    body('controlDomain').optional().isString(),
    body('favorite').optional().isBoolean(),
    body('options').optional().isArray(),
    body('options.*').optional().isString(),
    body('optionLabels').optional().isObject(),
  ],
  async (req, res, next) => {
    try {
      checkValidation(req);
      const globalParameter = await GlobalParameter.findById(req.params.globalParameterId);
      if (!globalParameter) throw new ApiError(404, 'Global parameter not found');

      // entityId is immutable: it's how each woning's Parameter copy is
      // matched, so changing it here would silently orphan every copy.
      const { type, label, unit, icon, controllable, controlDomain, favorite, options, optionLabels } =
        req.body;
      if (type !== undefined) globalParameter.type = type;
      if (label !== undefined) globalParameter.label = label;
      if (unit !== undefined) globalParameter.unit = unit;
      if (icon !== undefined) globalParameter.icon = icon;
      if (controllable !== undefined) globalParameter.controllable = controllable;
      if (controlDomain !== undefined) globalParameter.controlDomain = controlDomain;
      if (favorite !== undefined) globalParameter.favorite = favorite;
      if (options !== undefined) globalParameter.options = options;
      if (optionLabels !== undefined) globalParameter.optionLabels = optionLabels;
      await globalParameter.save();

      await applyToAllWoningen(globalParameter);
      res.json(globalParameter);
    } catch (err) {
      next(err);
    }
  }
);

router.delete('/:globalParameterId', async (req, res, next) => {
  try {
    const globalParameter = await GlobalParameter.findByIdAndDelete(req.params.globalParameterId);
    if (!globalParameter) throw new ApiError(404, 'Global parameter not found');

    await removeFromAllWoningen(globalParameter);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
