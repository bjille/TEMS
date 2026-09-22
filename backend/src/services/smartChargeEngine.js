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
function computeChargePlan({
  capacityKwh,
  targetSocPercent,
  maxChargePowerKw,
  currentSocPercent,
  solarRemainingKwh,
  pricePoints,
  now = new Date(),
}) {
  const neededKwh = Math.max(0, (capacityKwh * (targetSocPercent - currentSocPercent)) / 100);
  const shortfallKwh = Math.max(0, neededKwh - Math.max(0, solarRemainingKwh || 0));

  const nowHourMs = floorToHourMs(now);
  const upcoming = pricePoints.filter((p) => new Date(p.timestamp).getTime() >= nowHourMs);

  if (shortfallKwh <= 0.01 || upcoming.length === 0) {
    return { neededKwh, shortfallKwh: 0, hoursNeeded: 0, chargeHours: [], upcomingHours: upcoming };
  }

  const hoursNeeded = Math.min(upcoming.length, Math.ceil(shortfallKwh / maxChargePowerKw));
  const chargeHours = [...upcoming]
    .sort((a, b) => a.price - b.price)
    .slice(0, hoursNeeded)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  return { neededKwh, shortfallKwh, hoursNeeded, chargeHours, upcomingHours: upcoming };
}

// Gathers a plan's live inputs (current SOC, remaining solar forecast, price
// curve) and runs them through computeChargePlan. Shared by the read-only
// status endpoint (a user looking at the recommendation) and the engine's
// own tick (deciding whether to act) — both need exactly the same
// computation, just with different consumers of the result.
async function evaluatePlan(plan) {
  const [socValue, solarValue, woning] = await Promise.all([
    latestValue(plan.socParameter._id || plan.socParameter),
    latestValue(plan.solarRemainingParameter._id || plan.solarRemainingParameter),
    Woning.findById(plan.woning).select('+haTokenEncrypted'),
  ]);

  const currentSocPercent = typeof socValue === 'number' ? socValue : null;
  const solarRemainingKwh = typeof solarValue === 'number' ? solarValue : null;

  const priceParameter = plan.priceParameter._id
    ? plan.priceParameter
    : await Parameter.findById(plan.priceParameter);
  const forecast = woning && priceParameter ? await fetchPriceForecast(priceParameter, woning) : null;

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
    pricePoints: forecast.points,
  });

  const nowHourMs = floorToHourMs(new Date());
  const shouldChargeNow = plan_.chargeHours.some((h) => new Date(h.timestamp).getTime() === nowHourMs);

  return {
    ready: true,
    currentSocPercent,
    solarRemainingKwh,
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
      'priceParameter',
      'chargeSwitchParameter',
    ]);
    for (const plan of plans) {
      await this._evaluateAndAct(plan).catch((err) =>
        console.error(`Smart charge plan ${plan._id} failed:`, err)
      );
    }
  }

  async _evaluateAndAct(plan) {
    const { haConnectionManager } = require('./haConnectionManager'); // deferred: see AutomationEngine.runAction

    const status = await evaluatePlan(plan);
    plan.lastEvaluatedAt = new Date();

    if (!status.ready) {
      plan.lastError = status.reason;
      await plan.save();
      return;
    }

    const switchParameter = plan.chargeSwitchParameter;
    const currentSwitchValue = await latestValue(switchParameter._id);
    const currentlyOn = currentSwitchValue === 'on';
    const desiredOn = status.shouldChargeNow;

    plan.lastError = undefined;

    if (currentlyOn === desiredOn) {
      plan.lastAction = desiredOn ? 'on' : 'off';
      await plan.save();
      return;
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
  }
}

const smartChargeEngine = new SmartChargeEngine();

module.exports = { smartChargeEngine, SmartChargeEngine, computeChargePlan, evaluatePlan };
