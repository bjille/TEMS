require('dotenv').config();
const { connectDb } = require('../config/db');
const { encrypt } = require('./crypto');
const Woning = require('../models/Woning');
const Parameter = require('../models/Parameter');
const DashboardChart = require('../models/DashboardChart');
const CostTracker = require('../models/CostTracker');
const EnergyCost = require('../models/EnergyCost');

// (Re)creates the simulated demo woning shown on the public landing page
// (see routes/public.js) as a copy of a real woning: the same parameters —
// under a `sim.` entity_id, so they never match a real HA entity — and the
// same cost calculations and the same dashboard charts that the demo can
// show. Its values come from
// services/simulator.js; nothing of the source woning's data is copied.
//
//   npm run simulation -- "Huis Tim" "Simulatiewoning"
const DEMO_CHART_TYPES = ['energyflow', 'line', 'area', 'price_forecast', 'cost'];
const PARAMETER_FIELDS = [
  'type',
  'label',
  'unit',
  'icon',
  'category',
  'controllable',
  'favorite',
  'badge',
  'invert',
  'options',
  'optionLabels',
];

async function main() {
  const [sourceName = 'Huis Tim', name = 'Simulatiewoning'] = process.argv.slice(2);
  await connectDb();

  const source = await Woning.findOne({ name: sourceName });
  if (!source) throw new Error(`Woning "${sourceName}" niet gevonden`);

  let woning = await Woning.findOne({ simulated: true });
  if (woning) {
    await Parameter.deleteMany({ woning: woning._id });
    await DashboardChart.deleteMany({ woning: woning._id });
    await CostTracker.deleteMany({ woning: woning._id });
    await EnergyCost.deleteMany({ woning: woning._id });
    woning.name = name;
    await woning.save();
  } else {
    woning = await Woning.create({
      name,
      address: 'Simulatie',
      haBaseUrl: 'http://simulatie.invalid',
      haTokenEncrypted: encrypt('simulatie'),
      status: 'paused',
      simulated: true,
    });
  }

  const idMap = new Map();
  const sourceParameters = await Parameter.find({ woning: source._id }).sort({ createdAt: 1 });
  for (const p of sourceParameters) {
    const fields = Object.fromEntries(PARAMETER_FIELDS.map((f) => [f, p[f]]));
    const copy = await Parameter.create({ ...fields, woning: woning._id, entityId: `sim.${p.entityId}` });
    idMap.set(String(p._id), copy._id);
  }
  const mapId = (id) => (id ? idMap.get(String(id)) || null : null);

  const trackerMap = new Map();
  const sourceTrackers = await CostTracker.find({ woning: source._id }).sort({ createdAt: 1 });
  for (const t of sourceTrackers) {
    if (!mapId(t.meterParameter) || !mapId(t.priceParameter)) continue;
    const copy = await CostTracker.create({
      woning: woning._id,
      name: t.name,
      meterParameter: mapId(t.meterParameter),
      priceParameter: mapId(t.priceParameter),
      meterConversionFactor: t.meterConversionFactor,
      validFrom: t.validFrom,
    });
    trackerMap.set(String(t._id), copy._id);
  }

  const charts = await DashboardChart.find({
    woning: source._id,
    showOnDashboard: true,
    type: { $in: DEMO_CHART_TYPES },
  }).sort({ createdAt: 1 });
  // The simulated house runs mostly on its battery, so an energy flow chart
  // missing a role (e.g. no battery, or one pointing at a deleted parameter)
  // gets it from another flow chart of the source woning — otherwise it
  // would show next to nothing.
  const mappedRoles = (c) =>
    Object.fromEntries(Object.entries(c.flowRoles?.toObject?.() || c.flowRoles || {}).map(([k, v]) => [k, mapId(v)]));
  const knownRoles = {};
  for (const c of charts.filter((x) => x.type === 'energyflow')) {
    for (const [role, id] of Object.entries(mappedRoles(c))) if (id && !knownRoles[role]) knownRoles[role] = id;
  }
  const flowRolesOf = (c) => {
    const roles = mappedRoles(c);
    if (c.type === 'energyflow') {
      for (const [role, id] of Object.entries(knownRoles)) if (!roles[role]) roles[role] = id;
    }
    return roles;
  };

  for (const c of charts) {
    await DashboardChart.create({
      woning: woning._id,
      name: c.name,
      type: c.type,
      rangeHours: c.rangeHours,
      rangePeriod: c.rangePeriod,
      showOnDashboard: true,
      circular: c.circular,
      parameters: (c.parameters || []).map(mapId).filter(Boolean),
      flowRoles: flowRolesOf(c),
      devices: (c.devices || [])
        .map((d) => ({ parameter: mapId(d.parameter), parent: mapId(d.parent) }))
        .filter((d) => d.parameter),
      autoInclude: c.autoInclude,
      excludedParameters: (c.excludedParameters || []).map(mapId).filter(Boolean),
      costTrackers: (c.costTrackers || []).map((id) => trackerMap.get(String(id))).filter(Boolean),
    });
  }

  console.log(`Simulatiewoning "${name}" (${woning._id}): ${idMap.size} parameters, ${trackerMap.size} kostenberekeningen, ${charts.length} grafieken.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
