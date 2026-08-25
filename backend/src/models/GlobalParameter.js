const mongoose = require('mongoose');
const { PARAMETER_TYPES } = require('./Parameter');

// A template that gets stamped out as an identical Parameter (same entityId,
// type, label, ...) in every woning, for HA setups that use the same entity
// naming convention across installations. See globalParameterService for the
// fan-out/propagation logic.
const globalParameterSchema = new mongoose.Schema(
  {
    entityId: { type: String, required: true, trim: true, unique: true }, // Home Assistant entity_id
    type: { type: String, enum: PARAMETER_TYPES, required: true },
    label: { type: String, required: true, trim: true },
    unit: { type: String, trim: true },
    icon: { type: String, trim: true },
    category: { type: String, trim: true, default: '' },
    controllable: { type: Boolean, default: false },
    favorite: { type: Boolean, default: false },
    options: [{ type: String, trim: true }],
    optionLabels: { type: Map, of: String },
    controlDomain: { type: String, trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('GlobalParameter', globalParameterSchema);
module.exports.PARAMETER_TYPES = PARAMETER_TYPES;
