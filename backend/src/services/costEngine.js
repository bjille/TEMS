const cron = require('node-cron');
const CostTracker = require('../models/CostTracker');
const EnergyCost = require('../models/EnergyCost');
const Parameter = require('../models/Parameter');
const Reading = require('../models/Reading');
const Woning = require('../models/Woning');
const { HaClient } = require('./haClient');
const { decrypt } = require('../utils/crypto');
const { coerceValue } = require('./ingestService');

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
// HA's recorder purges its raw state history after this long by default,
// so asking it for anything older is pointless.
const HA_HISTORY_RETENTION_MS = 10 * DAY_MS;

// A few minutes past every quarter: HA compiles an hour's long-term
// statistics just after the hour ends, so the hour that just ended shows up
// at the first tick after it.
const TICK_CRON = '3,18,33,48 * * * *';
// Each tick recomputes this far back rather than only the newest hour, so
// data that arrives late (HA reconnecting, statistics compiled late) still
// ends up in the hour it belongs to.
const RECOMPUTE_OVERLAP_MS = 3 * HOUR_MS;

function floorToHourMs(ms) {
  const d = new Date(ms);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

// Price sensors report € per MWh or € per kWh depending on the integration
// and its settings; costs are worked out per kWh.
function priceScale(unit) {
  return /mwh/i.test(unit || '') ? 1 / 1000 : 1;
}

// Lazily creates (once) an HA client for a woning.
function makeHaContext(woningId) {
  let promise = null;
  return {
    client() {
      if (!promise) {
        promise = Woning.findById(woningId)
          .select('+haTokenEncrypted')
          .then((w) => (w ? new HaClient({ baseUrl: w.haBaseUrl, token: decrypt(w.haTokenEncrypted) }) : null))
          .catch(() => null);
      }
      return promise;
    },
  };
}

/**
 * HA's hourly long-term statistics for the meter and the price sensor over
 * [fromMs, toMs): per hour start (ms), the meter's consumption that hour
 * (the rise of its `sum`, which HA already corrects for daily resets) and
 * the price sensor's `mean` that hour (or its `state`, see below). These go back as far as HA has
 * recorded the sensors, independent of whether TEMS was running. Either map
 * is empty when the sensor has no statistics (no state_class) or HA can't be
 * reached — the caller then falls back to readings.
 */
async function fetchHourlyStatistics(meter, price, fromMs, toMs, haContext) {
  const empty = { usage: new Map(), prices: new Map() };
  const client = await haContext.client();
  if (!client) return empty;
  let result;
  try {
    result = await client.fetchStatistics([meter.entityId, price.entityId], {
      // One extra hour before, for the `sum` the first hour starts from.
      start: new Date(fromMs - HOUR_MS).toISOString(),
      end: new Date(toMs).toISOString(),
      types: ['sum', 'mean', 'state'],
    });
  } catch (err) {
    console.error(`Statistics fetch failed for ${meter.entityId}:`, err.message);
    return empty;
  }

  const startMs = (row) => (typeof row.start === 'number' ? row.start : new Date(row.start).getTime());

  const usage = new Map();
  let previousSum = null;
  for (const row of result[meter.entityId] || []) {
    if (typeof row.sum !== 'number') continue;
    const t = startMs(row);
    if (previousSum !== null && t >= fromMs) usage.set(t, Math.max(0, row.sum - previousSum));
    previousSum = row.sum;
  }

  const prices = new Map();
  for (const row of result[price.entityId] || []) {
    // A 'measurement' sensor gets an hourly mean; a price sensor declared
    // as state_class 'total' (e.g. Frank Energie's gas prices) only gets
    // its state at the end of the hour.
    const value = typeof row.mean === 'number' ? row.mean : row.state;
    if (typeof value === 'number') prices.set(startMs(row), value);
  }
  return { usage, prices };
}

/**
 * Fallback for sensors without long-term statistics: every numeric reading
 * of `parameter` in (from, to], preceded by the last one at or before
 * `from`, from the locally ingested Readings — or, when TEMS has nothing at
 * or before `from` and the window is recent enough, from HA's raw history.
 */
async function loadSeries(parameter, from, to, haContext) {
  const before = await Reading.findOne({ parameter: parameter._id, timestamp: { $lte: from } })
    .sort({ timestamp: -1 })
    .select('value timestamp')
    .lean();
  const within = await Reading.find({ parameter: parameter._id, timestamp: { $gt: from, $lte: to } })
    .sort({ timestamp: 1 })
    .select('value timestamp')
    .lean();

  const toPoints = (rows) =>
    rows
      .filter((r) => typeof r.value === 'number')
      .map((r) => ({ t: new Date(r.timestamp).getTime(), v: r.value }));

  if (before || Date.now() - from.getTime() > HA_HISTORY_RETENTION_MS) return toPoints(before ? [before, ...within] : within);

  const fromHa = await loadSeriesFromHa(parameter, from, to, haContext).catch(() => null);
  return fromHa && fromHa.length > 0 ? fromHa : toPoints(within);
}

async function loadSeriesFromHa(parameter, from, to, haContext) {
  const client = await haContext.client();
  if (!client) return null;
  const states = await client.fetchHistory(parameter.entityId, {
    start: from.toISOString(),
    end: to.toISOString(),
  });
  return states
    .map((s) => {
      const value = coerceValue(s.state);
      return {
        t: new Date(s.last_changed || s.last_updated).getTime(),
        v: parameter.invert && typeof value === 'number' ? -value : value,
      };
    })
    .filter((p) => typeof p.v === 'number' && !Number.isNaN(p.t))
    .sort((a, b) => a.t - b.t);
}

// Value of a (time-sorted) series at `tMs`: the last point at or before it.
// Answers in order for ascending tMs via a moving cursor.
function makeCursor(points) {
  let i = -1;
  return function valueAt(tMs) {
    while (i + 1 < points.length && points[i + 1].t <= tMs) i++;
    return i >= 0 ? points[i].v : null;
  };
}

// How much a cumulative counter rose in each slot of `slotMs` starting at
// `slotStarts`. The first slot it has any data in starts from its first
// value rather than from "unknown". A drop to (near) zero is a reset — a
// daily counter at midnight, or a new meter — so the new value itself is
// what was used since; any smaller drop is sensor noise and counts as
// nothing.
function counterDeltas(points, slotStarts, slotMs = HOUR_MS) {
  const deltas = slotStarts.map(() => 0);
  if (points.length === 0) return deltas;
  const valueAt = makeCursor(points);
  let previous = valueAt(slotStarts[0]);
  for (let q = 0; q < slotStarts.length; q++) {
    const end = valueAt(slotStarts[q] + slotMs);
    if (previous === null && end !== null) previous = points.find((p) => p.t >= slotStarts[q])?.v ?? end;
    if (previous !== null && end !== null) {
      if (end >= previous) deltas[q] = end - previous;
      else if (end <= previous * 0.1) deltas[q] = Math.max(end, 0);
    }
    if (end !== null) previous = end;
  }
  return deltas;
}

// Computes and stores every complete hour in [fromMs, toMs) of a single
// tracker: usage and price from HA's hourly statistics where available,
// otherwise from readings, in chunks of one day.
async function computeRange(tracker, fromMs, toMs) {
  const [meter, priceParam] = await Promise.all([
    Parameter.findById(tracker.meterParameter).lean(),
    Parameter.findById(tracker.priceParameter).lean(),
  ]);
  if (!meter || !priceParam) {
    await CostTracker.updateOne({ _id: tracker._id }, { lastError: 'De gekoppelde sensor bestaat niet meer' });
    return;
  }
  const haContext = makeHaContext(tracker.woning);
  const factor = tracker.meterConversionFactor ?? 1;
  const scale = priceScale(priceParam.unit);
  const stats = await fetchHourlyStatistics(meter, priceParam, fromMs, toMs, haContext);

  let missingPriceHours = 0;
  for (let chunkStart = fromMs; chunkStart < toMs; ) {
    const chunkEndDate = new Date(chunkStart);
    chunkEndDate.setHours(24, 0, 0, 0); // next local midnight (DST-safe)
    const chunkEnd = Math.min(chunkEndDate.getTime(), toMs);
    const hourStarts = [];
    for (let t = chunkStart; t < chunkEnd; t += HOUR_MS) hourStarts.push(t);

    const from = new Date(chunkStart);
    const to = new Date(chunkEnd);
    // Only fall back to readings for whatever this day has no statistics for.
    const needUsageFallback = !hourStarts.some((t) => stats.usage.has(t));
    const needPriceFallback = hourStarts.some((t) => !stats.prices.has(t));
    const [meterSeries, priceSeries] = await Promise.all([
      needUsageFallback ? loadSeries(meter, from, to, haContext) : null,
      needPriceFallback ? loadSeries(priceParam, from, to, haContext) : null,
    ]);
    const fallbackUsage = meterSeries ? counterDeltas(meterSeries, hourStarts) : null;
    // The fallback price is the sensor's value halfway through the hour, so
    // a sensor that switches a few seconds after the hour still counts for
    // the right hour.
    const priceAt = priceSeries ? makeCursor(priceSeries) : () => null;

    const ops = [];
    hourStarts.forEach((hs, i) => {
      const quantity = (fallbackUsage ? fallbackUsage[i] : stats.usage.get(hs) ?? 0) * factor;
      const rawPrice = stats.prices.has(hs) ? stats.prices.get(hs) : priceAt(hs + HOUR_MS / 2);
      if (rawPrice === null || rawPrice === undefined) {
        if (quantity > 0) missingPriceHours++;
        return;
      }
      const price = rawPrice * scale;
      ops.push({
        updateOne: {
          filter: { tracker: tracker._id, start: new Date(hs) },
          update: { $set: { woning: tracker.woning, quantity, price, cost: quantity * price } },
          upsert: true,
        },
      });
    });
    if (ops.length > 0) await EnergyCost.bulkWrite(ops, { ordered: false });
    await CostTracker.updateOne({ _id: tracker._id }, { computedUntil: to });
    chunkStart = chunkEnd;
  }

  const lastError =
    missingPriceHours > 0
      ? `Voor ${missingPriceHours} uur met verbruik was geen prijs bekend — die zijn niet meegerekend`
      : null;
  await CostTracker.updateOne({ _id: tracker._id }, { lastError });
}

class CostEngine {
  constructor() {
    this.task = null;
    this.running = new Map(); // trackerId -> Promise
  }

  start() {
    if (this.task) return;
    this.task = cron.schedule(TICK_CRON, () => {
      this.tick().catch((err) => console.error('Cost engine tick failed:', err));
    });
    // Drop indexes left over from an earlier shape of EnergyCost (keyed per
    // woning + medium) before computing anything: their unique constraint
    // would otherwise make two calculations of the same woning collide on
    // every hour. Then catch up right away on whatever was missed while the
    // backend was down.
    EnergyCost.syncIndexes()
      .catch((err) => console.error('Failed to sync EnergyCost indexes:', err.message))
      .then(() => this.tick())
      .catch((err) => console.error('Cost engine initial tick failed:', err));
  }

  stop() {
    this.task?.stop();
    this.task = null;
  }

  async tick() {
    // A simulated woning has no HA to read from; its costs are simulated
    // on the fly (see routes/public.js).
    const simulated = await Woning.find({ simulated: true }).distinct('_id');
    const trackers = await CostTracker.find({ validFrom: { $lte: new Date() }, woning: { $nin: simulated } });
    for (const tracker of trackers) {
      await this.compute(tracker).catch((err) => {
        console.error(`Cost computation failed for tracker ${tracker._id}:`, err.message);
        return CostTracker.updateOne({ _id: tracker._id }, { lastError: err.message });
      });
    }
  }

  /**
   * Brings a tracker's stored hours up to date: from where it left off
   * (minus an overlap for late data) — or from validFrom for a new or reset
   * tracker — up to the last complete hour. Only one computation per tracker
   * runs at a time; a second call waits for the running one.
   */
  compute(tracker) {
    const id = tracker._id.toString();
    if (this.running.has(id)) return this.running.get(id);
    const promise = (async () => {
      const fresh = await CostTracker.findById(id);
      if (!fresh) return;
      const endMs = floorToHourMs(Date.now());
      const validFromMs = floorToHourMs(fresh.validFrom.getTime());
      const fromMs = fresh.computedUntil
        ? Math.max(validFromMs, fresh.computedUntil.getTime() - RECOMPUTE_OVERLAP_MS)
        : validFromMs;
      if (fromMs < endMs) await computeRange(fresh, fromMs, endMs);
    })().finally(() => this.running.delete(id));
    this.running.set(id, promise);
    return promise;
  }

  /** Throws away a tracker's computed hours and recomputes them all. */
  async recompute(trackerId) {
    await this.running.get(trackerId.toString());
    await EnergyCost.deleteMany({ tracker: trackerId });
    await CostTracker.updateOne({ _id: trackerId }, { $unset: { computedUntil: 1 } });
    const tracker = await CostTracker.findById(trackerId);
    if (tracker) await this.compute(tracker);
  }
}

const costEngine = new CostEngine();

module.exports = { costEngine, counterDeltas, priceScale, fetchHourlyStatistics, makeHaContext, loadSeries };
