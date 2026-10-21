const mongoose = require('mongoose');

// One hour of one SmartChargePlan's actual grid-charging, as reconstructed
// and priced by services/smartChargeEngine.js's history backfill: how much
// was actually drawn from the grid to charge that hour, what it cost at the
// real price, and what that same energy would have cost at the plan's
// avoidedPrice reference instead (see computeAvoidedPrice) — the basis for
// showing what smart timing saved. Written (and overwritten, so every
// backfill is idempotent) per plan per hour.
const smartChargeHistorySchema = new mongoose.Schema({
  woning: { type: mongoose.Schema.Types.ObjectId, ref: 'Woning', required: true },
  plan: { type: mongoose.Schema.Types.ObjectId, ref: 'SmartChargePlan', required: true },
  start: { type: Date, required: true },
  gridChargedKwh: { type: Number, default: 0 },
  price: { type: Number, required: true },
  actualCost: { type: Number, default: 0 },
  avoidedPrice: { type: Number },
  avoidedPriceBasis: { type: String, enum: ['average', 'consumption_weighted', 'max'] },
  hypotheticalCost: { type: Number },
});

smartChargeHistorySchema.index({ plan: 1, start: 1 }, { unique: true });
smartChargeHistorySchema.index({ woning: 1, start: 1 });

module.exports = mongoose.model('SmartChargeHistory', smartChargeHistorySchema);
