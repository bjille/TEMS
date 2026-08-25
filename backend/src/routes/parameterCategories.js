const express = require('express');
const { body, validationResult } = require('express-validator');
const ParameterCategory = require('../models/ParameterCategory');
const Parameter = require('../models/Parameter');
const GlobalParameter = require('../models/GlobalParameter');
const { authenticate, requireSuperadmin } = require('../middleware/authenticate');
const { ApiError } = require('../middleware/errorHandler');

const router = express.Router();

function checkValidation(req) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(400, 'Validation failed', errors.array());
}

// Readable by any authenticated user (used to populate the dashboard's
// category filter), mutable by superadmins only.
router.get('/', authenticate, async (req, res, next) => {
  try {
    const categories = await ParameterCategory.find().sort({ name: 1 });
    res.json(categories);
  } catch (err) {
    next(err);
  }
});

router.post(
  '/',
  authenticate,
  requireSuperadmin,
  [body('name').isString().trim().notEmpty()],
  async (req, res, next) => {
    try {
      checkValidation(req);
      const category = await ParameterCategory.create({
        name: req.body.name.trim(),
        createdBy: req.user._id,
      });
      res.status(201).json(category);
    } catch (err) {
      if (err.code === 11000) return next(new ApiError(409, 'Een categorie met deze naam bestaat al'));
      next(err);
    }
  }
);

router.patch(
  '/:categoryId',
  authenticate,
  requireSuperadmin,
  [body('name').isString().trim().notEmpty()],
  async (req, res, next) => {
    try {
      checkValidation(req);
      const category = await ParameterCategory.findById(req.params.categoryId);
      if (!category) throw new ApiError(404, 'Categorie niet gevonden');

      const newName = req.body.name.trim();
      const oldName = category.name;
      if (newName !== oldName) {
        category.name = newName;
        await category.save();
        // Keep every parameter already tagged with the old name in sync.
        await Parameter.updateMany({ category: oldName }, { category: newName });
        await GlobalParameter.updateMany({ category: oldName }, { category: newName });
      }
      res.json(category);
    } catch (err) {
      if (err.code === 11000) return next(new ApiError(409, 'Een categorie met deze naam bestaat al'));
      next(err);
    }
  }
);

router.delete('/:categoryId', authenticate, requireSuperadmin, async (req, res, next) => {
  try {
    const category = await ParameterCategory.findByIdAndDelete(req.params.categoryId);
    if (!category) throw new ApiError(404, 'Categorie niet gevonden');
    // Parameters that used this category fall back to "Overig" rather than
    // keeping a name that no longer exists in the managed list.
    await Parameter.updateMany({ category: category.name }, { category: '' });
    await GlobalParameter.updateMany({ category: category.name }, { category: '' });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
