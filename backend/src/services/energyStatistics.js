const HOUR_MS = 3600 * 1000;

const KWH_PER_UNIT = { wh: 0.001, kwh: 1, mwh: 1000 };

/**
 * Energy per hour in kWh over [start, end) from the HA long-term statistics
 * of a parameter's `energyEntityId` (a cumulative kWh counter): each row's
 * `change` is how much the counter rose that hour, which HA already corrects
 * for resets (a daily counter going back to 0, a plug replaced). Returns
 * [{ t, kwh }] sorted by hour, or null when the sensor has no statistics.
 */
async function hourlyEnergyKwh(client, parameter, start, end) {
  const entityId = parameter.energyEntityId;
  if (!entityId) return null;
  const [result, state] = await Promise.all([
    client.fetchStatistics([entityId], {
      start: start.toISOString(),
      end: end.toISOString(),
      period: 'hour',
      types: ['change'],
    }),
    client.fetchState(entityId).catch(() => null),
  ]);
  const unit = String(state?.attributes?.unit_of_measurement || 'kWh').toLowerCase();
  const factor = (KWH_PER_UNIT[unit] ?? 1) * (parameter.invert ? -1 : 1);
  const rows = (result[entityId] || []).filter((r) => typeof r.change === 'number');
  if (rows.length === 0) return null;
  return rows
    .map((r) => ({ t: typeof r.start === 'number' ? r.start : new Date(r.start).getTime(), kwh: r.change * factor }))
    .sort((a, b) => a.t - b.t);
}

module.exports = { hourlyEnergyKwh, HOUR_MS };
