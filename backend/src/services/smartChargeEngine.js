const cron = require('node-cron');
const SmartChargePlan = require('../models/SmartChargePlan');
const Parameter = require('../models/Parameter');
const Woning = require('../models/Woning');
const Reading = require('../models/Reading');
const CommandLog = require('../models/CommandLog');
const SmartChargeHistory = require('../models/SmartChargeHistory');
const { fetchPriceForecast, normalizePricePoints } = require('./priceForecastService');
const { HaClient } = require('./haClient');
const { decrypt } = require('../utils/crypto');

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
// HA's recorder purges raw state history (the only place that retains an
// entity's attributes, as opposed to its long-term statistics, which track
// only the bare numeric state) after about this long — see
// historicalDayPriceCurve below for why that matters here.
const HISTORY_RETENTION_MS = 10 * DAY_MS;

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

// Woningen carry no coordinates, so sunrise/sunset is computed for the
// centre of Belgium — a few minutes off at the borders, which is well within
// the accuracy of the solar forecast itself.
const SITE_LATITUDE = 50.85;
const SITE_LONGITUDE = 4.35;

// Sunrise and sunset (as Dates) on the calendar day of `date`, using the
// NOAA approximation. Returns null for polar day/night, which can't happen at
// this latitude but keeps the math honest.
function sunTimes(date) {
  const rad = Math.PI / 180;
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  const yearStart = new Date(dayStart.getFullYear(), 0, 1);
  const dayOfYear = Math.round((dayStart - yearStart) / 86400000) + 1;
  const gamma = ((2 * Math.PI) / 365) * (dayOfYear - 1);
  const eqTimeMin =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(gamma) -
      0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) -
      0.040849 * Math.sin(2 * gamma));
  const decl =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma);
  const cosHa =
    Math.cos(90.833 * rad) / (Math.cos(SITE_LATITUDE * rad) * Math.cos(decl)) -
    Math.tan(SITE_LATITUDE * rad) * Math.tan(decl);
  if (cosHa < -1 || cosHa > 1) return null;
  const haDeg = Math.acos(cosHa) / rad;
  const noonUtcMin = 720 - 4 * SITE_LONGITUDE - eqTimeMin;
  const utcMidnight = Date.UTC(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate());
  return {
    sunrise: new Date(utcMidnight + (noonUtcMin - 4 * haDeg) * 60000),
    sunset: new Date(utcMidnight + (noonUtcMin + 4 * haDeg) * 60000),
  };
}

// The solar parameter only gives one number — kWh still expected for the
// rest of today — with no hourly profile. To know how much of that lands
// before a deadline later today, production is modelled as a half-sine
// between sunrise and sunset, and this returns the share of today's
// remaining production that falls between `now` and `until`. A deadline
// after today's sunset (including any deadline tomorrow) gets all of it.
function solarShareBefore(now, until) {
  const sun = sunTimes(now);
  if (!sun) return 1;
  const rise = sun.sunrise.getTime();
  const set = sun.sunset.getTime();
  const from = Math.max(now.getTime(), rise);
  if (until.getTime() >= set || from >= set) return 1;
  if (until.getTime() <= from) return 0;
  // ∫ sin(π·(t-rise)/(set-rise)) dt ∝ -cos(...), so shares are cos differences.
  const cumulative = (t) => -Math.cos((Math.PI * (t - rise)) / (set - rise));
  const total = cumulative(set) - cumulative(from);
  return total > 0 ? (cumulative(until.getTime()) - cumulative(from)) / total : 1;
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
// Conversion losses for a battery charged from the grid: ~10% going in
// (AC -> DC) and ~10% coming back out (DC -> AC). A kWh bought from the grid
// therefore only displaces 0.81 kWh of later grid consumption, so a grid
// charge only pays off when its price is below 81% of the price it avoids.
const CHARGE_EFFICIENCY = 0.9;
const DISCHARGE_EFFICIENCY = 0.9;
const ROUND_TRIP_EFFICIENCY = CHARGE_EFFICIENCY * DISCHARGE_EFFICIENCY;

const average = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

// The price an avoided grid-charge hour is measured against (see
// computeChargePlan below). 'average' treats every other upcoming hour
// equally; 'consumption_weighted' weighs each by `hourlyConsumptionShares`
// (a 24-slot profile from hourlyConsumptionProfile) so hours the household
// actually tends to consume more in — which are often the pricier ones —
// count for more; 'max' simply takes the single highest known price,
// needing no consumption data at all. Falls back to the plain average
// whenever 'consumption_weighted' has nothing to weight with (no profile,
// or every candidate hour happens to carry zero share) or there are no
// points to compare against at all — reported via the `basis` field in its
// result, which is always the mode actually used, after any such fallback.
function computeAvoidedPrice(points, mode, hourlyConsumptionShares) {
  if (points.length === 0) return { price: null, basis: 'average' };

  if (mode === 'max') {
    return { price: Math.max(...points.map((p) => p.price)), basis: 'max' };
  }

  if (mode === 'consumption_weighted' && hourlyConsumptionShares) {
    let weightedSum = 0;
    let weightTotal = 0;
    for (const p of points) {
      const weight = hourlyConsumptionShares[new Date(p.timestamp).getHours()] || 0;
      weightedSum += p.price * weight;
      weightTotal += weight;
    }
    if (weightTotal > 0) return { price: weightedSum / weightTotal, basis: 'consumption_weighted' };
  }

  return { price: average(points.map((p) => p.price)), basis: 'average' };
}

function computeChargePlan({
  capacityKwh,
  targetSocPercent,
  gridTargetSocPercent,
  maxChargePowerKw,
  currentSocPercent,
  solarRemainingKwh,
  avgDailyConsumptionKwh,
  pricePoints,
  targetTime,
  avoidedPriceMode = 'average',
  hourlyConsumptionShares,
  now = new Date(),
}) {
  const neededKwh = Math.max(0, (capacityKwh * (targetSocPercent - currentSocPercent)) / 100);

  const deadline = nextOccurrence(targetTime, now);
  const deadlineAt = deadline ? deadline.toISOString() : null;

  // Solar and household consumption only count up to the deadline when it
  // falls later today: sun that shines after the battery had to be full
  // can't help reach the target in time.
  const endOfDay = new Date(now);
  endOfDay.setHours(24, 0, 0, 0);
  const windowEnd = deadline && deadline < endOfDay ? deadline : endOfDay;
  const solarBeforeDeadlineKwh = (solarRemainingKwh || 0) * (deadline ? solarShareBefore(now, deadline) : 1);
  const remainingHours = Math.max(0, Math.min(24, (windowEnd.getTime() - now.getTime()) / 3600000));
  const expectedConsumptionKwh =
    typeof avgDailyConsumptionKwh === 'number' ? (avgDailyConsumptionKwh * remainingHours) / 24 : 0;
  const netSolarRemainingKwh = Math.max(0, solarBeforeDeadlineKwh - expectedConsumptionKwh);

  // gridTargetSocPercent caps how far the grid may charge, independent of the
  // solar math: once the battery reaches it, the shortfall drops to 0 and
  // the next tick stops charging.
  const gridLimitKwh =
    typeof gridTargetSocPercent === 'number'
      ? Math.max(0, (capacityKwh * (gridTargetSocPercent - currentSocPercent)) / 100)
      : Infinity;
  const shortfallKwh = Math.min(gridLimitKwh, Math.max(0, neededKwh - netSolarRemainingKwh));

  const nowHourMs = floorToHourMs(now);
  const upcoming = pricePoints.filter((p) => {
    const t = new Date(p.timestamp).getTime();
    return t >= nowHourMs && (!deadline || t < deadline.getTime());
  });

  // No eligible hours left (price curve ends, or the deadline is already
  // behind every known hour) must still report the real shortfall — zeroing
  // it here would read as "solar covers it" while the battery stays short.
  if (shortfallKwh <= 0.01 || upcoming.length === 0) {
    const covered = shortfallKwh <= 0.01;
    return {
      neededKwh,
      expectedConsumptionKwh,
      solarBeforeDeadlineKwh,
      netSolarRemainingKwh,
      shortfallKwh: covered ? 0 : shortfallKwh,
      hoursNeeded: 0,
      chargeHours: [],
      upcomingHours: upcoming,
      deadlineAt,
      deadlineFeasible: covered,
    };
  }

  // maxChargePowerKw is drawn from the grid; only 90% of it ends up stored.
  const storedPerHourKwh = maxChargePowerKw * CHARGE_EFFICIENCY;
  const hoursNeeded = Math.min(upcoming.length, Math.ceil(shortfallKwh / storedPerHourKwh));
  const cheapest = [...upcoming].sort((a, b) => a.price - b.price).slice(0, hoursNeeded);

  // The stored energy later replaces grid consumption at "normal" prices:
  // estimated from every other known upcoming hour (the whole forecast, not
  // just up to the deadline — the battery is used afterwards too), either
  // as a plain average or weighted by when the household actually tends to
  // consume — see computeAvoidedPrice. An hour is only worth charging in
  // when its price, grossed up for the round-trip loss, stays below that
  // avoided price.
  const cheapestTimes = new Set(cheapest.map((h) => h.timestamp));
  const otherUpcoming = pricePoints.filter(
    (p) => new Date(p.timestamp).getTime() >= nowHourMs && !cheapestTimes.has(p.timestamp)
  );
  const { price: avoidedPrice, basis: avoidedPriceBasis } = computeAvoidedPrice(
    otherUpcoming,
    avoidedPriceMode,
    hourlyConsumptionShares
  );
  const isProfitable = (h) => avoidedPrice === null || h.price / ROUND_TRIP_EFFICIENCY < avoidedPrice;
  const chargeHours = cheapest
    .filter(isProfitable)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const notProfitable = chargeHours.length === 0;

  const deadlineFeasible = upcoming.length * storedPerHourKwh >= shortfallKwh - 0.01;

  return {
    neededKwh,
    expectedConsumptionKwh,
    solarBeforeDeadlineKwh,
    netSolarRemainingKwh,
    shortfallKwh,
    hoursNeeded,
    chargeHours,
    upcomingHours: upcoming,
    deadlineAt,
    deadlineFeasible,
    roundTripEfficiency: ROUND_TRIP_EFFICIENCY,
    avoidedPrice,
    avoidedPriceBasis,
    // Highest grid price at which charging still pays off.
    breakEvenPrice: avoidedPrice === null ? null : avoidedPrice * ROUND_TRIP_EFFICIENCY,
    notProfitable,
    skippedUnprofitableHours: cheapest.length - chargeHours.length,
  };
}

// Average consumption per hour-of-day (0-23, local time), as a share of the
// lookback window's total (values sum to 1) rather than an absolute kWh —
// used to weight avoidedPrice by when the household actually tends to
// consume, instead of treating every hour of the price curve equally. Mirrors
// averageDailyConsumptionKwh's two sensor-shape cases, just bucketed by
// hour-of-day instead of summed into one daily total. Returns null when
// there isn't enough history (or it adds up to nothing — e.g. a period with
// no usable deltas), so callers fall back to a plain unweighted average.
async function hourlyConsumptionProfile(parameter, days = AVG_CONSUMPTION_LOOKBACK_DAYS) {
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

  const byHour = new Array(24).fill(0);

  if (isCumulativeDaily) {
    // Attribute each reading's rise since the previous one to the hour it
    // was measured in; a fall (the midnight reset) isn't negative
    // consumption, so it's simply skipped.
    for (let i = 1; i < readings.length; i++) {
      const prev = readings[i - 1].value;
      const curr = readings[i].value;
      if (typeof prev !== 'number' || typeof curr !== 'number') continue;
      const delta = curr - prev;
      if (delta > 0) byHour[new Date(readings[i].timestamp).getHours()] += delta;
    }
  } else {
    // Same zero-order-hold reasoning as averageDailyConsumptionKwh, but each
    // gap's energy is split across the hour-of-day buckets it actually
    // spans instead of being summed into one daily total.
    for (let i = 0; i < readings.length; i++) {
      const value = readings[i].value;
      if (typeof value !== 'number') continue;
      let fromMs = new Date(readings[i].timestamp).getTime();
      const toMs = i + 1 < readings.length ? new Date(readings[i + 1].timestamp).getTime() : end.getTime();
      while (fromMs < toMs) {
        const from = new Date(fromMs);
        const hourEnd = new Date(from);
        hourEnd.setMinutes(0, 0, 0);
        hourEnd.setHours(hourEnd.getHours() + 1);
        const segmentEndMs = Math.min(toMs, hourEnd.getTime());
        byHour[from.getHours()] += (value * (segmentEndMs - fromMs)) / 3.6e9;
        fromMs = segmentEndMs;
      }
    }
  }

  const total = byHour.reduce((a, b) => a + b, 0);
  return total > 0 ? byHour.map((v) => v / total) : null;
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

// Same resolution as resolveConsumptionAverage, but for the hourly profile
// computeAvoidedPrice needs in 'consumption_weighted' mode. Only called for
// plans actually using that mode, so a plan left on 'average' never pays for
// this extra Reading scan.
async function resolveHourlyConsumptionShares(consumptionParameter) {
  if (!consumptionParameter) return null;
  const parameter = consumptionParameter._id
    ? consumptionParameter
    : await Parameter.findById(consumptionParameter);
  return parameter ? hourlyConsumptionProfile(parameter) : null;
}

// No real smart-charge session should ever need to run this long —
// capacityKwh / maxChargePowerKw bounds it to a handful of hours for any
// sane plan configuration. Caps a reconstructed ON interval (see
// chargeIntervalsInRange below) at this length, because evaluateAndAct
// never turns a disabled plan's switch off: if a plan got toggled off (or
// the engine couldn't reach HA) while mid-charge, the last logged "on"
// command is simply never followed by an "off" until the plan is re-
// enabled and conditions change — sometimes days or weeks later — which
// would otherwise read as one continuous multi-day charging session.
const MAX_CONTINUOUS_CHARGE_HOURS = 6;

// Reconstructs a plan's actual grid-charging ON/OFF intervals within
// [rangeStart, rangeEnd) from its CommandLog history, rather than from the
// (forward-looking, and never persisted hour-by-hour) chargeHours the
// engine computes at each tick. A contiguous ON period starts at the latest
// successful command that turned charging on — including one issued before
// rangeStart, if it was still on at that point — and ends at the next
// successful command that turns it off, or at `rangeEnd` if it's still
// charging there (each capped at MAX_CONTINUOUS_CHARGE_HOURS — see above).
// Only successful commands count: a failed HA call never actually changed
// the switch's real state. Used both for "today so far" (see
// computeTodaysSavings) and for backfilling arbitrary past days (see
// backfillPlanHistory below).
async function chargeIntervalsInRange(plan, rangeStart, rangeEnd) {
  const isOn = (log) =>
    log.action === 'select_option' ? log.payload?.option === plan.chargeOnOption : log.action === 'turn_on';
  const capped = (start, end) => ({
    start,
    end: new Date(Math.min(end.getTime(), start.getTime() + MAX_CONTINUOUS_CHARGE_HOURS * HOUR_MS)),
  });

  const [before, within] = await Promise.all([
    CommandLog.findOne({ smartChargePlan: plan._id, result: 'success', createdAt: { $lt: rangeStart } })
      .sort({ createdAt: -1 })
      .lean(),
    CommandLog.find({
      smartChargePlan: plan._id,
      result: 'success',
      createdAt: { $gte: rangeStart, $lte: rangeEnd },
    })
      .sort({ createdAt: 1 })
      .lean(),
  ]);

  const intervals = [];
  let onSince = before && isOn(before) ? rangeStart : null;
  for (const log of within) {
    const on = isOn(log);
    if (on && onSince === null) onSince = log.createdAt;
    else if (!on && onSince !== null) {
      intervals.push(capped(onSince, log.createdAt));
      onSince = null;
    }
  }
  if (onSince !== null) intervals.push(capped(onSince, rangeEnd));
  return intervals;
}

// Total hours of overlap between a set of {start, end} intervals and
// [rangeStartMs, rangeEndMs) — used below to find how much of a given
// price hour was actually spent charging.
function overlapHours(intervals, rangeStartMs, rangeEndMs) {
  let hours = 0;
  for (const { start, end } of intervals) {
    const from = Math.max(new Date(start).getTime(), rangeStartMs);
    const to = Math.min(new Date(end).getTime(), rangeEndMs);
    if (to > from) hours += (to - from) / 3600000;
  }
  return hours;
}

// What today's grid-charging actually cost versus what that same amount of
// energy would have cost at the plan's avoidedPrice reference (see
// computeAvoidedPrice) — i.e. what charging during specifically the cheap
// hours saved today, compared to having bought the same kWh at a "normal"
// moment instead. Reuses `forecastPoints` (today's hours are already in
// there via the HA price entity's `prices_today` attribute) rather than
// fetching HA again, and the same `hourlyConsumptionShares` evaluatePlan
// already resolved for its own avoidedPrice calculation. Returns null when
// today's price points aren't known yet (e.g. right after midnight, before
// HA has published them).
async function computeTodaysSavings(plan, forecastPoints, hourlyConsumptionShares) {
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart.getTime() + 24 * 3600000);
  const now = new Date();

  const todaysPoints = forecastPoints.filter((p) => {
    const t = new Date(p.timestamp).getTime();
    return t >= dayStart.getTime() && t < dayEnd.getTime();
  });
  if (todaysPoints.length === 0) return null;

  const intervals = await chargeIntervalsInRange(plan, dayStart, now);

  let totalKwh = 0;
  let actualCostEUR = 0;
  const otherPoints = [];
  for (const p of todaysPoints) {
    const hourStartMs = new Date(p.timestamp).getTime();
    const hoursCharged = overlapHours(intervals, hourStartMs, hourStartMs + 3600000);
    if (hoursCharged > 0) {
      const kwh = hoursCharged * plan.maxChargePowerKw;
      totalKwh += kwh;
      actualCostEUR += kwh * p.price;
    } else {
      otherPoints.push(p);
    }
  }

  const { price: avoidedPrice, basis: avoidedPriceBasis } = computeAvoidedPrice(
    otherPoints,
    plan.avoidedPriceMode,
    hourlyConsumptionShares
  );
  const hypotheticalCostEUR = avoidedPrice === null ? null : totalKwh * avoidedPrice;

  return {
    totalKwh,
    actualCostEUR,
    avoidedPrice,
    avoidedPriceBasis,
    hypotheticalCostEUR,
    savingsEUR: hypotheticalCostEUR === null ? null : hypotheticalCostEUR - actualCostEUR,
  };
}

// A dynamic-prices entity's hourly curve lives entirely in its ATTRIBUTES
// (`prices_today`/`prices_tomorrow` — see priceForecastService.js), not its
// bare numeric state, and HA's long-term statistics only ever track the
// state — so unlike a plain cumulative meter (see costEngine.js), that
// state's recorded history is simply the wrong signal to reconstruct a past
// day's hourly prices from (it may not even change hour to hour). The only
// place that still carries the attributes HA had at a given moment is its
// raw state history, which the recorder purges after HISTORY_RETENTION_MS —
// so a day within that window can still be read back exactly; anything
// older than that genuinely can't be recovered at all. Any snapshot taken
// during `dayStart`'s calendar day carries that whole day's real curve as
// an attribute, so only one is needed — the latest, in case of a late
// correction.
async function historicalDayPriceCurve(client, priceParameter, dayStart) {
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

// Backfills a plan's SmartChargeHistory rows for every complete hour in
// [rangeStartMs, rangeEndMs) — the money-saving counterpart of
// computeTodaysSavings, but persisted so a chart can show it as a trend
// instead of only "today". avoidedPrice is computed per calendar day, scoped
// to that day's other hours — the same scope evaluatePlan uses for "today"
// — so a backfill covering several weeks gets one avoidedPrice per day, not
// one for the whole window. Today's own prices always come live (via
// fetchPriceForecast, the same source evaluatePlan itself uses) rather than
// from history, since it's both the freshest source and the only one that
// works before HA even has a recorded history for today to read back; any
// earlier day is read from HA's raw history while that's still within
// HISTORY_RETENTION_MS, and simply skipped (no rows written) once it isn't
// — there is no way to recover it at that point.
async function backfillPlanHistory(plan, rangeStartMs, rangeEndMs) {
  if (rangeStartMs >= rangeEndMs) return;
  const priceParameter = plan.priceParameter._id
    ? plan.priceParameter
    : await Parameter.findById(plan.priceParameter);
  if (!priceParameter) return;
  const woning = await Woning.findById(plan.woning).select('+haTokenEncrypted');
  if (!woning) return;
  const client = new HaClient({ baseUrl: woning.haBaseUrl, token: decrypt(woning.haTokenEncrypted) });

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayStartMs = todayStart.getTime();
  const earliestRecoverableMs = floorToHourMs(Date.now()) - HISTORY_RETENTION_MS;

  const intervals = await chargeIntervalsInRange(plan, new Date(rangeStartMs), new Date(rangeEndMs));
  const hourlyConsumptionShares =
    plan.avoidedPriceMode === 'consumption_weighted'
      ? await resolveHourlyConsumptionShares(plan.consumptionParameter)
      : null;

  const firstDayStartMs = new Date(rangeStartMs).setHours(0, 0, 0, 0);
  const ops = [];
  for (let dayStartMs = firstDayStartMs; dayStartMs < rangeEndMs; dayStartMs += DAY_MS) {
    let dayPoints;
    if (dayStartMs === todayStartMs) {
      const forecast = await fetchPriceForecast(priceParameter, woning).catch(() => null);
      dayPoints = forecast ? forecast.points : [];
    } else if (dayStartMs < todayStartMs && dayStartMs >= earliestRecoverableMs) {
      dayPoints = await historicalDayPriceCurve(client, priceParameter, new Date(dayStartMs));
    } else {
      dayPoints = []; // future, or past HA's history retention — unrecoverable
    }

    // Clip to the requested range in case it starts or ends mid-day.
    const hours = dayPoints
      .map((p) => ({ hourMs: new Date(p.timestamp).getTime(), price: p.price }))
      .filter((h) => h.hourMs >= rangeStartMs && h.hourMs < rangeEndMs);
    if (hours.length === 0) continue;

    const withCharge = hours.map((h) => ({
      ...h,
      kwh: overlapHours(intervals, h.hourMs, h.hourMs + HOUR_MS) * plan.maxChargePowerKw,
    }));
    const otherPoints = withCharge
      .filter((h) => h.kwh === 0)
      .map((h) => ({ timestamp: new Date(h.hourMs).toISOString(), price: h.price }));
    const { price: avoidedPrice, basis: avoidedPriceBasis } = computeAvoidedPrice(
      otherPoints,
      plan.avoidedPriceMode,
      hourlyConsumptionShares
    );
    for (const h of withCharge) {
      ops.push({
        updateOne: {
          filter: { plan: plan._id, start: new Date(h.hourMs) },
          update: {
            $set: {
              woning: plan.woning,
              gridChargedKwh: h.kwh,
              price: h.price,
              actualCost: h.kwh * h.price,
              avoidedPrice,
              avoidedPriceBasis,
              hypotheticalCost: avoidedPrice === null ? null : h.kwh * avoidedPrice,
            },
          },
          upsert: true,
        },
      });
    }
  }
  if (ops.length > 0) await SmartChargeHistory.bulkWrite(ops, { ordered: false });
}

// How far back a plan's history is (re)built from scratch the first time it
// backfills — far enough for a month-view trend chart, without hammering HA
// for statistics going back further than anyone's likely to look.
const HISTORY_LOOKBACK_DAYS = 32;
// Recomputes this much of the most recently-backfilled time on every tick
// too, so CommandLog entries or price statistics that arrived late still
// end up recorded against the right hour.
const HISTORY_RECOMPUTE_OVERLAP_MS = 3 * HOUR_MS;
// A few minutes past each quarter, same cadence as the cost engine but
// offset from it so the two don't contend for the same tick.
const HISTORY_TICK_CRON = '7,22,37,52 * * * *';

/**
 * Periodically backfills every SmartChargePlan's SmartChargeHistory —
 * independent of SmartChargeEngine's own 10-minute tick, which only decides
 * and acts on the live recommendation and never persists anything per hour.
 * Mirrors CostEngine's shape (per-plan compute/recompute, one in-flight
 * computation at a time per plan) since both are "catch up stored history"
 * jobs over HA data that may arrive late.
 */
class SmartChargeHistoryEngine {
  constructor() {
    this.task = null;
    this.running = new Map();
  }

  start() {
    if (this.task) return;
    this.task = cron.schedule(HISTORY_TICK_CRON, () => {
      this.tick().catch((err) => console.error('Smart charge history tick failed:', err));
    });
    this.tick().catch((err) => console.error('Smart charge history initial tick failed:', err));
  }

  stop() {
    this.task?.stop();
    this.task = null;
  }

  // Every plan, not just enabled ones — a disabled plan's past charging
  // (from when it was enabled) is still meaningful history to show.
  async tick() {
    const plans = await SmartChargePlan.find({}).populate(['priceParameter', 'consumptionParameter']);
    for (const plan of plans) {
      await this.backfill(plan).catch((err) =>
        console.error(`Smart charge history backfill failed for plan ${plan._id}:`, err.message)
      );
    }
  }

  backfill(plan) {
    const id = plan._id.toString();
    if (this.running.has(id)) return this.running.get(id);
    const promise = (async () => {
      const latest = await SmartChargeHistory.findOne({ plan: plan._id }).sort({ start: -1 }).select('start').lean();
      const earliestAllowedMs = floorToHourMs(Date.now()) - HISTORY_LOOKBACK_DAYS * DAY_MS;
      const rangeStartMs = latest
        ? Math.max(earliestAllowedMs, latest.start.getTime() - HISTORY_RECOMPUTE_OVERLAP_MS)
        : earliestAllowedMs;
      const rangeEndMs = floorToHourMs(Date.now());
      await backfillPlanHistory(plan, rangeStartMs, rangeEndMs);
    })().finally(() => this.running.delete(id));
    this.running.set(id, promise);
    return promise;
  }

  /** Throws away a plan's backfilled history and rebuilds it from scratch. */
  async recompute(planId) {
    await this.running.get(planId.toString());
    await SmartChargeHistory.deleteMany({ plan: planId });
    const plan = await SmartChargePlan.findById(planId).populate(['priceParameter', 'consumptionParameter']);
    if (plan) await this.backfill(plan);
  }
}

const smartChargeHistoryEngine = new SmartChargeHistoryEngine();

// Gathers a plan's live inputs (current SOC, remaining solar forecast, price
// curve) and runs them through computeChargePlan. Shared by the read-only
// status endpoint (a user looking at the recommendation) and the engine's
// own tick (deciding whether to act) — both need exactly the same
// computation, just with different consumers of the result.
async function evaluatePlan(plan) {
  const [socValue, solarValue, woning, avgDailyConsumptionKwh, hourlyConsumptionShares] = await Promise.all([
    latestValue(plan.socParameter._id || plan.socParameter),
    latestValue(plan.solarRemainingParameter._id || plan.solarRemainingParameter),
    Woning.findById(plan.woning).select('+haTokenEncrypted'),
    resolveConsumptionAverage(plan.consumptionParameter),
    plan.avoidedPriceMode === 'consumption_weighted'
      ? resolveHourlyConsumptionShares(plan.consumptionParameter)
      : null,
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

  // An entity that went `unavailable` in HA still fetches fine, just without
  // its price attributes — treat an empty curve like a failed fetch.
  const hasPrices = forecast && forecast.points.length > 0;

  if (currentSocPercent === null || solarRemainingKwh === null || !hasPrices) {
    return {
      ready: false,
      reason:
        currentSocPercent === null
          ? 'Geen actuele meting voor de SOC-parameter'
          : solarRemainingKwh === null
          ? 'Geen actuele meting voor de zon-forecast-parameter'
          : !forecast
          ? 'Prijsdata ophalen bij Home Assistant mislukt'
          : 'Geen uurprijzen beschikbaar — de prijzensensor in Home Assistant is onbeschikbaar',
      currentSocPercent,
      solarRemainingKwh,
    };
  }

  const plan_ = computeChargePlan({
    capacityKwh: plan.capacityKwh,
    targetSocPercent: plan.targetSocPercent,
    gridTargetSocPercent: plan.gridTargetSocPercent,
    maxChargePowerKw: plan.maxChargePowerKw,
    currentSocPercent,
    solarRemainingKwh,
    avgDailyConsumptionKwh,
    pricePoints: forecast.points,
    targetTime: plan.targetTime,
    avoidedPriceMode: plan.avoidedPriceMode,
    hourlyConsumptionShares,
  });

  const nowHourMs = floorToHourMs(new Date());
  const shouldChargeNow = plan_.chargeHours.some((h) => new Date(h.timestamp).getTime() === nowHourMs);
  const todaySavings = await computeTodaysSavings(plan, forecast.points, hourlyConsumptionShares);

  return {
    ready: true,
    currentSocPercent,
    solarRemainingKwh,
    avgDailyConsumptionKwh,
    priceUnit: forecast.unit,
    gridTargetSocPercent: plan.gridTargetSocPercent ?? null,
    shouldChargeNow,
    todaySavings,
    ...plan_,
  };
}

// Translates "charge from the grid now: yes/no" into the HA service call for
// the plan's chargeSwitchParameter — turn_on/turn_off for a switch, or
// select_option with the plan's configured on/off option for a select_mode
// parameter. `targetValue` is the state HA reports once the call took
// effect, so the caller can skip calls that wouldn't change anything.
function chargeCommand(plan, chargeNow) {
  const parameter = plan.chargeSwitchParameter;
  const domain = parameter.controlDomain || parameter.entityId.split('.')[0];

  if (parameter.type === 'select_mode') {
    const option = chargeNow ? plan.chargeOnOption : plan.chargeOffOption;
    if (!option) {
      return { error: 'Kies voor de regelmodus welke optie "laden" en welke "niet laden" is' };
    }
    return {
      isSelect: true,
      domain,
      service: 'select_option',
      serviceData: { entity_id: parameter.entityId, option },
      targetValue: option,
    };
  }

  return {
    isSelect: false,
    domain,
    service: chargeNow ? 'turn_on' : 'turn_off',
    serviceData: { entity_id: parameter.entityId },
    targetValue: chargeNow ? 'on' : 'off',
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
    const command = chargeCommand(plan, status.shouldChargeNow);
    if (command.error) {
      plan.lastError = command.error;
      await plan.save();
      return status;
    }

    const currentValue = await latestValue(switchParameter._id);
    // A select's "off" option is only (re)applied while it's still sitting
    // in the charge option: any other mode (e.g. discharging to the grid)
    // was chosen by someone else on purpose, and the plan has no business
    // overriding it outside its own charge hours.
    const inSync = command.isSelect
      ? currentValue === command.targetValue ||
        (!status.shouldChargeNow && currentValue !== plan.chargeOnOption)
      : currentValue === command.targetValue;

    if (inSync) {
      plan.lastAction = status.shouldChargeNow ? 'on' : 'off';
      await plan.save();
      return status;
    }

    const desiredOn = status.shouldChargeNow;
    let result = 'success';
    let errorMessage;
    try {
      const client = haConnectionManager.getClient(plan.woning);
      if (!client) throw new Error('Home Assistant connection not available');

      await client.callService(command.domain, command.service, command.serviceData);
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
      action: command.service,
      payload: command.isSelect ? { option: command.targetValue } : undefined,
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
  smartChargeHistoryEngine,
  SmartChargeHistoryEngine,
  computeChargePlan,
  evaluatePlan,
  averageDailyConsumptionKwh,
  hourlyConsumptionProfile,
  computeTodaysSavings,
  chargeIntervalsInRange,
  backfillPlanHistory,
  historicalDayPriceCurve,
  SMART_CHARGE_POPULATE_PATHS: [
    'socParameter',
    'solarRemainingParameter',
    'consumptionParameter',
    'priceParameter',
    'chargeSwitchParameter',
  ],
};
