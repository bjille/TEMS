const express = require('express');
const { body, validationResult } = require('express-validator');
const Parameter = require('../models/Parameter');
const CommandLog = require('../models/CommandLog');
const { authenticate } = require('../middleware/authenticate');
const { authorizeWoning } = require('../middleware/authorizeWoning');
const { ApiError } = require('../middleware/errorHandler');
const { haConnectionManager } = require('../services/haConnectionManager');

const router = express.Router({ mergeParams: true });

function checkValidation(req) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(400, 'Validation failed', errors.array());
}

router.use(authenticate, authorizeWoning());

// Trigger a Home Assistant service call for a controllable parameter,
// e.g. { action: "turn_on" } on a switch, or { action: "set_value", payload: { value: 40 } }.
router.post(
  '/:parameterId',
  [body('action').isString().notEmpty(), body('payload').optional().isObject()],
  async (req, res, next) => {
    const { woningId, parameterId } = req.params;
    const { action, payload } = req.body;
    let result = 'success';
    let errorMessage;

    try {
      checkValidation(req);
      const parameter = await Parameter.findOne({ _id: parameterId, woning: woningId });
      if (!parameter) throw new ApiError(404, 'Parameter not found');
      if (!parameter.controllable) throw new ApiError(400, 'This parameter is not controllable');

      // HA entity_ids are always "<domain>.<object_id>" (e.g. "light.smart_panel_lights"),
      // so the service domain can be derived from it. controlDomain only needs to be set
      // to override this (e.g. to call a cross-domain service like "homeassistant.turn_on").
      const domain = parameter.controlDomain || parameter.entityId.split('.')[0];

      const client = haConnectionManager.getClient(woningId);
      if (!client) throw new ApiError(503, 'Home Assistant connection not available');

      await client.callService(domain, action, {
        entity_id: parameter.entityId,
        ...payload,
      });

      res.json({ ok: true });
    } catch (err) {
      result = 'error';
      errorMessage = err.message;
      return next(err);
    } finally {
      await CommandLog.create({
        woning: woningId,
        parameter: parameterId,
        user: req.user._id,
        action,
        payload,
        result,
        error: errorMessage,
      }).catch((logErr) => console.error('Failed to write command log', logErr));
    }
  }
);

router.get('/history', async (req, res, next) => {
  try {
    const logs = await CommandLog.find({ woning: req.params.woningId })
      .sort({ createdAt: -1 })
      .limit(200)
      .populate('parameter', 'label entityId')
      .populate('user', 'name email');
    res.json(logs);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
