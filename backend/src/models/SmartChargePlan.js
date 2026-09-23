const mongoose = require('mongoose');

// Decides whether — and during which hours — a chargeable target (the home
// battery today, potentially an EV charger or another target later) should
// be topped up from the grid: only for the shortfall the solar forecast
// won't cover before it reaches `targetSocPercent`, scheduled during the
// cheapest upcoming hours of `priceParameter`'s hourly forecast. See
// services/smartChargeEngine.js for the actual computation and, when
// `enabled`, the periodic actuation of `chargeSwitchParameter`.
const smartChargePlanSchema = new mongoose.Schema(
  {
    woning: { type: mongoose.Schema.Types.ObjectId, ref: 'Woning', required: true, index: true },
    name: { type: String, required: true, trim: true },
    // Off by default: a new plan only computes/shows a recommendation until
    // a woning owner deliberately switches it on to let the engine actually
    // operate the grid-charge switch.
    enabled: { type: Boolean, default: false },
    // Lower runs first when multiple plans would compete for the same
    // limited grid-charge budget. Not yet enforced — every enabled plan is
    // evaluated independently today — but reserved so a future multi-target
    // scheduler (e.g. battery + EV, charged in priority order) doesn't need
    // a schema migration.
    priority: { type: Number, default: 0 },
    // Usable capacity of the thing being charged, in kWh. No HA sensor
    // exposes this for a battery (and an EV's usable capacity is a property
    // of whichever car is plugged in), so it's a plain configured number.
    capacityKwh: { type: Number, required: true, min: 0.1 },
    targetSocPercent: { type: Number, default: 100, min: 1, max: 100 },
    // How fast `chargeSwitchParameter` can pull from the grid, in kW — used
    // to convert a kWh shortfall into a number of hours to schedule.
    maxChargePowerKw: { type: Number, required: true, min: 0.01 },
    // Current state-of-charge, 0-100 (e.g. a battery_soc parameter).
    socParameter: { type: mongoose.Schema.Types.ObjectId, ref: 'Parameter', required: true },
    // Remaining solar production forecast for the rest of today, in kWh.
    solarRemainingParameter: { type: mongoose.Schema.Types.ObjectId, ref: 'Parameter', required: true },
    // Actual home power consumption (W), e.g. an 'energy_consumption'
    // parameter — the same kind of sensor an EnergyFlowChart's flowRoles.thuis
    // points at. Optional: when set, the engine nets its historical average
    // daily consumption off the remaining solar forecast before computing the
    // grid-charge shortfall, since remaining solar has to cover household load
    // before any of it reaches the battery. Left unset, the plan falls back to
    // treating all remaining solar as available for charging.
    consumptionParameter: { type: mongoose.Schema.Types.ObjectId, ref: 'Parameter' },
    // A dynamic-prices parameter whose HA entity carries the hourly price
    // curve (see services/priceForecastService.js) — the same kind of
    // parameter a 'price_forecast' DashboardChart uses.
    priceParameter: { type: mongoose.Schema.Types.ObjectId, ref: 'Parameter', required: true },
    // The controllable switch that actually starts/stops grid charging.
    chargeSwitchParameter: { type: mongoose.Schema.Types.ObjectId, ref: 'Parameter', required: true },
    // Bookkeeping from the engine's last tick, surfaced in the admin/status
    // view so it's visible whether — and when — this plan last acted.
    lastEvaluatedAt: { type: Date },
    lastAction: { type: String, enum: ['on', 'off'] },
    lastError: { type: String },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('SmartChargePlan', smartChargePlanSchema);
