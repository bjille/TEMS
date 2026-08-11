const mongoose = require('mongoose');

const PARAMETER_TYPES = [
  'battery_soc',
  'battery_power',
  'solar_power',
  'electricity_price',
  'grid_power',
  'switch_consumer',
  'switch_controllable',
  'select_mode',
  'ev_charger_power',
  'ev_status',
  'custom',
];

const parameterSchema = new mongoose.Schema(
  {
    woning: { type: mongoose.Schema.Types.ObjectId, ref: 'Woning', required: true },
    entityId: { type: String, required: true, trim: true }, // Home Assistant entity_id
    type: { type: String, enum: PARAMETER_TYPES, required: true },
    label: { type: String, required: true, trim: true },
    unit: { type: String, trim: true },
    icon: { type: String, trim: true },
    controllable: { type: Boolean, default: false },
    favorite: { type: Boolean, default: false },
    // Valid values for a select_mode parameter (mirrors HA's select entity
    // `options` attribute), used to render a dropdown instead of a toggle.
    options: [{ type: String, trim: true }],
    // Optional override for the HA service domain used to actuate this parameter.
    // Normally left empty: the domain is derived from entityId (e.g. "light.x" -> "light").
    controlDomain: { type: String, trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

parameterSchema.index({ woning: 1, entityId: 1 }, { unique: true });

module.exports = mongoose.model('Parameter', parameterSchema);
module.exports.PARAMETER_TYPES = PARAMETER_TYPES;
