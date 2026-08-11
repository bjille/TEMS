const express = require('express');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const { authenticate, requireSuperadmin } = require('../middleware/authenticate');
const { ApiError } = require('../middleware/errorHandler');

const router = express.Router();

function checkValidation(req) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(400, 'Validation failed', errors.array());
}

router.use(authenticate, requireSuperadmin);

router.get('/', async (req, res, next) => {
  try {
    const users = await User.find().sort({ createdAt: -1 });
    res.json(users);
  } catch (err) {
    next(err);
  }
});

router.post(
  '/',
  [
    body('email').isEmail(),
    body('password').isString().isLength({ min: 8 }),
    body('name').isString().notEmpty(),
    body('role').optional().isIn(['superadmin', 'user']),
  ],
  async (req, res, next) => {
    try {
      checkValidation(req);
      const { email, password, name, role } = req.body;
      const passwordHash = await bcrypt.hash(password, 12);
      const user = await User.create({
        email: email.toLowerCase(),
        passwordHash,
        name,
        role: role || 'user',
      });
      res.status(201).json({ id: user._id, email: user.email, name: user.name, role: user.role });
    } catch (err) {
      if (err.code === 11000) return next(new ApiError(409, 'Email already in use'));
      next(err);
    }
  }
);

router.patch(
  '/:userId',
  [
    body('name').optional().isString().notEmpty(),
    body('role').optional().isIn(['superadmin', 'user']),
    body('active').optional().isBoolean(),
    body('password').optional().isString().isLength({ min: 8 }),
  ],
  async (req, res, next) => {
    try {
      checkValidation(req);
      const user = await User.findById(req.params.userId);
      if (!user) throw new ApiError(404, 'User not found');

      const { name, role, active, password } = req.body;
      if (name !== undefined) user.name = name;
      if (role !== undefined) user.role = role;
      if (active !== undefined) user.active = active;
      if (password !== undefined) user.passwordHash = await bcrypt.hash(password, 12);
      await user.save();

      res.json({ id: user._id, email: user.email, name: user.name, role: user.role, active: user.active });
    } catch (err) {
      next(err);
    }
  }
);

router.delete('/:userId', async (req, res, next) => {
  try {
    const user = await User.findByIdAndDelete(req.params.userId);
    if (!user) throw new ApiError(404, 'User not found');
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
