const mongoose = require('mongoose');
const { PARAMETER_TYPES } = require('./Parameter');
const { OPERATORS } = require('./Automation');

const RECIPIENT_MODES = ['woning_owners', 'woning_users', 'custom'];

// Same condition/trigger shape as a per-woning Automation, except conditions
// match a parameter TYPE (e.g. "battery_soc") instead of one specific
// Parameter, since a global automation runs across every woning at once.
const conditionSchema = new mongoose.Schema(
  {
    parameterType: { type: String, enum: PARAMETER_TYPES, required: true },
    operator: { type: String, enum: OPERATORS, required: true },
    value: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { _id: false }
);

const globalAutomationSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    enabled: { type: Boolean, default: true },
    trigger: {
      type: { type: String, enum: ['state', 'schedule'], required: true },
      cronExpression: { type: String, trim: true },
    },
    conditions: {
      type: [conditionSchema],
      validate: (v) => Array.isArray(v) && v.length > 0,
    },
    action: {
      type: { type: String, enum: ['email'], required: true, default: 'email' },
      subject: { type: String, trim: true },
      message: { type: String, trim: true },
      recipients: { type: String, enum: RECIPIENT_MODES, default: 'woning_owners' },
      customEmails: [{ type: String, trim: true }],
    },
    cooldownMinutes: { type: Number, default: 60, min: 0 },
    // Per-woning, since one global rule fires independently for each woning
    // it matches (e.g. woning A's battery hits 100% long before woning B's).
    lastTriggeredByWoning: { type: Map, of: Date, default: undefined },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('GlobalAutomation', globalAutomationSchema);
module.exports.RECIPIENT_MODES = RECIPIENT_MODES;
