const mongoose = require('mongoose');

const readingSchema = new mongoose.Schema({
  woning: { type: mongoose.Schema.Types.ObjectId, ref: 'Woning', required: true, index: true },
  parameter: { type: mongoose.Schema.Types.ObjectId, ref: 'Parameter', required: true, index: true },
  value: { type: mongoose.Schema.Types.Mixed, required: true },
  unit: { type: String },
  timestamp: { type: Date, required: true, default: Date.now, index: true },
});

readingSchema.index({ parameter: 1, timestamp: -1 });
readingSchema.index({ woning: 1, timestamp: -1 });

module.exports = mongoose.model('Reading', readingSchema);
