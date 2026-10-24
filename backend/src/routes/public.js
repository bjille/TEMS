const express = require('express');
const rateLimit = require('express-rate-limit');
const Woning = require('../models/Woning');
const Parameter = require('../models/Parameter');
const DashboardChart = require('../models/DashboardChart');
const PriceHistory = require('../models/PriceHistory');
const CostTracker = require('../models/CostTracker');
const { POPULATE_PATHS, expandAutoInclude } = require('./charts');
const { priceScale } = require('../services/costEngine');
const { simulatedValue, simulatedMeterRise, deviceLabelsOf, localMidnight } = require('../services/simulator');

const router = express.Router();

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
// The dashboard of the simulated woning changes per minute, so a short
// cache keeps a busy landing page from recomputing it for every visitor.
const CACHE_MS = 20 * 1000;
const CURVE_STEP_MS = 5 * 60 * 1000;
const DEMO_CHART_TYPES = ['energyflow', 'line', 'area', 'price_forecast', 'cost'];
// A simulated parameter keeps the entity_id of the parameter it was copied
// from behind this prefix (see utils/createSimulationWoning.js).
const SIM_PREFIX = 'sim.';

router.use(
  rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false })
);

// Real day-ahead prices — public market data — for the simulated woning's
// price parameters, from the PriceHistory of the real parameter each was
// copied from: { parameterId: Map<hourStartMs, price> }.
async function realPrices(parameters, from, to) {
  const byParameter = new Map();
  for (const p of parameters.filter((x) => x.type === 'electricity_price' && x.entityId.startsWith(SIM_PREFIX))) {
    const source = await Parameter.findOne({
      entityId: p.entityId.slice(SIM_PREFIX.length),
      woning: { $ne: p.woning },
    }).lean();
    if (!source) continue;
    const rows = await PriceHistory.find({ parameter: source._id, timestamp: { $gte: from, $lt: to } }).lean();
    if (rows.length > 0) byParameter.set(String(p._id), new Map(rows.map((r) => [r.timestamp.getTime(), r.price])));
  }
  return byParameter;
}

// The unit a tracker's quantities are in: the price's per-unit (see
// routes/costs.js pricedUnit).
function pricedUnit(meter, price) {
  const perUnit = (price?.unit || '').split('/')[1]?.trim();
  if (perUnit) return /^mwh$/i.test(perUnit) ? 'kWh' : perUnit;
  return meter?.unit || '';
}

// Today's cost per hour of each of the simulated woning's cost calculations,
// up to now — shaped like a GET /woningen/:id/costs?interval=hour response,
// so the regular cost chart can show it.
async function simulatedCosts(woning, parameters, dayStart, now, deviceLabels, priceAt) {
  const byId = new Map(parameters.map((p) => [String(p._id), p]));
  const trackers = await CostTracker.find({ woning: woning._id }).sort({ createdAt: 1 }).lean();
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);
  const hours = [];
  for (let d = new Date(dayStart); d < dayEnd; d.setHours(d.getHours() + 1)) hours.push(new Date(d));

  return {
    interval: 'hour',
    from: dayStart.toISOString(),
    to: dayEnd.toISOString(),
    trackers: trackers.map((t) => {
      const meter = byId.get(String(t.meterParameter));
      const price = byId.get(String(t.priceParameter));
      let priceSum = 0;
      let priceCount = 0;
      const buckets = hours.map((start, i) => {
        const end = new Date(Math.min((hours[i + 1] || dayEnd).getTime(), now.getTime()));
        if (!meter || !price || start >= now) return { start: start.toISOString(), quantity: 0, cost: 0 };
        const quantity = simulatedMeterRise(meter, start, end, deviceLabels) * (t.meterConversionFactor || 1);
        const unitPrice = simulatedValue(price, start, deviceLabels, priceAt) * priceScale(price.unit);
        priceSum += unitPrice;
        priceCount += 1;
        return { start: start.toISOString(), quantity, cost: quantity * unitPrice };
      });
      const quantity = buckets.reduce((s, b) => s + b.quantity, 0);
      const cost = buckets.reduce((s, b) => s + b.cost, 0);
      return {
        _id: t._id,
        name: t.name,
        unit: pricedUnit(meter, price),
        buckets,
        totals: {
          quantity,
          cost,
          avgPaidPrice: quantity > 0 ? cost / quantity : null,
          avgPrice: priceCount > 0 ? priceSum / priceCount : null,
        },
      };
    }),
  };
}

async function buildDemo(now) {
  const woning = await Woning.findOne({ simulated: true }).lean();
  if (!woning) return null;
  const parameters = await Parameter.find({ woning: woning._id }).sort({ createdAt: 1 }).lean();
  const deviceLabels = deviceLabelsOf(parameters);

  const dayStart = localMidnight(now);
  const prices = await realPrices(parameters, dayStart, new Date(dayStart.getTime() + 2 * DAY_MS));
  const priceAt = (parameter, date) => {
    const curve = prices.get(String(parameter._id));
    if (!curve) return null;
    const hourMs = Math.floor(date.getTime() / HOUR_MS) * HOUR_MS;
    return curve.get(hourMs) ?? null;
  };

  const charts = await expandAutoInclude(
    await DashboardChart.find({ woning: woning._id, showOnDashboard: true, type: { $in: DEMO_CHART_TYPES } })
      .sort({ createdAt: 1 })
      .populate(POPULATE_PATHS),
    woning._id
  );

  const series = {};
  const priceCurves = {};
  for (const chart of charts) {
    if (chart.type === 'price_forecast') {
      const p = chart.parameters?.[0];
      if (!p) continue;
      const full = parameters.find((x) => String(x._id) === String(p._id)) || p;
      const real = prices.get(String(full._id));
      const points = [];
      for (let t = dayStart.getTime(); t < dayStart.getTime() + 2 * DAY_MS; t += HOUR_MS) {
        // Tomorrow's real prices only exist once they're published.
        if (real && !real.has(t)) continue;
        points.push({ timestamp: new Date(t).toISOString(), price: simulatedValue(full, new Date(t), deviceLabels, priceAt) });
      }
      priceCurves[chart._id] = { unit: full.unit || '€/kWh', points };
    } else if (chart.type !== 'energyflow' && chart.type !== 'cost') {
      series[chart._id] = (chart.parameters || []).map((p) => {
        const full = parameters.find((x) => String(x._id) === String(p._id)) || p;
        const points = [];
        for (let t = dayStart.getTime(); t <= now.getTime(); t += CURVE_STEP_MS) {
          points.push([t, simulatedValue(full, new Date(t), deviceLabels, priceAt)]);
        }
        return { parameterId: full._id, label: full.label, unit: full.unit, points };
      });
    }
  }

  return {
    woning: { _id: woning._id, name: woning.name },
    generatedAt: now.toISOString(),
    parameters: parameters.map((p) => ({
      _id: p._id,
      woning: p.woning,
      label: p.label,
      type: p.type,
      unit: p.unit,
      category: p.category,
      badge: p.badge,
      favorite: p.favorite,
      latest: { value: simulatedValue(p, now, deviceLabels, priceAt), timestamp: now.toISOString() },
    })),
    charts,
    series,
    prices: priceCurves,
    costs: charts.some((c) => c.type === 'cost')
      ? await simulatedCosts(woning, parameters, dayStart, now, deviceLabels, priceAt)
      : null,
  };
}

let cached = null; // { at, body }

// The simulated woning's live dashboard, for the public landing page — no
// login, and nothing from a real woning except public market prices.
router.get('/demo', async (req, res, next) => {
  try {
    const now = new Date();
    if (!cached || now - cached.at > CACHE_MS) {
      const body = await buildDemo(now);
      if (!body) return res.status(404).json({ error: { message: 'Geen simulatiewoning ingesteld' } });
      cached = { at: now, body };
    }
    res.json(cached.body);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
