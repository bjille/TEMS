const cron = require('node-cron');
const Parameter = require('../models/Parameter');
const PriceHistory = require('../models/PriceHistory');
const Woning = require('../models/Woning');
const { HaClient } = require('./haClient');
const { decrypt } = require('../utils/crypto');
const { normalizePricePoints, fetchPriceForecast } = require('./priceForecastService');

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
// How long HA's recorder keeps raw state history (its default purge_keep_days).
const HA_HISTORY_RETENTION_MS = 10 * DAY_MS;
// Hourly, a few minutes past, offset from the cost and smart-charge history
// engines' ticks. Tomorrow's prices are published once a day, so hourly is
// plenty to catch them (and any late correction) well before they're today's.
const TICK_CRON = '11 * * * *';

const PRICE_TYPES = ['electricity_price', 'gas_price'];

/** Upserts a parameter's hourly price points ({ timestamp, price }). */
async function storePricePoints(parameter, points, unit) {
  if (!points.length) return;
  await PriceHistory.bulkWrite(
    points.map((p) => ({
      updateOne: {
        filter: { parameter: parameter._id, timestamp: new Date(p.timestamp) },
        update: { $set: { woning: parameter.woning, price: p.price, unit: unit || parameter.unit || '' } },
        upsert: true,
      },
    })),
    { ordered: false }
  );
}

/** A parameter's stored price points in [from, to), oldest first. */
async function loadPriceHistory(parameterId, from, to) {
  const rows = await PriceHistory.find({ parameter: parameterId, timestamp: { $gte: from, $lt: to } })
    .sort({ timestamp: 1 })
    .lean();
  return rows.map((r) => ({ timestamp: r.timestamp.toISOString(), price: r.price, unit: r.unit }));
}

// A dynamic-prices entity's hourly curve lives entirely in its ATTRIBUTES,
// which HA's long-term statistics don't keep — only its raw state history
// does, until the recorder purges it after HA_HISTORY_RETENTION_MS. Any
// snapshot taken during `dayStart`'s calendar day carries that whole day's
// curve, so only one is needed — the latest, in case of a late correction.
async function haDayPriceCurve(client, priceParameter, dayStart) {
  const dayEnd = new Date(dayStart.getTime() + DAY_MS);
  let states;
  try {
    states = await client.fetchHistory(priceParameter.entityId, {
      start: dayStart.toISOString(),
      end: dayEnd.toISOString(),
      minimalResponse: false,
    });
  } catch (err) {
    console.error(`Price history fetch failed for ${priceParameter.entityId}:`, err.message);
    return [];
  }
  for (let i = states.length - 1; i >= 0; i--) {
    const points = normalizePricePoints(states[i].attributes).filter((p) => {
      const t = new Date(p.timestamp).getTime();
      return t >= dayStart.getTime() && t < dayEnd.getTime();
    });
    if (points.length > 0) return points;
  }
  return [];
}

/**
 * A past day's hourly prices: from the TEMS database when it has them, else
 * read back from HA's raw history (and stored, so it survives HA's purge).
 */
async function historicalDayPriceCurve(client, priceParameter, dayStart) {
  const dayEnd = new Date(dayStart.getTime() + DAY_MS);
  const stored = await loadPriceHistory(priceParameter._id, dayStart, dayEnd);
  // 23 for the day the clocks go forward.
  if (stored.length >= 23) return stored;
  const points = await haDayPriceCurve(client, priceParameter, dayStart);
  if (points.length > stored.length) {
    await storePricePoints(priceParameter, points).catch((err) =>
      console.error(`Storing price history failed for ${priceParameter._id}:`, err.message)
    );
    return points;
  }
  return stored;
}

/**
 * Keeps every price parameter's hourly curve in PriceHistory: each tick
 * stores the live curve (today + tomorrow), and the first run also reads
 * back whatever HA still has of the past HA_HISTORY_RETENTION_MS.
 */
class PriceHistoryEngine {
  constructor() {
    this.task = null;
    this.running = null;
  }

  start() {
    if (this.task) return;
    this.task = cron.schedule(TICK_CRON, () => {
      this.tick().catch((err) => console.error('Price history tick failed:', err));
    });
    this.tick({ backfill: true }).catch((err) => console.error('Price history initial tick failed:', err));
  }

  stop() {
    this.task?.stop();
    this.task = null;
  }

  tick({ backfill = false } = {}) {
    if (this.running) return this.running;
    this.running = (async () => {
      const parameters = await Parameter.find({ type: { $in: PRICE_TYPES } });
      for (const parameter of parameters) {
        await this.record(parameter, backfill).catch((err) =>
          console.error(`Price history failed for ${parameter.entityId}:`, err.message)
        );
      }
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async record(parameter, backfill) {
    const woning = await Woning.findById(parameter.woning).select('+haTokenEncrypted');
    if (!woning || woning.simulated) return;
    const forecast = await fetchPriceForecast(parameter, woning);
    // A plain "current price" sensor has no curve; its state is already
    // kept as Readings.
    if (forecast.points.length === 0) return;
    await storePricePoints(parameter, forecast.points, forecast.unit);
    if (!backfill) return;

    const client = new HaClient({ baseUrl: woning.haBaseUrl, token: decrypt(woning.haTokenEncrypted) });
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    for (let day = Math.ceil(HA_HISTORY_RETENTION_MS / DAY_MS); day >= 1; day--) {
      const dayStart = new Date(todayStart);
      dayStart.setDate(dayStart.getDate() - day);
      await historicalDayPriceCurve(client, parameter, dayStart);
    }
  }
}

const priceHistoryEngine = new PriceHistoryEngine();

module.exports = {
  priceHistoryEngine,
  storePricePoints,
  loadPriceHistory,
  historicalDayPriceCurve,
};
