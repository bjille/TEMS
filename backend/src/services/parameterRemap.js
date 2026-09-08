const Parameter = require('../models/Parameter');

/**
 * Builds a source-parameter-id -> target-parameter-id map for copying
 * automations/charts across woningen. Parameters are matched by identity —
 * entityId plus the `invert` flag, since that's what actually distinguishes
 * two mappings of the same HA entity (e.g. plain vs. inverted) — rather than
 * by _id, which is naturally different per woning. Any source parameter with
 * no match in the target woning is reported back in `missing` (by label) so
 * the caller can refuse the copy instead of silently dropping a reference.
 */
async function buildParameterRemap(sourceParameterIds, targetWoningId) {
  const uniqueIds = [...new Set(sourceParameterIds.filter(Boolean).map((id) => id.toString()))];
  const sourceParams = await Parameter.find({ _id: { $in: uniqueIds } });
  const targetParams = await Parameter.find({ woning: targetWoningId });

  const targetByKey = new Map();
  for (const p of targetParams) {
    const key = `${p.entityId}|${p.invert ? 1 : 0}`;
    if (!targetByKey.has(key)) targetByKey.set(key, p._id);
  }

  const map = new Map();
  const missing = [];
  for (const p of sourceParams) {
    const key = `${p.entityId}|${p.invert ? 1 : 0}`;
    const targetId = targetByKey.get(key);
    if (targetId) map.set(p._id.toString(), targetId);
    else missing.push(p.label || p.entityId);
  }
  return { map, missing };
}

module.exports = { buildParameterRemap };
