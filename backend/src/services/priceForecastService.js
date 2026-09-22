const { HaClient } = require('./haClient');
const { decrypt } = require('../utils/crypto');

// Normalizes an entso-e-style "dynamic prices" entity's forecast attributes
// into a flat, sorted, de-duplicated list of hourly points. Prefers the
// `prices_today` + `prices_tomorrow` split (today's full curve, extended
// with tomorrow's once ENTSO-E publishes it, usually mid-afternoon) over
// the raw `prices` attribute, which on at least the integration this was
// built against is a rolling window that includes yesterday's — already
// irrelevant — hours instead of only what's ahead. Falls back to `prices`
// when the split isn't present, for other integrations that only expose
// that one attribute.
function normalizePricePoints(attributes) {
  const today = Array.isArray(attributes?.prices_today) ? attributes.prices_today : [];
  const tomorrow = Array.isArray(attributes?.prices_tomorrow) ? attributes.prices_tomorrow : [];
  const combined = [...today, ...tomorrow];
  const source = combined.length > 0 ? combined : Array.isArray(attributes?.prices) ? attributes.prices : [];

  const byTimestampMs = new Map();
  for (const entry of source) {
    // Different price integrations key the hour differently: entso-e uses
    // `time`, Frank Energie uses `from`/`till` (a proper ISO string, unlike
    // entso-e's space-separated one below), Nordpool-style ones use `start`.
    const rawTime = entry?.time ?? entry?.timestamp ?? entry?.datetime ?? entry?.from ?? entry?.start;
    const price = entry?.price ?? entry?.value;
    if (!rawTime || typeof price !== 'number') continue;
    // HA's entso-e integration formats `time` as "2026-09-22 00:00:00+02:00"
    // (a space instead of the "T" ISO needs to parse reliably everywhere).
    const date = new Date(String(rawTime).replace(' ', 'T'));
    if (Number.isNaN(date.getTime())) continue;
    byTimestampMs.set(date.getTime(), price);
  }

  return [...byTimestampMs.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ms, price]) => ({ timestamp: new Date(ms).toISOString(), price }));
}

// Fetches and normalizes the live hourly price curve for a parameter backed
// by a dynamic-prices HA entity. Shared by the price-forecast route (a
// user looking at a chart) and the smart-charge engine (deciding which
// hours to charge in) — both need the same forward-looking data, fetched
// fresh from HA rather than from stored Readings (see normalizePricePoints).
async function fetchPriceForecast(parameter, woning) {
  const client = new HaClient({
    baseUrl: woning.haBaseUrl,
    token: decrypt(woning.haTokenEncrypted),
  });
  const state = await client.fetchState(parameter.entityId);
  return {
    unit: state.attributes?.unit_of_measurement || parameter.unit || '',
    points: normalizePricePoints(state.attributes),
  };
}

module.exports = { normalizePricePoints, fetchPriceForecast };
