const mongoose = require('mongoose');

const CHART_TYPES = ['line', 'area', 'bar', 'energyflow'];

// A user-defined chart combining one or more Parameters of a woning into a
// single, pre-configured view (e.g. "Energiestromen": PV + batterij + net).
// Optionally pinned to the dashboard via `showOnDashboard`.
const dashboardChartSchema = new mongoose.Schema(
  {
    woning: { type: mongoose.Schema.Types.ObjectId, ref: 'Woning', required: true },
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: CHART_TYPES, default: 'line' },
    rangeHours: { type: Number, default: 24, min: 1 },
    // Used for type 'line' | 'area' | 'bar': the series to plot over time.
    parameters: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Parameter' }],
    // Used for type 'energyflow': signed power sensors (W) feeding a live
    // Sankey diagram — positive grid/battery means import/discharge, negative
    // means export/charge. "Thuis" (home consumption) is derived, not
    // configured, since it's whatever balances the other flows.
    flowRoles: {
      pv: { type: mongoose.Schema.Types.ObjectId, ref: 'Parameter' },
      battery: { type: mongoose.Schema.Types.ObjectId, ref: 'Parameter' },
      grid: { type: mongoose.Schema.Types.ObjectId, ref: 'Parameter' },
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
    // Only meaningful for type 'energyflow': ECharts Sankey layout mode.
    circular: { type: Boolean, default: false },
    showOnDashboard: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('DashboardChart', dashboardChartSchema);
module.exports.CHART_TYPES = CHART_TYPES;
