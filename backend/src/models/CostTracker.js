const mongoose = require('mongoose');

// One cost calculation: what flows through `meterParameter` multiplied by
// the price `priceParameter` reports at that moment, per hour (see
// services/costEngine.js). A woning can have several — e.g. one for
// electricity from the grid, one for gas, or one for a single device with
// its own energy counter.
const costTrackerSchema = new mongoose.Schema(
  {
    woning: { type: mongoose.Schema.Types.ObjectId, ref: 'Woning', required: true, index: true },
    name: { type: String, required: true, trim: true },
    // A cumulative counter (kWh, m³): either an ever-increasing meter total
    // or a counter that resets daily — usage per hour is how much it rose.
    meterParameter: { type: mongoose.Schema.Types.ObjectId, ref: 'Parameter', required: true },
    // A sensor whose state is the price right now, per unit (€/kWh, €/m³ —
    // €/MWh is converted to €/kWh).
    priceParameter: { type: mongoose.Schema.Types.ObjectId, ref: 'Parameter', required: true },
    // Multiplies the meter's rise into the unit the price is in: 1 normally,
    // ≈ 10.5 for a gas meter in m³ with a price per kWh.
    meterConversionFactor: { type: Number, default: 1, min: 0 },
    // Costs are calculated from this moment on.
    validFrom: { type: Date, required: true },
    // Bookkeeping from the cost engine: up to where quarters have been
    // computed, and the last problem, shown in the UI.
    computedUntil: { type: Date },
    lastError: { type: String },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('CostTracker', costTrackerSchema);
