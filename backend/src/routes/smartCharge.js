const express = require('express');
const { body, query, validationResult } = require('express-validator');
const SmartChargePlan = require('../models/SmartChargePlan');
const SmartChargeHistory = require('../models/SmartChargeHistory');
const Parameter = require('../models/Parameter');
const { authenticate } = require('../middleware/authenticate');
const { authorizeWoning } = require('../middleware/authorizeWoning');
const { ApiError } = require('../middleware/errorHandler');
const { smartChargeEngine, evaluatePlan } = require('../services/smartChargeEngine');
const { makeHaContext, loadSeries, counterDeltas } = require('../services/costEngine');

const router = express.Router({ mergeParams: true });

const HOUR_MS = 3600 * 1000;

// Includes controlDomain (unlike the display-only fields alone) because
// evaluateAndAct needs it to know which HA service domain to call for
// chargeSwitchParameter; options/optionLabels let the form offer a select's
// on/off options.
const POPULATE_FIELDS = 'label unit type entityId controlDomain options optionLabels';
const POPULATE_PATHS = [
  { path: 'socParameter', select: POPULATE_FIELDS },
  { path: 'solarRemainingParameter', select: POPULATE_FIELDS },
  { path: 'consumptionParameter', select: POPULATE_FIELDS },
  { path: 'priceParameter', select: POPULATE_FIELDS },
  { path: 'chargeSwitchParameter', select: POPULATE_FIELDS },
];

function checkValidation(req) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(400, 'Validation failed', errors.array());
}

async function assertParametersBelongToWoning(parameterIds, woningId) {
  const ids = parameterIds.filter(Boolean);
  if (ids.length === 0) return;
  const count = await Parameter.countDocuments({ _id: { $in: ids }, woning: woningId });
  if (count !== new Set(ids.map(String)).size) {
    throw new ApiError(400, 'Eén of meer parameters horen niet bij deze woning');
  }
}

const planFieldValidators = [
  body('name').isString().notEmpty(),
  body('capacityKwh').isFloat({ min: 0.1 }),
  body('targetSocPercent').optional().isFloat({ min: 1, max: 100 }),
  body('gridTargetSocPercent').optional({ nullable: true, checkFalsy: true }).isFloat({ min: 1, max: 100 }),
  body('maxChargePowerKw').isFloat({ min: 0.01 }),
  body('priority').optional().isInt(),
  body('socParameter').isMongoId(),
  body('solarRemainingParameter').isMongoId(),
  body('consumptionParameter').optional({ checkFalsy: true }).isMongoId(),
  body('avoidedPriceMode').optional().isIn(['average', 'consumption_weighted', 'max']),
  body('targetTime').optional({ checkFalsy: true }).matches(/^([01]\d|2[0-3]):([0-5]\d)$/),
  body('priceParameter').isMongoId(),
  body('chargeSwitchParameter').isMongoId(),
  body('chargeOnOption').optional({ nullable: true }).isString(),
  body('chargeOffOption').optional({ nullable: true }).isString(),
];

// A select_mode charge target needs both options set (and valid); a switch
// doesn't use them, so they're cleared rather than left dangling.
async function normalizeChargeTarget(fields) {
  const parameter = await Parameter.findById(fields.chargeSwitchParameter).select('type options');
  if (!parameter) return;
  if (parameter.type !== 'select_mode') {
    fields.chargeOnOption = null;
    fields.chargeOffOption = null;
    return;
  }
  const { chargeOnOption: on, chargeOffOption: off } = fields;
  if (!on || !off) {
    throw new ApiError(400, 'Kies voor de regelmodus welke optie "laden" en welke "niet laden" is');
  }
  if (on === off) throw new ApiError(400, 'De opties voor laden en niet laden moeten verschillen');
  const known = parameter.options || [];
  if (known.length > 0 && (!known.includes(on) || !known.includes(off))) {
    throw new ApiError(400, 'Onbekende optie voor deze regelmodus');
  }
}

router.use(authenticate, authorizeWoning());

// List smart-charge plans for a woning, each enriched with a live computed
// status — same computation the engine itself acts on, so what a user sees
// here is exactly what's driving (or would drive, once enabled) the switch.
router.get('/', async (req, res, next) => {
  try {
    const plans = await SmartChargePlan.find({ woning: req.params.woningId })
      .sort({ createdAt: 1 })
      .populate(POPULATE_PATHS);
    const withStatus = await Promise.all(
      plans.map(async (p) => ({ ...p.toObject(), status: await evaluatePlan(p).catch(() => null) }))
    );
    res.json(withStatus);
  } catch (err) {
    next(err);
  }
});

// Live recommendation for a single plan — polled by the dashboard card.
router.get('/:planId/status', async (req, res, next) => {
  try {
    const plan = await SmartChargePlan.findOne({
      _id: req.params.planId,
      woning: req.params.woningId,
    }).populate(POPULATE_PATHS);
    if (!plan) throw new ApiError(404, 'Smart charge plan not found');
    res.json(await evaluatePlan(plan));
  } catch (err) {
    next(err);
  }
});

router.post('/', authorizeWoning(['owner']), planFieldValidators, async (req, res, next) => {
  try {
    checkValidation(req);
    await assertParametersBelongToWoning(
      [
        req.body.socParameter,
        req.body.solarRemainingParameter,
        req.body.consumptionParameter,
        req.body.priceParameter,
        req.body.chargeSwitchParameter,
      ],
      req.params.woningId
    );
    const chargeTarget = {
      chargeSwitchParameter: req.body.chargeSwitchParameter,
      chargeOnOption: req.body.chargeOnOption,
      chargeOffOption: req.body.chargeOffOption,
    };
    await normalizeChargeTarget(chargeTarget);

    const plan = await SmartChargePlan.create({
      woning: req.params.woningId,
      name: req.body.name,
      capacityKwh: req.body.capacityKwh,
      targetSocPercent: req.body.targetSocPercent ?? 100,
      gridTargetSocPercent: req.body.gridTargetSocPercent || undefined,
      maxChargePowerKw: req.body.maxChargePowerKw,
      priority: req.body.priority ?? 0,
      socParameter: req.body.socParameter,
      solarRemainingParameter: req.body.solarRemainingParameter,
      consumptionParameter: req.body.consumptionParameter || undefined,
      // 'consumption_weighted' has nothing to weight with (and nothing to
      // net off the solar forecast) without a consumption parameter — kept
      // on 'average' rather than saving a mode the engine would silently
      // fall back on anyway. 'average' and 'max' don't depend on it, so
      // they're never affected by this.
      avoidedPriceMode:
        req.body.avoidedPriceMode === 'consumption_weighted' && !req.body.consumptionParameter
          ? undefined
          : req.body.avoidedPriceMode || undefined,
      targetTime: req.body.targetTime || undefined,
      priceParameter: req.body.priceParameter,
      chargeSwitchParameter: req.body.chargeSwitchParameter,
      chargeOnOption: chargeTarget.chargeOnOption || undefined,
      chargeOffOption: chargeTarget.chargeOffOption || undefined,
      createdBy: req.user._id,
    });

    const populated = await plan.populate(POPULATE_PATHS);
    // A fresh plan defaults to enabled:false, so this only computes the
    // recommendation (never actuates) — but it means the very first view
    // of a new plan already shows a real status instead of "laden...".
    const status = await smartChargeEngine.evaluateAndAct(populated);
    res.status(201).json({ ...populated.toObject(), status });
  } catch (err) {
    next(err);
  }
});

router.patch(
  '/:planId',
  authorizeWoning(['owner']),
  planFieldValidators.map((v) => v.optional()),
  async (req, res, next) => {
    try {
      checkValidation(req);
      if (
        req.body.socParameter ||
        req.body.solarRemainingParameter ||
        req.body.consumptionParameter ||
        req.body.priceParameter ||
        req.body.chargeSwitchParameter
      ) {
        await assertParametersBelongToWoning(
          [
            req.body.socParameter,
            req.body.solarRemainingParameter,
            req.body.consumptionParameter,
            req.body.priceParameter,
            req.body.chargeSwitchParameter,
          ],
          req.params.woningId
        );
      }

      const updates = { ...req.body };
      // An empty selection clears the (optional) consumption parameter
      // rather than being cast to an ObjectId, which would throw.
      if ('consumptionParameter' in updates && !updates.consumptionParameter) {
        updates.consumptionParameter = null;
        // Only 'consumption_weighted' has nothing left to weight with —
        // 'average' and 'max' don't depend on a consumption parameter, so
        // they're left alone. Falls back to the plan's current mode when
        // this request doesn't also change it.
        const currentMode =
          'avoidedPriceMode' in updates
            ? updates.avoidedPriceMode
            : (
                await SmartChargePlan.findOne({ _id: req.params.planId, woning: req.params.woningId })
                  .select('avoidedPriceMode')
                  .lean()
              )?.avoidedPriceMode;
        if (currentMode === 'consumption_weighted') updates.avoidedPriceMode = 'average';
      }
      // Same for the (optional) deadline: an empty string should clear it,
      // not fail the "HH:MM" pattern match.
      if ('targetTime' in updates && !updates.targetTime) {
        updates.targetTime = null;
      }
      // Likewise, an empty grid ceiling means "no ceiling".
      if ('gridTargetSocPercent' in updates && !updates.gridTargetSocPercent) {
        updates.gridTargetSocPercent = null;
      }
      if (
        'chargeSwitchParameter' in updates ||
        'chargeOnOption' in updates ||
        'chargeOffOption' in updates
      ) {
        const existing = await SmartChargePlan.findOne({
          _id: req.params.planId,
          woning: req.params.woningId,
        }).lean();
        if (!existing) throw new ApiError(404, 'Smart charge plan not found');
        const chargeTarget = {
          chargeSwitchParameter: updates.chargeSwitchParameter ?? existing.chargeSwitchParameter,
          chargeOnOption: 'chargeOnOption' in updates ? updates.chargeOnOption : existing.chargeOnOption,
          chargeOffOption: 'chargeOffOption' in updates ? updates.chargeOffOption : existing.chargeOffOption,
        };
        await normalizeChargeTarget(chargeTarget);
        updates.chargeOnOption = chargeTarget.chargeOnOption || null;
        updates.chargeOffOption = chargeTarget.chargeOffOption || null;
      }

      const plan = await SmartChargePlan.findOneAndUpdate(
        { _id: req.params.planId, woning: req.params.woningId },
        updates,
        { new: true, runValidators: true }
      ).populate(POPULATE_PATHS);
      if (!plan) throw new ApiError(404, 'Smart charge plan not found');

      // Recompute (and, if this plan is enabled, act on) right away rather
      // than leaving the old recommendation showing until the next tick —
      // changing which parameter feeds the plan, or its capacity/target/
      // power, changes what the plan should now be doing.
      const status = await smartChargeEngine.evaluateAndAct(plan);
      res.json({ ...plan.toObject(), status });
    } catch (err) {
      next(err);
    }
  }
);

// Lightweight on/off switch for the plan itself, separate from the full
// PATCH so the dashboard card can flip it without resending the whole
// config. Gated the same as the rest of plan management ('owner', matching
// how Automation's own `enabled` field requires 'owner' too) rather than
// opened to any woning member: unlike a timer's arm/disarm, this doesn't
// just trigger a one-off action — it hands the engine standing permission
// to operate real grid-charge hardware on its own until switched off again.
router.patch(
  '/:planId/toggle',
  authorizeWoning(['owner']),
  [body('enabled').isBoolean()],
  async (req, res, next) => {
    try {
      checkValidation(req);
      const plan = await SmartChargePlan.findOneAndUpdate(
        { _id: req.params.planId, woning: req.params.woningId },
        { enabled: req.body.enabled },
        { new: true }
      ).populate(POPULATE_PATHS);
      if (!plan) throw new ApiError(404, 'Smart charge plan not found');

      // Switching on shouldn't wait up to 10 minutes for the next tick
      // before the switch actually follows the plan.
      const status = await smartChargeEngine.evaluateAndAct(plan);
      res.json({ ...plan.toObject(), status });
    } catch (err) {
      next(err);
    }
  }
);

// Forces an immediate re-evaluation (and, if enabled, re-actuation) of a
// plan right now, without changing any of its fields — e.g. right after the
// price forecast or SOC changed in HA, rather than waiting for the engine's
// next 10-minute tick or the dashboard's next poll. Mirrors what create/
// update/toggle already trigger as a side effect of their own change.
router.post('/:planId/recompute', authorizeWoning(['owner']), async (req, res, next) => {
  try {
    const plan = await SmartChargePlan.findOne({
      _id: req.params.planId,
      woning: req.params.woningId,
    }).populate(POPULATE_PATHS);
    if (!plan) throw new ApiError(404, 'Smart charge plan not found');

    const status = await smartChargeEngine.evaluateAndAct(plan);
    res.json({ ...plan.toObject(), status });
  } catch (err) {
    next(err);
  }
});

const ALIGN = {
  hour: (d) => {
    d.setMinutes(0, 0, 0);
    return d;
  },
  day: (d) => {
    d.setHours(0, 0, 0, 0);
    return d;
  },
  month: (d) => {
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    return d;
  },
};

function nextBucket(date, interval) {
  const d = new Date(date);
  if (interval === 'hour') d.setHours(d.getHours() + 1);
  else if (interval === 'day') d.setDate(d.getDate() + 1);
  else d.setMonth(d.getMonth() + 1);
  return d;
}

// Mirrors routes/costs.js's own bucketing (kept local rather than shared —
// the two are a handful of lines each and evolve independently): maps a
// timestamp to the index of the last bucket starting at or before it.
function makeBucketIndex(bucketStarts) {
  return (t) => {
    let lo = 0;
    let hi = bucketStarts.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (bucketStarts[mid].getTime() <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
}

// Hourly rise of a cumulative grid-import meter over [fromMs, toMs), for the
// optional "totaal verbruik van het net" line on a smart-charge-savings
// chart — same statistics-first, Readings-fallback approach costEngine
// uses for a CostTracker's own meter, just without a price attached.
async function hourlyGridConsumption(meterParameter, woningId, fromMs, toMs) {
  const haContext = makeHaContext(woningId);
  const client = await haContext.client();
  const byHour = new Map();

  if (client) {
    try {
      const result = await client.fetchStatistics([meterParameter.entityId], {
        start: new Date(fromMs - HOUR_MS).toISOString(),
        end: new Date(toMs).toISOString(),
        types: ['sum'],
      });
      let previousSum = null;
      for (const row of result[meterParameter.entityId] || []) {
        if (typeof row.sum !== 'number') continue;
        const t = typeof row.start === 'number' ? row.start : new Date(row.start).getTime();
        if (previousSum !== null && t >= fromMs) byHour.set(t, Math.max(0, row.sum - previousSum));
        previousSum = row.sum;
      }
    } catch (err) {
      console.error(`Grid consumption statistics fetch failed for ${meterParameter.entityId}:`, err.message);
    }
  }

  const missingHours = [];
  for (let t = fromMs; t < toMs; t += HOUR_MS) if (!byHour.has(t)) missingHours.push(t);
  if (missingHours.length > 0) {
    const series = await loadSeries(meterParameter, new Date(fromMs), new Date(toMs), haContext);
    const fallback = counterDeltas(series, missingHours);
    missingHours.forEach((t, i) => byHour.set(t, fallback[i]));
  }
  return byHour;
}

// Net energy in/out of the battery per hour over [fromMs, toMs), in kWh:
// positive = discharged, negative = charged (the hour's average power, so
// an hour that did both only counts the balance). HA's hourly
// `mean` statistic first; for hours without one, a time-weighted average of
// the raw series (TEMS Readings / HA history).
async function hourlyBatteryEnergy(powerParameter, woningId, fromMs, toMs) {
  const haContext = makeHaContext(woningId);
  const client = await haContext.client();
  const toKwh = (power) => {
    const unit = (powerParameter.unit || 'W').trim().toLowerCase();
    return unit === 'kw' ? power : power / 1000;
  };
  const sign = powerParameter.invert ? -1 : 1;
  const byHour = new Map();

  if (client) {
    try {
      const result = await client.fetchStatistics([powerParameter.entityId], {
        start: new Date(fromMs).toISOString(),
        end: new Date(toMs).toISOString(),
        types: ['mean'],
      });
      for (const row of result[powerParameter.entityId] || []) {
        if (typeof row.mean !== 'number') continue;
        const t = typeof row.start === 'number' ? row.start : new Date(row.start).getTime();
        if (t >= fromMs && t < toMs) byHour.set(t, toKwh(row.mean * sign));
      }
    } catch (err) {
      console.error(`Battery power statistics fetch failed for ${powerParameter.entityId}:`, err.message);
    }
  }

  const missingHours = [];
  for (let t = fromMs; t < toMs; t += HOUR_MS) if (!byHour.has(t)) missingHours.push(t);
  if (missingHours.length > 0) {
    // Readings are stored already inverted, so no `sign` here.
    const series = await loadSeries(powerParameter, new Date(fromMs), new Date(toMs), haContext);
    for (const hourMs of missingHours) {
      const end = hourMs + HOUR_MS;
      let area = 0;
      let covered = 0;
      let last = null;
      for (const p of series) {
        if (p.t >= end) break;
        if (last && p.t > hourMs) {
          const from = Math.max(last.t, hourMs);
          area += last.v * (p.t - from);
          covered += p.t - from;
        }
        last = p;
      }
      if (last && Math.min(Date.now(), end) > Math.max(last.t, hourMs)) {
        const from = Math.max(last.t, hourMs);
        const until = Math.min(Date.now(), end);
        area += last.v * (until - from);
        covered += until - from;
      }
      byHour.set(hourMs, covered > 0 ? toKwh(area / covered) * (covered / HOUR_MS) : 0);
    }
  }
  return byHour;
}

// The plans' gridChargedKwh is an estimate (time the charge switch was on ×
// maxChargePowerKw), so per hour it's capped at what the battery actually
// took in and at what was actually imported from the grid.
//
// Grid-charged energy isn't gone once it's in the battery: it's used again
// later, when the battery discharges. Without grid charging those later
// hours would have come from the grid instead, so the counterfactual takes
// the charging off the hour it happened in and puts the same energy back on
// the hours the battery then discharged — oldest charge first, as long as
// there's grid-charged energy left in the battery (and at most what was
// discharged that hour). Grid-charged energy not discharged within
// GRID_CHARGE_POOL_MAX_AGE_MS is no longer attributed. Inputs are
// Map<hourMs, kWh> (batteryByHour signed, see hourlyBatteryEnergy); returns
// Map<hourMs, {withoutGridCharging, gridCharged, shifted}> for
// every hour of [fromMs, toMs) — charging/discharge before fromMs only feed
// the pool.
const GRID_CHARGE_POOL_MAX_AGE_MS = 36 * HOUR_MS;
function withoutGridChargingByHour({ gridByHour, chargedByHour, batteryByHour, lookbackFromMs, fromMs, toMs }) {
  const pool = []; // [{ t, kwh }] oldest first
  const result = new Map();
  for (let t = lookbackFromMs; t < toMs; t += HOUR_MS) {
    while (pool.length > 0 && t - pool[0].t > GRID_CHARGE_POOL_MAX_AGE_MS) pool.shift();
    const battery = batteryByHour.get(t) || 0;
    const grid = gridByHour.get(t) || 0;
    const planned = chargedByHour.get(t) || 0;
    const charged = planned > 0 ? Math.min(planned, Math.max(0, -battery), grid) : 0;
    // Discharge in an hour the plan was charging can't come from that charge.
    let toCover = planned > 0 ? 0 : Math.max(0, battery);
    let shifted = 0;
    while (toCover > 1e-9 && pool.length > 0) {
      const take = Math.min(toCover, pool[0].kwh);
      shifted += take;
      toCover -= take;
      pool[0].kwh -= take;
      if (pool[0].kwh <= 1e-9) pool.shift();
    }
    if (charged > 0) pool.push({ t, kwh: charged });
    if (t >= fromMs) result.set(t, { withoutGridCharging: grid - charged + shifted, gridCharged: charged, shifted });
  }
  return result;
}

// Per-plan grid-charging history (kWh, actual cost, hypothetical cost at
// the avoidedPrice reference) plus, optionally, the woning's total grid
// import — bucketed into `interval`-sized buckets over [from, to). Drives
// the 'smart_charge_savings' DashboardChart type: "totaal verbruik van het
// net" next to "waarvan laden batterij" and what that would have cost
// without smart timing.
router.get(
  '/history',
  [
    query('from').isISO8601(),
    query('to').isISO8601(),
    query('interval').optional().isIn(['hour', 'day', 'month']),
    query('plans').optional().isString(),
    query('gridConsumptionParameter').optional().isMongoId(),
    query('batteryPowerParameter').optional().isMongoId(),
  ],
  async (req, res, next) => {
    try {
      checkValidation(req);
      const interval = req.query.interval || 'day';
      const from = ALIGN[interval](new Date(req.query.from));
      const to = new Date(req.query.to);
      const fromMs = from.getTime();
      const toMs = to.getTime();

      const planIds = req.query.plans ? req.query.plans.split(',').filter(Boolean) : [];
      const planFilter = { woning: req.params.woningId, ...(planIds.length > 0 ? { _id: { $in: planIds } } : {}) };
      const plans = await SmartChargePlan.find(planFilter).select('name priceParameter').populate('priceParameter', 'unit');

      // Rows from before `from` too: charging just before the window can
      // still be discharged within it (see withoutGridChargingByHour).
      const lookbackFromMs = fromMs - GRID_CHARGE_POOL_MAX_AGE_MS;
      const allRows = await SmartChargeHistory.find({
        woning: req.params.woningId,
        plan: { $in: plans.map((p) => p._id) },
        start: { $gte: new Date(lookbackFromMs), $lt: to },
      })
        .sort({ start: 1 })
        .lean();
      const rows = allRows.filter((r) => r.start.getTime() >= fromMs);

      const bucketStarts = [];
      for (let d = new Date(from); d < to; d = nextBucket(d, interval)) bucketStarts.push(d);
      const bucketIndex = makeBucketIndex(bucketStarts);

      const byPlan = new Map(
        plans.map((p) => [
          p._id.toString(),
          {
            _id: p._id,
            name: p.name,
            priceUnit: p.priceParameter?.unit || '',
            buckets: bucketStarts.map((s) => ({ start: s.toISOString(), gridChargedKwh: 0, actualCost: 0, hypotheticalCost: 0 })),
          },
        ])
      );
      for (const row of rows) {
        const entry = byPlan.get(row.plan.toString());
        if (!entry || bucketStarts.length === 0) continue;
        const bucket = entry.buckets[bucketIndex(row.start.getTime())];
        bucket.gridChargedKwh += row.gridChargedKwh || 0;
        bucket.actualCost += row.actualCost || 0;
        if (typeof row.hypotheticalCost === 'number') bucket.hypotheticalCost += row.hypotheticalCost;
      }

      let gridConsumption = null;
      if (req.query.gridConsumptionParameter) {
        const meterParameter = await Parameter.findOne({
          _id: req.query.gridConsumptionParameter,
          woning: req.params.woningId,
        }).lean();
        if (meterParameter) {
          const hourly = await hourlyGridConsumption(meterParameter, req.params.woningId, fromMs, toMs);
          const gcBuckets = bucketStarts.map((s) => ({ start: s.toISOString(), kwh: 0 }));
          if (bucketStarts.length > 0) {
            for (const [hourMs, kwh] of hourly) {
              if (hourMs < fromMs || hourMs >= toMs) continue;
              gcBuckets[bucketIndex(hourMs)].kwh += kwh;
            }
          }

          const batteryParameter = req.query.batteryPowerParameter
            ? await Parameter.findOne({ _id: req.query.batteryPowerParameter, woning: req.params.woningId }).lean()
            : null;
          if (batteryParameter && bucketStarts.length > 0) {
            const chargedByHour = new Map();
            for (const row of allRows) {
              const t = row.start.getTime();
              chargedByHour.set(t, (chargedByHour.get(t) || 0) + (row.gridChargedKwh || 0));
            }
            const batteryByHour = await hourlyBatteryEnergy(
              batteryParameter,
              req.params.woningId,
              lookbackFromMs,
              toMs
            );
            const scenario = withoutGridChargingByHour({
              gridByHour: hourly,
              chargedByHour,
              batteryByHour,
              lookbackFromMs,
              fromMs,
              toMs,
            });
            for (const b of gcBuckets) {
              b.withoutGridChargingKwh = 0;
              b.gridChargedKwh = 0;
              b.shiftedKwh = 0;
            }
            for (const [hourMs, v] of scenario) {
              const b = gcBuckets[bucketIndex(hourMs)];
              b.withoutGridChargingKwh += v.withoutGridCharging;
              b.gridChargedKwh += v.gridCharged;
              b.shiftedKwh += v.shifted;
            }
          }
          gridConsumption = {
            unit: meterParameter.unit || 'kWh',
            buckets: gcBuckets,
            total: gcBuckets.reduce((s, b) => s + b.kwh, 0),
          };
        }
      }

      res.json({
        interval,
        from: from.toISOString(),
        to: to.toISOString(),
        plans: [...byPlan.values()].map((p) => ({
          ...p,
          totals: {
            gridChargedKwh: p.buckets.reduce((s, b) => s + b.gridChargedKwh, 0),
            actualCost: p.buckets.reduce((s, b) => s + b.actualCost, 0),
            hypotheticalCost: p.buckets.reduce((s, b) => s + b.hypotheticalCost, 0),
          },
        })),
        gridConsumption,
      });
    } catch (err) {
      next(err);
    }
  }
);

router.delete('/:planId', authorizeWoning(['owner']), async (req, res, next) => {
  try {
    const plan = await SmartChargePlan.findOneAndDelete({
      _id: req.params.planId,
      woning: req.params.woningId,
    });
    if (!plan) throw new ApiError(404, 'Smart charge plan not found');
    await SmartChargeHistory.deleteMany({ plan: plan._id });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
