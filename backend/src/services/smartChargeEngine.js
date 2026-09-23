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

async function latestValue(parameterId) {
  const reading = await Reading.findOne({ parameter: parameterId }).sort({ timestamp: -1 });
  return reading ? reading.value : null;
}

// Looks back this many full calendar days when averaging daily consumption —
// long enough to smooth out one-off high/low days without reacting too
// slowly to a real change in household habits.
const AVG_CONSUMPTION_LOOKBACK_DAYS = 14;

// Average total daily consumption in kWh, computed from locally-ingested
// Readings by time-weighting each one across the gap until the next reading
// (zero-order hold — the same reasoning routes/readings.js uses for its
// daily-total bucketing, just against stored Readings instead of a live HA
// history fetch). Only counts full calendar days (today is excluded — it's
// still in progress) and returns null when there isn't enough history yet to
// compute a meaningful average, so callers can fall back to ignoring
// consumption entirely.
async function averageDailyConsumptionKwh(parameterId, days = AVG_CONSUMPTION_LOOKBACK_DAYS) {
  const end = new Date();
  end.setHours(0, 0, 0, 0);
  const start = new Date(end.getTime() - days * 24 * 3600 * 1000);

  const readings = await Reading.find({ parameter: parameterId, timestamp: { $gte: start, $lt: end } })
    .sort({ timestamp: 1 })
    .select('value timestamp')
    .lean();

  if (readings.length < 2) return null;

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
function computeChargePlan({
  capacityKwh,
  targetSocPercent,
  maxChargePowerKw,
  currentSocPercent,
  solarRemainingKwh,
  avgDailyConsumptionKwh,
  pricePoints,
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

  const nowHourMs = floorToHourMs(now);
  const upcoming = pricePoints.filter((p) => new Date(p.timestamp).getTime() >= nowHourMs);

  if (shortfallKwh <= 0.01 || upcoming.length === 0) {
    return {
      neededKwh,
      expectedConsumptionKwh,
      netSolarRemainingKwh,
      shortfallKwh: 0,
      hoursNeeded: 0,
      chargeHours: [],
      upcomingHours: upcoming,
    };
  }

  const hoursNeeded = Math.min(upcoming.length, Math.ceil(shortfallKwh / maxChargePowerKw));
  const chargeHours = [...upcoming]
    .sort((a, b) => a.price - b.price)
    .slice(0, hoursNeeded)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  return { neededKwh, expectedConsumptionKwh, netSolarRemainingKwh, shortfallKwh, hoursNeeded, chargeHours, upcomingHours: upcoming };
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
    plan.consumptionParameter
      ? averageDailyConsumptionKwh(plan.consumptionParameter._id || plan.consumptionParameter)
      : Promise.resolve(null),
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
