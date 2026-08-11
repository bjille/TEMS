const mongoose = require('mongoose');

const OPERATORS = ['gt', 'gte', 'lt', 'lte', 'eq', 'neq'];

const conditionSchema = new mongoose.Schema(
  {
    parameter: { type: mongoose.Schema.Types.ObjectId, ref: 'Parameter', required: true },
    operator: { type: String, enum: OPERATORS, required: true },
    value: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { _id: false }
);

const automationSchema = new mongoose.Schema(
  {
    woning: { type: mongoose.Schema.Types.ObjectId, ref: 'Woning', required: true, index: true },
    name: { type: String, required: true, trim: true },
    enabled: { type: Boolean, default: true },
    trigger: {
      type: { type: String, enum: ['state', 'schedule'], required: true },
      // 5-field cron expression, only used when type === 'schedule'
      cronExpression: { type: String, trim: true },
    },
    conditions: {
      type: [conditionSchema],
      validate: (v) => Array.isArray(v) && v.length > 0,
    },
    action: {
      parameter: { type: mongoose.Schema.Types.ObjectId, ref: 'Parameter', required: true },
      action: { type: String, required: true, trim: true },
      payload: { type: mongoose.Schema.Types.Mixed },
    },
    cooldownMinutes: { type: Number, default: 5, min: 0 },
    lastTriggeredAt: { type: Date },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Automation', automationSchema);
module.exports.OPERATORS = OPERATORS;
