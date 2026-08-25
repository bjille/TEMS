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
  'number_controllable',
  'ev_charger_power',
  'ev_status',
  'energy_consumption',
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
    // Free-text grouping label (e.g. "Batterij", "Zonnepanelen") used to
    // organize parameters when entering them and when displaying the
    // dashboard. Empty/unset falls back to an "Overig" bucket in the UI.
    category: { type: String, trim: true, default: '' },
    controllable: { type: Boolean, default: false },
    favorite: { type: Boolean, default: false },
    // Valid values for a select_mode parameter (mirrors HA's select entity
    // `options` attribute), used to render a dropdown instead of a toggle.
    options: [{ type: String, trim: true }],
    // Optional display aliases for select_mode options, keyed by the raw HA
    // option value (e.g. "maximum_self_consumption" -> "Maximaal zelfverbruik").
    // The raw value is still what gets sent to HA; this only affects display.
    optionLabels: { type: Map, of: String },
    // Optional override for the HA service domain used to actuate this parameter.
    // Normally left empty: the domain is derived from entityId (e.g. "light.x" -> "light").
    controlDomain: { type: String, trim: true },
    // Set when this Parameter was stamped out from a GlobalParameter template
    // (see globalParameterService); lets edits to the template propagate here.
    globalParameter: { type: mongoose.Schema.Types.ObjectId, ref: 'GlobalParameter' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

parameterSchema.index({ woning: 1, entityId: 1 }, { unique: true });

module.exports = mongoose.model('Parameter', parameterSchema);
module.exports.PARAMETER_TYPES = PARAMETER_TYPES;
