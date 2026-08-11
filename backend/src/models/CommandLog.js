const mongoose = require('mongoose');

const commandLogSchema = new mongoose.Schema(
  {
    woning: { type: mongoose.Schema.Types.ObjectId, ref: 'Woning', required: true, index: true },
    parameter: { type: mongoose.Schema.Types.ObjectId, ref: 'Parameter', required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    action: { type: String, required: true }, // e.g. "turn_on", "turn_off", "set_mode"
    payload: { type: mongoose.Schema.Types.Mixed },
    result: { type: String, enum: ['success', 'error'], required: true },
    error: { type: String },
    source: { type: String, enum: ['manual', 'automation'], default: 'manual' },
    automation: { type: mongoose.Schema.Types.ObjectId, ref: 'Automation' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('CommandLog', commandLogSchema);
