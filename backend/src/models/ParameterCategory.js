const mongoose = require('mongoose');

// A managed list of category names admins can assign to Parameters and
// GlobalParameters, so the category picker offers a fixed set instead of
// free text. See routes/parameterCategories.js for the cascade rename/clear
// behavior when a category is renamed or deleted.
const parameterCategorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, unique: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ParameterCategory', parameterCategorySchema);
