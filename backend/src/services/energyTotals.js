const { coerceValue } = require('./ingestService');

const HOUR_MS = 3600 * 1000;
// HA keeps raw history and its 5-minute statistics for ~10 days; older
// periods only have hourly statistics.
const SHORT_TERM_RETENTION_MS = 9.5 * 24 * HOUR_MS;
const W_PER_UNIT = { w: 1, kw: 1000, mw: 1e6 };
const KWH_PER_UNIT = { wh: 0.001, kwh: 1, mwh: 1000 };

const wattsFactor = (parameter) => W_PER_UNIT[String(parameter.unit || 'W').trim().toLowerCase()] ?? 1;

// A signed power sensor's raw history integrated over [start, end), each
// value holding until the next: { positive, negative } kWh, or null.
async function historyEnergyKwh(client, parameter, start, end) {
  const sign = (parameter.invert ? -1 : 1) * wattsFactor(parameter);
  const states = await client.fetchHistory(parameter.entityId, {
    start: start.toISOString(),
    end: end.toISOString(),
  });
  const points = states
    .map((s) => ({ v: coerceValue(s.state), t: new Date(s.last_changed || s.last_updated).getTime() }))
    .filter((p) => typeof p.v === 'number')
    .sort((a, b) => a.t - b.t);
  if (points.length === 0) return null;
  const endMs = Math.min(end.getTime(), Date.now());
  const totals = { positive: 0, negative: 0 };
  points.forEach((p, i) => {
    const from = Math.max(p.t, start.getTime());
    const to = i + 1 < points.length ? points[i + 1].t : endMs;
    if (to <= from) return;
    const kwh = (p.v * sign * (to - from)) / HOUR_MS / 1000;
    if (kwh > 0) totals.positive += kwh;
    else totals.negative -= kwh;
  });
  return totals;
}

/**
 * Energy in kWh that each of `parameters` (signed power sensors) moved over
 * [start, end), the positive and negative direction apart — e.g. grid
 * import and export, battery discharging and charging: Map<id, { positive,
 * negative }>. One statistics request for all of them (5-minute statistics
 * while HA still has them, so an hour with both directions counts both;
 * hourly ones before that), raw history for a sensor without statistics.
 */
async function powerEnergyKwh(client, parameters, start, end) {
  const out = new Map();
  if (parameters.length === 0) return out;
  const recent = Date.now() - start.getTime() < SHORT_TERM_RETENTION_MS;
  const period = recent ? '5minute' : 'hour';
  const hours = recent ? 5 / 60 : 1;
  const result = await client
    .fetchStatistics([...new Set(parameters.map((p) => p.entityId))], {
      start: start.toISOString(),
      end: end.toISOString(),
      period,
      types: ['mean'],
    })
    .catch(() => ({}));

  await Promise.all(
    parameters.map(async (parameter) => {
      const rows = (result[parameter.entityId] || []).filter((r) => typeof r.mean === 'number');
      if (rows.length > 0) {
        const sign = (parameter.invert ? -1 : 1) * wattsFactor(parameter);
        const totals = { positive: 0, negative: 0 };
        for (const r of rows) {
          const kwh = (r.mean * sign * hours) / 1000;
          if (kwh > 0) totals.positive += kwh;
          else totals.negative -= kwh;
        }
        out.set(String(parameter._id), totals);
      } else if (recent) {
        const totals = await historyEnergyKwh(client, parameter, start, end).catch(() => null);
        if (totals) out.set(String(parameter._id), totals);
      }
    })
  );
  return out;
}

/**
 * kWh over [start, end) from the long-term energy sensors (see
 * Parameter.energyEntityId) of `parameters`, in one statistics request:
 * Map<id, kWh>, leaving out those without statistics.
 */
async function counterEnergyKwh(client, parameters, start, end) {
  const out = new Map();
  if (parameters.length === 0) return out;
  const ids = [...new Set(parameters.map((p) => p.energyEntityId))];
  const [result, states] = await Promise.all([
    client
      .fetchStatistics(ids, { start: start.toISOString(), end: end.toISOString(), period: 'hour', types: ['change'] })
      .catch(() => ({})),
    Promise.all(ids.map((id) => client.fetchState(id).catch(() => null))),
  ]);
  const unitOf = new Map(ids.map((id, i) => [id, String(states[i]?.attributes?.unit_of_measurement || 'kWh').toLowerCase()]));
  for (const parameter of parameters) {
    const rows = (result[parameter.energyEntityId] || []).filter((r) => typeof r.change === 'number');
    if (rows.length === 0) continue;
    const factor = KWH_PER_UNIT[unitOf.get(parameter.energyEntityId)] ?? 1;
    out.set(String(parameter._id), Math.abs(rows.reduce((sum, r) => sum + r.change, 0) * factor));
  }
  return out;
}

/**
 * The energy behind an energy flow chart over [start, end), in kWh:
 * { pv, gridImport, gridExport, discharge, charge, thuis, devices: { id: kWh } }
 * with the live chart's sign conventions (grid > 0 = import, battery > 0 =
 * discharging). Consumers (thuis, devices) count from their long-term
 * energy sensor when they have one. A role without data is left out.
 */
async function flowEnergy(client, chart, parametersById, start, end) {
  const byRef = (ref) => (ref ? parametersById.get(String(ref._id || ref)) : null);
  const roles = Object.fromEntries(['pv', 'grid', 'battery', 'thuis'].map((k) => [k, byRef(chart.flowRoles?.[k])]));
  const devices = (chart.devices || []).map((d) => byRef(d.parameter)).filter(Boolean);
  const consumers = [roles.thuis, ...devices].filter(Boolean);

  const counters = await counterEnergyKwh(
    client,
    consumers.filter((p) => p.energyEntityId),
    start,
    end
  );
  const viaPower = [roles.pv, roles.grid, roles.battery, ...consumers.filter((p) => !counters.has(String(p._id)))].filter(
    Boolean
  );
  const power = await powerEnergyKwh(client, viaPower, start, end);

  const round = (v) => Math.round(v * 1000) / 1000;
  const consumed = (p) => {
    const id = String(p._id);
    if (counters.has(id)) return counters.get(id);
    return power.get(id)?.positive;
  };
  const totals = {};
  const set = (key, value) => {
    if (typeof value === 'number') totals[key] = round(value);
  };
  if (roles.pv) set('pv', power.get(String(roles.pv._id))?.positive);
  if (roles.grid) {
    set('gridImport', power.get(String(roles.grid._id))?.positive);
    set('gridExport', power.get(String(roles.grid._id))?.negative);
  }
  if (roles.battery) {
    set('discharge', power.get(String(roles.battery._id))?.positive);
    set('charge', power.get(String(roles.battery._id))?.negative);
  }
  if (roles.thuis) set('thuis', consumed(roles.thuis));

  const deviceTotals = {};
  for (const p of devices) {
    const kwh = consumed(p);
    if (typeof kwh === 'number') deviceTotals[String(p._id)] = round(kwh);
  }
  return { ...totals, devices: deviceTotals };
}

module.exports = { flowEnergy, powerEnergyKwh, counterEnergyKwh };
