const GlobalParameter = require('../models/GlobalParameter');
const Parameter = require('../models/Parameter');
const Woning = require('../models/Woning');
const { haConnectionManager } = require('./haConnectionManager');

function toParameterFields(gp) {
  return {
    type: gp.type,
    label: gp.label,
    unit: gp.unit,
    icon: gp.icon,
    category: gp.category,
    controllable: gp.controllable,
    favorite: gp.favorite,
    options: gp.options,
    optionLabels: gp.optionLabels,
    controlDomain: gp.controlDomain,
  };
}

async function upsertForWoning(gp, woningId) {
  // Matches on the same {woning, entityId} unique index a manually-created
  // Parameter would use, so a pre-existing manual entry for this entity is
  // adopted (and tagged as globally managed) instead of erroring out.
  await Parameter.findOneAndUpdate(
    { woning: woningId, entityId: gp.entityId },
    {
      ...toParameterFields(gp),
      entityId: gp.entityId,
      woning: woningId,
      globalParameter: gp._id,
      createdBy: gp.createdBy,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  await haConnectionManager.resubscribe(woningId);
}

/** Creates/updates this global parameter's Parameter copy in every woning. */
async function applyToAllWoningen(gp) {
  const woningen = await Woning.find({}, '_id');
  await Promise.all(woningen.map((w) => upsertForWoning(gp, w._id)));
}

/** Seeds a newly created woning with every existing global parameter. */
async function applyAllToWoning(woningId) {
  const globalParameters = await GlobalParameter.find();
  await Promise.all(globalParameters.map((gp) => upsertForWoning(gp, woningId)));
}

/** Removes every Parameter copy created from this global parameter. */
async function removeFromAllWoningen(gp) {
  const linked = await Parameter.find({ globalParameter: gp._id }, 'woning');
  const woningIds = [...new Set(linked.map((p) => p.woning.toString()))];
  await Parameter.deleteMany({ globalParameter: gp._id });
  await Promise.all(woningIds.map((id) => haConnectionManager.resubscribe(id)));
}

module.exports = { applyToAllWoningen, applyAllToWoning, removeFromAllWoningen };
