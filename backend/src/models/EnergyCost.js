const mongoose = require('mongoose');

// One hour of one CostTracker: how much the meter rose in that hour, the
// price that hour, and what that cost. Written (and
// overwritten, so every recalculation is idempotent) by
// services/costEngine.js.
const energyCostSchema = new mongoose.Schema({
  woning: { type: mongoose.Schema.Types.ObjectId, ref: 'Woning', required: true },
  tracker: { type: mongoose.Schema.Types.ObjectId, ref: 'CostTracker', required: true },
  start: { type: Date, required: true },
  // In the price's unit, after the tracker's meterConversionFactor.
  quantity: { type: Number, default: 0 },
  price: { type: Number, required: true },
  cost: { type: Number, default: 0 },
});

energyCostSchema.index({ tracker: 1, start: 1 }, { unique: true });
energyCostSchema.index({ woning: 1, start: 1 });

module.exports = mongoose.model('EnergyCost', energyCostSchema);
