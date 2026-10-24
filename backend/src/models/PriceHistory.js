const mongoose = require('mongoose');

// One hour of a dynamic-prices parameter's price curve, as published by the
// HA entity's attributes (see services/priceForecastService.js). HA itself
// only keeps those attributes in its raw state history, which the recorder
// purges after ~10 days, so they're copied here to keep past days' prices
// showable. Written (and overwritten, for late corrections) per parameter
// per hour.
const priceHistorySchema = new mongoose.Schema({
  woning: { type: mongoose.Schema.Types.ObjectId, ref: 'Woning', required: true },
  parameter: { type: mongoose.Schema.Types.ObjectId, ref: 'Parameter', required: true },
  timestamp: { type: Date, required: true },
  price: { type: Number, required: true },
  unit: { type: String },
});

priceHistorySchema.index({ parameter: 1, timestamp: 1 }, { unique: true });

module.exports = mongoose.model('PriceHistory', priceHistorySchema);
