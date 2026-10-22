const mongoose = require('mongoose');

const CHART_TYPES = ['line', 'area', 'bar', 'pie', 'energyflow', 'price_forecast', 'cost', 'smart_charge_savings'];
const RANGE_PERIODS = ['rolling', 'month', 'year'];

// A user-defined chart combining one or more Parameters of a woning into a
// single, pre-configured view (e.g. "Energiestromen": PV + batterij + net).
// Optionally pinned to the dashboard via `showOnDashboard`.
const dashboardChartSchema = new mongoose.Schema(
  {
    woning: { type: mongoose.Schema.Types.ObjectId, ref: 'Woning', required: true },
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: CHART_TYPES, default: 'line' },
    rangeHours: { type: Number, default: 24, min: 1 },
    // 'rolling': the last `rangeHours` up to now. 'month' / 'year': the
    // current calendar month / year (an overview, per day / per month),
    // in which case rangeHours is ignored.
    rangePeriod: { type: String, enum: RANGE_PERIODS, default: 'rolling' },
    // Used for type 'line' | 'area' | 'bar' | 'pie': the series to plot over
    // time, or (for 'pie') the parameters to total up over `rangeHours`.
    // For 'price_forecast' this holds exactly one parameter: the entity
    // whose HA attributes carry the hourly price curve (see
    // routes/parameters.js `price-forecast`).
    parameters: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Parameter' }],
    // Used for type 'energyflow': signed power sensors (W) feeding a live
    // Sankey diagram — positive grid/battery means import/discharge, negative
    // means export/charge. "Thuis" (home consumption) falls back to a
    // derived value (whatever balances the other flows) when `thuis` isn't
    // set, but that derivation assumes pv/battery/grid were all sampled at
    // the same instant — in practice they update independently, so a direct
    // `thuis` sensor is preferred whenever one is available.
    flowRoles: {
      pv: { type: mongoose.Schema.Types.ObjectId, ref: 'Parameter' },
      battery: { type: mongoose.Schema.Types.ObjectId, ref: 'Parameter' },
      grid: { type: mongoose.Schema.Types.ObjectId, ref: 'Parameter' },
      thuis: { type: mongoose.Schema.Types.ObjectId, ref: 'Parameter' },
    },
    // Optional per-appliance power sensors (W) that further break "Thuis"
    // down into individual consumers, arranged as a tree via `parent` (which
    // references another entry's `parameter` in this same array, or null
    // for a top-level device sitting directly under "Thuis" — e.g. "Frigo"
    // and "Oven" both parented under "Stroomkring A"). Whatever isn't
    // covered by a level's own children shows as "Overig" at that level.
    devices: [
      {
        parameter: { type: mongoose.Schema.Types.ObjectId, ref: 'Parameter', required: true },
        parent: { type: mongoose.Schema.Types.ObjectId, ref: 'Parameter', default: null },
      },
    ],
    // Used for type 'cost': which of the woning's cost calculations to show
    // (see models/CostTracker.js), over the last `rangeHours`. Empty means
    // all of them, including ones added later.
    costTrackers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'CostTracker' }],
    // Used for type 'smart_charge_savings': which of the woning's smart-
    // charge plans to show (see models/SmartChargePlan.js), over the last
    // `rangeHours`. Empty means all of them, including ones added later —
    // same convention as `costTrackers`. `gridConsumptionParameter`
    // (optional) is a cumulative grid-import meter (kWh), for the "totaal
    // verbruik van het net" line next to the plans' own grid-charging share.
    // `batteryPowerParameter` (optional) is the battery's signed power sensor
    // (positive = discharging, same convention as flowRoles.battery): it
    // tells when the grid-charged energy was used again, so the "scenario
    // zonder net-laden" can put that energy back on the grid at those hours
    // (see routes/smartCharge.js withoutGridChargingByHour).
    smartChargePlans: [{ type: mongoose.Schema.Types.ObjectId, ref: 'SmartChargePlan' }],
    gridConsumptionParameter: { type: mongoose.Schema.Types.ObjectId, ref: 'Parameter' },
    batteryPowerParameter: { type: mongoose.Schema.Types.ObjectId, ref: 'Parameter' },
    // Automatically includes every parameter of the woning with this type
    // and unit — including ones added later — on top of the explicitly
    // chosen `parameters` (or, for 'energyflow', as top-level `devices`),
    // minus `excludedParameters`. E.g. type 'energy_consumption' + unit 'W'
    // keeps a "Verbruikers" chart complete as new consumers are added. See
    // routes/charts.js expandAutoInclude.
    autoInclude: {
      type: { type: String, default: null },
      unit: { type: String, default: '' },
    },
    excludedParameters: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Parameter' }],
    // Only meaningful for type 'energyflow': ECharts Sankey layout mode.
    circular: { type: Boolean, default: false },
    showOnDashboard: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('DashboardChart', dashboardChartSchema);
module.exports.CHART_TYPES = CHART_TYPES;
module.exports.RANGE_PERIODS = RANGE_PERIODS;
