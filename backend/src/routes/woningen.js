const express = require('express');
const { body, validationResult } = require('express-validator');
const Woning = require('../models/Woning');
const WoningUser = require('../models/WoningUser');
const User = require('../models/User');
const { authenticate, requireSuperadmin } = require('../middleware/authenticate');
const { authorizeWoning } = require('../middleware/authorizeWoning');
const { ApiError } = require('../middleware/errorHandler');
const { encrypt } = require('../utils/crypto');
const { haConnectionManager } = require('../services/haConnectionManager');

const router = express.Router();

function checkValidation(req) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(400, 'Validation failed', errors.array());
}

router.use(authenticate);

// List woningen visible to the current user, each annotated with the
// requester's role so the frontend can decide whether to show management
// controls (e.g. creating automations is limited to 'owner'/superadmin).
router.get('/', async (req, res, next) => {
  try {
    if (req.user.role === 'superadmin') {
      const woningen = await Woning.find().sort({ name: 1 });
      return res.json(woningen.map((w) => ({ ...w.toObject(), role: 'superadmin' })));
    }
    const links = await WoningUser.find({ user: req.user._id }).populate('woning');
    res.json(
      links
        .filter((l) => l.woning)
        .map((l) => ({ ...l.woning.toObject(), role: l.role }))
    );
  } catch (err) {
    next(err);
  }
});

router.post(
  '/',
  requireSuperadmin,
  [
    body('name').isString().notEmpty(),
    body('haBaseUrl').isURL({ require_tld: false }),
    body('haToken').isString().notEmpty(),
  ],
  async (req, res, next) => {
    try {
      checkValidation(req);
      const { name, address, haBaseUrl, haToken } = req.body;
      const woning = await Woning.create({
        name,
        address,
        haBaseUrl,
        haTokenEncrypted: encrypt(haToken),
      });
      await haConnectionManager.start(woning._id, req.app.get('io'));
      res.status(201).json(woning);
    } catch (err) {
      next(err);
    }
  }
);

router.get('/:woningId', authorizeWoning(), async (req, res, next) => {
  try {
    const woning = await Woning.findById(req.params.woningId);
    if (!woning) throw new ApiError(404, 'Woning not found');
    res.json(woning);
  } catch (err) {
    next(err);
  }
});

router.patch(
  '/:woningId',
  requireSuperadmin,
  [
    body('name').optional().isString().notEmpty(),
    body('address').optional().isString(),
    body('haBaseUrl').optional().isURL({ require_tld: false }),
    body('haToken').optional().isString().notEmpty(),
    body('status').optional().isIn(['active', 'paused', 'error']),
  ],
  async (req, res, next) => {
    try {
      checkValidation(req);
      const woning = await Woning.findById(req.params.woningId);
      if (!woning) throw new ApiError(404, 'Woning not found');

      const { name, address, haBaseUrl, haToken, status } = req.body;
      if (name !== undefined) woning.name = name;
      if (address !== undefined) woning.address = address;
      if (haBaseUrl !== undefined) woning.haBaseUrl = haBaseUrl;
      if (haToken !== undefined) woning.haTokenEncrypted = encrypt(haToken);
      if (status !== undefined) woning.status = status;
      await woning.save();

      if (haBaseUrl !== undefined || haToken !== undefined || status !== undefined) {
        await haConnectionManager.restart(woning._id, req.app.get('io'));
      }

      res.json(woning);
    } catch (err) {
      next(err);
    }
  }
);

router.delete('/:woningId', requireSuperadmin, async (req, res, next) => {
  try {
    const woning = await Woning.findByIdAndDelete(req.params.woningId);
    if (!woning) throw new ApiError(404, 'Woning not found');
    await WoningUser.deleteMany({ woning: woning._id });
    haConnectionManager.stop(woning._id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// --- Woning <-> user rights management ---

router.get('/:woningId/users', authorizeWoning(), async (req, res, next) => {
  try {
    const links = await WoningUser.find({ woning: req.params.woningId }).populate(
      'user',
      'email name role active'
    );
    res.json(links);
  } catch (err) {
    next(err);
  }
});

router.post(
  '/:woningId/users',
  requireSuperadmin,
  [body('userId').isMongoId(), body('role').optional().isIn(['owner', 'member'])],
  async (req, res, next) => {
    try {
      checkValidation(req);
      const woning = await Woning.findById(req.params.woningId);
      if (!woning) throw new ApiError(404, 'Woning not found');
      const user = await User.findById(req.body.userId);
      if (!user) throw new ApiError(404, 'User not found');

      const link = await WoningUser.findOneAndUpdate(
        { user: user._id, woning: woning._id },
        { role: req.body.role || 'member' },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      res.status(201).json(link);
    } catch (err) {
      next(err);
    }
  }
);

router.delete('/:woningId/users/:userId', requireSuperadmin, async (req, res, next) => {
  try {
    await WoningUser.findOneAndDelete({
      woning: req.params.woningId,
      user: req.params.userId,
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
