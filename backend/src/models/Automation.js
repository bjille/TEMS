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
      type: { type: String, enum: ['state', 'schedule', 'timer'], required: true },
      // 5-field cron expression, only used when type === 'schedule'
      cronExpression: { type: String, trim: true },
      // Fields below are only used when type === 'timer'. A timer automation
      // has no fixed schedule at creation time — its actual clock time or
      // countdown duration is set (and changed) live from the dashboard.
      timerMode: { type: String, enum: ['countdown', 'clock'] },
      // 'clock' mode: fires daily at this "HH:MM", editable from the dashboard.
      timerClockTime: { type: String, trim: true },
      // 'countdown' mode: duration used the last time the timer was armed.
      timerDurationMinutes: { type: Number, min: 1 },
      // 'countdown' mode: whether a countdown is currently running.
      timerArmed: { type: Boolean, default: false },
      // 'countdown' mode: absolute moment the armed countdown fires, persisted
      // so an in-progress countdown survives a backend restart.
      timerTargetAt: { type: Date },
    },
    // Sensor conditions. Required for 'state'/'schedule' triggers, optional
    // for 'timer' triggers (which fire purely on time) — enforced in
    // routes/automations.js's assertBusinessRules rather than here, since
    // Mongoose update validators can't reliably see sibling fields via `this`.
    conditions: {
      type: [conditionSchema],
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
