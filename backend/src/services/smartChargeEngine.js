const cron = require('node-cron');
const SmartChargePlan = require('../models/SmartChargePlan');
const Parameter = require('../models/Parameter');
const Woning = require('../models/Woning');
const Reading = require('../models/Reading');
const CommandLog = require('../models/CommandLog');
const { fetchPriceForecast } = require('./priceForecastService');

// Re-evaluate (and, for enabled plans, act on) every 10 minutes: frequent
// enough that charging starts within a few minutes of the hour it was
// scheduled for, without hammering HA or Mongo.
const TICK_CRON = '*/10 * * * *';

function floorToHourMs(date) {
  const d = new Date(date);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

// The next moment "HH:MM" (local time) occurs at or after `now` — today's if
// it hasn't passed yet, otherwise tomorrow's, since a plan's deadline is a
// daily recurring cutoff rather than a one-off date. Returns null when no
// deadline is configured, so callers can treat "no deadline" and "deadline
// resolution" uniformly.
function nextOccurrence(targetTime, now) {
  if (!targetTime) return null;
  const [hh, mm] = targetTime.split(':').map(Number);
  const candidate = new Date(now);
  candidate.setHours(hh, mm, 0, 0);
  if (candidate <= now) candidate.setDate(candidate.getDate() + 1);
  return candidate;
}

async function latestValue(parameterId) {
  const reading = await Reading.findOne({ parameter: parameterId }).sort({ timestamp: -1 });
  return reading ? reading.value : null;
}

// Looks back this many full calendar days when averaging daily consumption —
// long enough to smooth out one-off high/low days without reacting too
// slowly to a real change in household habits.
const AVG_CONSUMPTION_LOOKBACK_DAYS = 14;

// Average total daily consumption in kWh, computed from locally-ingested
// Readings. Only counts full calendar days (today is excluded — it's still
// in progress) and returns null when there isn't enough history yet to
// compute a meaningful average, so callers can fall back to ignoring
// consumption entirely.
//
// Two different sensor shapes both end up under the 'energy_consumption'
// parameter type, and need very different math:
//  - a 'kWh' parameter is treated as a daily-reset cumulative counter (e.g.
//    a "Thuisverbruik dag" utility-meter helper that climbs from 0 through
//    the day and resets at midnight) — each day's total is simply the
//    highest value it reached that day, averaged across days.
//  - anything else (typically 'W') is treated as an instantaneous power
//    sensor and time-weighted across the gap until the next reading (zero-
//    order hold — the same reasoning routes/readings.js uses for its
//    daily-total bucketing, just against stored Readings instead of a live
//    HA history fetch).
// Silently applying the power-sensor math to a cumulative kWh counter would
// read "9.26 kWh so far today" as if it were a 9.26 W load, producing a
// wildly wrong average.
async function averageDailyConsumptionKwh(parameter, days = AVG_CONSUMPTION_LOOKBACK_DAYS) {
  const parameterId = parameter._id || parameter;
  const isCumulativeDaily = (parameter.unit || '').trim().toLowerCase() === 'kwh';

  const end = new Date();
  end.setHours(0, 0, 0, 0);
  const start = new Date(end.getTime() - days * 24 * 3600 * 1000);

  const readings = await Reading.find({ parameter: parameterId, timestamp: { $gte: start, $lt: end } })
    .sort({ timestamp: 1 })
    .select('value timestamp')
    .lean();

  if (readings.length < 2) return null;

  if (isCumulativeDaily) {
    const maxByDay = new Map();
    for (const r of readings) {
      if (typeof r.value !== 'number') continue;
      const dayStart = new Date(r.timestamp);
      dayStart.setHours(0, 0, 0, 0);
      const key = dayStart.getTime();
      maxByDay.set(key, Math.max(maxByDay.get(key) || 0, r.value));
    }
    if (maxByDay.size === 0) return null;
    const total = [...maxByDay.values()].reduce((a, b) => a + b, 0);
    return total / maxByDay.size;
  }

  let weightedSum = 0; // W*ms
  for (let i = 0; i < readings.length; i++) {
    const value = readings[i].value;
    if (typeof value !== 'number') continue;
    const fromMs = new Date(readings[i].timestamp).getTime();
    const toMs = i + 1 < readings.length ? new Date(readings[i + 1].timestamp).getTime() : end.getTime();
    weightedSum += value * (toMs - fromMs);
  }

  const coveredDays = (end.getTime() - new Date(readings[0].timestamp).getTime()) / (24 * 3600 * 1000);
  return coveredDays > 0 ? weightedSum / 3.6e9 / coveredDays : null;
}

// Pure decision logic, kept separate from I/O so it's easy to reason about
// (and test) on its own: given the current state-of-charge, how much solar
// production is still expected today, and the hourly price curve, decide
// whether a grid-charge shortfall exists and — if so — which upcoming hours
// are the cheapest way to cover it.
//
// The shortfall only covers what solar *won't* provide: grid charging never
// tops up further than `targetSocPercent - (solar the forecast still
// expects)`, so a sunny forecast alone can bring the plan's shortfall to
// zero without ever touching the grid.
//
// Remaining solar has to cover the household's own load before any of it can
// reach the battery — crediting the full forecast toward charging (as if the
// house drew nothing) overstates how much actually gets there. `avgDaily
// ConsumptionKwh`, prorated by the fraction of today still ahead, estimates
// that household draw and nets it off the solar forecast before the
// shortfall is computed.
//
// `targetTime` ("HH:MM"), when set, caps which hours are even eligible for
// selection to those starting before the next occurrence of that deadline —
// otherwise the cheapest hours could land well past it (e.g. a Sunday-
// afternoon dip) even though the car needs to be full for Monday's commute.
// `deadlineFeasible` reports whether the hours actually available before the
// deadline can fully cover the shortfall at `maxChargePowerKw`; when they
// can't, `chargeHours` still schedules as many of the cheapest eligible
// hours as it can (best effort) rather than leaving the plan empty-handed.
function computeChargePlan({
  capacityKwh,
  targetSocPercent,
  maxChargePowerKw,
  currentSocPercent,
  solarRemainingKwh,
  avgDailyConsumptionKwh,
  pricePoints,
  targetTime,
  now = new Date(),
}) {
  const neededKwh = Math.max(0, (capacityKwh * (targetSocPercent - currentSocPercent)) / 100);

  const endOfDay = new Date(now);
  endOfDay.setHours(24, 0, 0, 0);
  const remainingHoursToday = Math.max(0, Math.min(24, (endOfDay.getTime() - now.getTime()) / 3600000));
  const expectedConsumptionKwh =
    typeof avgDailyConsumptionKwh === 'number' ? (avgDailyConsumptionKwh * remainingHoursToday) / 24 : 0;
  const netSolarRemainingKwh = Math.max(0, (solarRemainingKwh || 0) - expectedConsumptionKwh);

  const shortfallKwh = Math.max(0, neededKwh - netSolarRemainingKwh);

  const deadline = nextOccurrence(targetTime, now);
  const deadlineAt = deadline ? deadline.toISOString() : null;

  const nowHourMs = floorToHourMs(now);
  const upcoming = pricePoints.filter((p) => {
    const t = new Date(p.timestamp).getTime();
    return t >= nowHourMs && (!deadline || t < deadline.getTime());
  });

  if (shortfallKwh <= 0.01 || upcoming.length === 0) {
    return {
      neededKwh,
      expectedConsumptionKwh,
      netSolarRemainingKwh,
      shortfallKwh: 0,
      hoursNeeded: 0,
      chargeHours: [],
      upcomingHours: upcoming,
      deadlineAt,
      deadlineFeasible: shortfallKwh <= 0.01,
    };
  }

  const hoursNeeded = Math.min(upcoming.length, Math.ceil(shortfallKwh / maxChargePowerKw));
  const chargeHours = [...upcoming]
    .sort((a, b) => a.price - b.price)
    .slice(0, hoursNeeded)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  const deadlineFeasible = upcoming.length * maxChargePowerKw >= shortfallKwh - 0.01;

  return {
    neededKwh,
    expectedConsumptionKwh,
    netSolarRemainingKwh,
    shortfallKwh,
    hoursNeeded,
    chargeHours,
    upcomingHours: upcoming,
    deadlineAt,
    deadlineFeasible,
  };
}

// averageDailyConsumptionKwh needs the parameter's `unit` to know which of
// its two computations applies, so — mirroring how evaluatePlan already
// falls back to a fresh lookup for priceParameter — this resolves an
// unpopulated consumptionParameter (a plain ObjectId, lacking `.unit`) to
// the full Parameter document before computing the average.
async function resolveConsumptionAverage(consumptionParameter) {
  if (!consumptionParameter) return null;
  const parameter = consumptionParameter._id
    ? consumptionParameter
    : await Parameter.findById(consumptionParameter);
  return parameter ? averageDailyConsumptionKwh(parameter) : null;
}

// Gathers a plan's live inputs (current SOC, remaining solar forecast, price
// curve) and runs them through computeChargePlan. Shared by the read-only
// status endpoint (a user looking at the recommendation) and the engine's
// own tick (deciding whether to act) — both need exactly the same
// computation, just with different consumers of the result.
async function evaluatePlan(plan) {
  const [socValue, solarValue, woning, avgDailyConsumptionKwh] = await Promise.all([
    latestValue(plan.socParameter._id || plan.socParameter),
    latestValue(plan.solarRemainingParameter._id || plan.solarRemainingParameter),
    Woning.findById(plan.woning).select('+haTokenEncrypted'),
    resolveConsumptionAverage(plan.consumptionParameter),
  ]);

  const currentSocPercent = typeof socValue === 'number' ? socValue : null;
  const solarRemainingKwh = typeof solarValue === 'number' ? solarValue : null;

  const priceParameter = plan.priceParameter._id
    ? plan.priceParameter
    : await Parameter.findById(plan.priceParameter);
  // Never let an HA outage throw out of here: every caller (the tick, the
  // read-only status routes, and now the "recalculate after a config
  // change" path) needs a plain ready:false instead of an exception to
  // handle gracefully — a create/update request should still return the
  // saved plan even when HA happens to be unreachable at that moment.
  const forecast =
    woning && priceParameter ? await fetchPriceForecast(priceParameter, woning).catch(() => null) : null;

  if (currentSocPercent === null || solarRemainingKwh === null || !forecast) {
    return {
      ready: false,
      reason:
        currentSocPercent === null
          ? 'Geen actuele meting voor de SOC-parameter'
          : solarRemainingKwh === null
          ? 'Geen actuele meting voor de zon-forecast-parameter'
          : 'Prijsdata ophalen bij Home Assistant mislukt',
      currentSocPercent,
      solarRemainingKwh,
    };
  }

  const plan_ = computeChargePlan({
    capacityKwh: plan.capacityKwh,
    targetSocPercent: plan.targetSocPercent,
    maxChargePowerKw: plan.maxChargePowerKw,
    currentSocPercent,
    solarRemainingKwh,
    avgDailyConsumptionKwh,
    pricePoints: forecast.points,
    targetTime: plan.targetTime,
  });

  const nowHourMs = floorToHourMs(new Date());
  const shouldChargeNow = plan_.chargeHours.some((h) => new Date(h.timestamp).getTime() === nowHourMs);

  return {
    ready: true,
    currentSocPercent,
    solarRemainingKwh,
    avgDailyConsumptionKwh,
    priceUnit: forecast.unit,
    shouldChargeNow,
    ...plan_,
  };
}

/**
 * Periodically re-evaluates every enabled SmartChargePlan and, when its
 * computed plan says this hour should be charging (or shouldn't), brings
 * chargeSwitchParameter's actual HA state in line — mirroring
 * AutomationEngine's shape (loadAll/tick, deferred haConnectionManager
 * require) but driven purely by a cron tick rather than by readings, since
 * the decision depends on a forecast curve, not a single threshold.
 */
class SmartChargeEngine {
  constructor() {
    this.task = null;
  }

  start() {
    if (this.task) return;
    this.task = cron.schedule(TICK_CRON, () => {
      this.tick().catch((err) => console.error('Smart charge tick failed:', err));
    });
  }

  stop() {
    this.task?.stop();
    this.task = null;
  }

  async tick() {
    const plans = await SmartChargePlan.find({ enabled: true }).populate([
      'socParameter',
      'solarRemainingParameter',
      'consumptionParameter',
      'priceParameter',
      'chargeSwitchParameter',
    ]);
    for (const plan of plans) {
      await this.evaluateAndAct(plan).catch((err) =>
        console.error(`Smart charge plan ${plan._id} failed:`, err)
      );
    }
  }

  // Computes a plan's current status and, only when it's enabled, brings
  // chargeSwitchParameter's actual HA state in line with it. Called both
  // from the periodic tick (already filtered to enabled plans) and,
  // directly, right after a plan is created/edited/toggled — a config
  // change shouldn't have to wait for the next tick before the
  // recommendation (and, if enabled, the switch) reflects it. The `enabled`
  // check therefore lives here rather than only in the tick's query, so a
  // disabled plan can never be actuated no matter which caller reaches it.
  async evaluateAndAct(plan) {
    const status = await evaluatePlan(plan);
    plan.lastEvaluatedAt = new Date();

    if (!status.ready) {
      plan.lastError = status.reason;
      await plan.save();
      return status;
    }
    plan.lastError = undefined;

    if (!plan.enabled) {
      await plan.save();
      return status;
    }

    const { haConnectionManager } = require('./haConnectionManager'); // deferred: see AutomationEngine.runAction

    const switchParameter = plan.chargeSwitchParameter;
    const currentSwitchValue = await latestValue(switchParameter._id);
    const currentlyOn = currentSwitchValue === 'on';
    const desiredOn = status.shouldChargeNow;

    if (currentlyOn === desiredOn) {
      plan.lastAction = desiredOn ? 'on' : 'off';
      await plan.save();
      return status;
    }

    let result = 'success';
    let errorMessage;
    try {
      const client = haConnectionManager.getClient(plan.woning);
      if (!client) throw new Error('Home Assistant connection not available');

      const domain = switchParameter.controlDomain || switchParameter.entityId.split('.')[0];
      await client.callService(domain, desiredOn ? 'turn_on' : 'turn_off', {
        entity_id: switchParameter.entityId,
      });
      plan.lastAction = desiredOn ? 'on' : 'off';
    } catch (err) {
      result = 'error';
      errorMessage = err.message;
      plan.lastError = err.message;
    }

    await plan.save();

    await CommandLog.create({
      woning: plan.woning,
      parameter: switchParameter._id,
      action: desiredOn ? 'turn_on' : 'turn_off',
      result,
      error: errorMessage,
      source: 'smart_charge',
      smartChargePlan: plan._id,
    }).catch((logErr) => console.error('Failed to write smart-charge command log', logErr));

    return status;
  }
}

const smartChargeEngine = new SmartChargeEngine();

module.exports = {
  smartChargeEngine,
  SmartChargeEngine,
  computeChargePlan,
  evaluatePlan,
  averageDailyConsumptionKwh,
  SMART_CHARGE_POPULATE_PATHS: [
    'socParameter',
    'solarRemainingParameter',
    'consumptionParameter',
    'priceParameter',
    'chargeSwitchParameter',
  ],
};
