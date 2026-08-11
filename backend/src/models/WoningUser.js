const mongoose = require('mongoose');

const woningUserSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    woning: { type: mongoose.Schema.Types.ObjectId, ref: 'Woning', required: true },
    role: { type: String, enum: ['owner', 'member'], default: 'member' },
  },
  { timestamps: true }
);

woningUserSchema.index({ user: 1, woning: 1 }, { unique: true });

module.exports = mongoose.model('WoningUser', woningUserSchema);
