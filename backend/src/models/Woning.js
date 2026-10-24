const mongoose = require('mongoose');

const woningSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    address: { type: String, trim: true },
    haBaseUrl: { type: String, required: true, trim: true },
    // AES-256-GCM encrypted long-lived HA access token, never exposed via API
    haTokenEncrypted: { type: String, required: true, select: false },
    status: { type: String, enum: ['active', 'paused', 'error'], default: 'active' },
    lastConnectedAt: { type: Date },
    lastError: { type: String },
    // A demo woning without Home Assistant behind it: its values come from
    // services/simulator.js (shown on the public landing page). Kept on
    // status 'paused' so no HA connection or engine ever touches it.
    simulated: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Woning', woningSchema);
