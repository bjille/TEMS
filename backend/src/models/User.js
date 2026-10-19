const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    role: { type: String, enum: ['superadmin', 'user'], default: 'user' },
    active: { type: Boolean, default: true },
    // Woning selected by default after login, for a user who can see more
    // than one (and for a superadmin, instead of the "Alle installaties"
    // overview). Ignored when the user no longer has access to it.
    defaultWoning: { type: mongoose.Schema.Types.ObjectId, ref: 'Woning', default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('User', userSchema);
