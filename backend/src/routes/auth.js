const express = require('express');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const { signAccessToken, signRefreshToken, verifyRefreshToken } = require('../utils/tokens');
const { ApiError } = require('../middleware/errorHandler');
const { authenticate } = require('../middleware/authenticate');

const router = express.Router();

function checkValidation(req) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    throw new ApiError(400, 'Validation failed', errors.array());
  }
}

router.post(
  '/login',
  [body('email').isEmail(), body('password').isString().notEmpty()],
  async (req, res, next) => {
    try {
      checkValidation(req);
      const { email, password } = req.body;

      const user = await User.findOne({ email: email.toLowerCase(), active: true });
      if (!user) throw new ApiError(401, 'Invalid credentials');

      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) throw new ApiError(401, 'Invalid credentials');

      res.json({
        accessToken: signAccessToken(user),
        refreshToken: signRefreshToken(user),
        user: { id: user._id, email: user.email, name: user.name, role: user.role },
      });
    } catch (err) {
      next(err);
    }
  }
);

router.post('/refresh', [body('refreshToken').isString().notEmpty()], async (req, res, next) => {
  try {
    checkValidation(req);
    const payload = verifyRefreshToken(req.body.refreshToken);
    const user = await User.findById(payload.sub);
    if (!user || !user.active) throw new ApiError(401, 'Invalid refresh token');

    res.json({
      accessToken: signAccessToken(user),
      refreshToken: signRefreshToken(user),
    });
  } catch (err) {
    next(new ApiError(401, 'Invalid or expired refresh token'));
  }
});

router.get('/me', authenticate, async (req, res) => {
  const { _id, email, name, role } = req.user;
  res.json({ id: _id, email, name, role });
});

module.exports = router;
