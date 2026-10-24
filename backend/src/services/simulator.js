const MINUTE_MS = 60 * 1000;

// Realistic but made-up values for a simulated woning (see Woning.simulated):
// a whole local day is simulated minute by minute — solar production along
// the sun's real path over Belgium, appliances with their own usage
// patterns, a home battery that stores the surplus and covers the shortfall,
// and the grid balancing the rest. Deterministic per day (seeded by the
// date), so every visitor and every refresh sees the same day unfold.

// --- deterministic noise -------------------------------------------------

function hashString(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// A pseudo-random number in [0, 1) for a given seed.
function rand(seed) {
  let t = (seed + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const randFor = (...parts) => rand(hashString(parts.join('|')));

// Smooth noise in [-1, 1] over the minutes of a day: a few seeded sines.
function smoothNoise(seed, minute) {
  let v = 0;
  for (let k = 1; k <= 3; k++) {
    const phase = randFor(seed, 'phase', k) * 2 * Math.PI;
    v += Math.sin((minute / (90 / k)) * 2 * Math.PI * 0.25 + phase) / k;
  }
  return v / 1.83;
}

// --- calendar helpers ----------------------------------------------------

function localMidnight(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function dayOfYear(date) {
  const start = new Date(date.getFullYear(), 0, 1);
  return Math.round((localMidnight(date) - start) / (24 * 3600 * 1000)) + 1;
}

// --- appliance profiles --------------------------------------------------

// Each profile returns the power (W) at minute `m` (0 = local midnight) of
// a day; `ctx` carries that day's seed and calendar facts.
const on = (m, start, minutes) => m >= start && m < start + minutes;
const at = (h, min = 0) => h * 60 + min;

// Compressor-style cycling: on for `onMin` of every `periodMin`.
function cycling(m, seed, periodMin, onMin, watts, idle) {
  const offset = Math.floor(randFor(seed, 'offset') * periodMin);
  return (m + offset) % periodMin < onMin ? watts * (0.95 + 0.1 * randFor(seed, m)) : idle;
}

const PROFILES = [
  { match: /diepvries/i, power: (m, c) => cycling(m, c.seed, 70, 22, 95, 1.5) },
  { match: /frigo|koelkast/i, power: (m, c) => cycling(m, c.seed, 50, 16, 80, 1.5) },
  {
    match: /koffie/i,
    power: (m, c) => {
      const morning = c.weekend ? at(8, 40) : at(6, 55);
      if (on(m, morning, 4) || on(m, at(13, 15), 3) || (c.weekend && on(m, at(15, 30), 3))) return 1350;
      return 0.8;
    },
  },
  {
    match: /microgolf/i,
    power: (m) => (on(m, at(12, 20), 3) || on(m, at(18, 50), 4) ? 1150 : 1.2),
  },
  {
    match: /oven/i,
    power: (m, c) => {
      if (randFor(c.seed, 'used') > 0.45) return 0.5;
      if (!on(m, at(17, 50), 55)) return 0.5;
      return (m - at(17, 50)) % 6 < 4 ? 2100 : 40;
    },
  },
  {
    match: /fornuis|kookplaat/i,
    power: (m, c) => {
      if (randFor(c.seed, 'used') > 0.85) return 0;
      if (!on(m, at(18, 5), 40)) return 0;
      return (m - at(18, 5)) % 4 < 2 ? 1800 : 300;
    },
  },
  {
    match: /wasmachine/i,
    power: (m, c) => {
      if (!c.washDay) return 0.6;
      const t = m - c.washStart;
      if (t < 0 || t >= 95) return 0.6;
      if (t < 18) return 2000;
      if (t >= 80) return 420;
      return 180 + 40 * Math.sin(t);
    },
  },
  {
    match: /droogkast|droger/i,
    power: (m, c) => {
      if (!c.washDay || randFor(c.seed, 'dry') > 0.7) return 0.4;
      const t = m - (c.washStart + 110);
      return t >= 0 && t < 120 ? 620 + 80 * Math.sin(t / 3) : 0.4;
    },
  },
  {
    match: /vaatwas/i,
    power: (m) => {
      const t = m - at(20, 30);
      if (t < 0 || t >= 130) return 0.5;
      if (t < 22 || (t >= 95 && t < 110)) return 1850;
      return 45;
    },
  },
  {
    match: /\btv\b|televisie/i,
    power: (m, c) => (on(m, at(19, 30), 210) || (c.weekend && on(m, at(14, 0), 150)) ? 105 + 15 * smoothNoise(c.seed, m) : 0.7),
  },
  {
    match: /bureau|computer|\bpc\b/i,
    power: (m, c) => (!c.weekend && on(m, at(8, 30), 510) ? 125 + 35 * smoothNoise(c.seed, m) : 6),
  },
  {
    match: /warmtepompboiler/i,
    power: (m, c) => (on(m, at(11, 0), 240) && randFor(c.seed, 'wp') < 0.85 ? 470 + 30 * smoothNoise(c.seed, m) : 4),
  },
  {
    match: /boiler/i,
    power: (m, c) => (on(m, at(7, 30), 12) || on(m, at(13, 0), 8) || on(m, at(19, 15), 14) ? 2000 : cycling(m, c.seed, 240, 5, 2000, 0)),
  },
  {
    match: /cv|ketel/i,
    power: (m, c) => {
      if (!c.heatingSeason) return 4;
      if (on(m, at(6, 0), 150) || on(m, at(16, 30), 330)) return (m + Math.floor(c.seedFraction * 20)) % 20 < 13 ? 115 : 30;
      return 4;
    },
  },
  {
    match: /fiets/i,
    power: (m, c) => (c.bikeDay && on(m, at(20, 0), 200) ? 140 : 0.3),
  },
];

// An appliance without a recognisable name: a small, slowly varying load.
function genericPower(m, c, label) {
  const base = 15 + 45 * randFor(label, 'base');
  return Math.max(0, base + base * 0.3 * smoothNoise(`${c.seed}|${label}`, m));
}

function powerFn(label) {
  const profile = PROFILES.find((p) => p.match.test(label));
  return profile ? profile.power : (m, c) => genericPower(m, c, label);
}

// --- the house -----------------------------------------------------------

const PV_PEAK_W = 6200;
const BATTERY_KWH = 15;
const BATTERY_MAX_W = 5000;
const BATTERY_MIN_SOC = 0.1;
// Smart charging: on a day the sun won't cover the house, the battery tops
// up from the grid in the cheap night hours, so the day runs on the battery.
const GRID_CHARGE_FROM = at(1, 30);
const GRID_CHARGE_UNTIL = at(5, 30);
const GRID_CHARGE_SOC = 0.95;
const BASE_LOAD_W = 140; // what no individual appliance meter covers

// Solar output (W) per minute of the day: the sun's elevation over Brussels
// (solar noon ≈ 11:43 UTC) shaped by the season, times that day's cloud cover.
function solarCurve(dayStart, minutes, seed) {
  const doy = dayOfYear(dayStart);
  const dayLengthH = 12 + 4.2 * Math.sin((2 * Math.PI * (doy - 80)) / 365);
  const noonMin = 11 * 60 + 43 - dayStart.getTimezoneOffset();
  const halfDay = (dayLengthH * 60) / 2;
  const seasonal = 0.35 + 0.65 * Math.max(0, Math.sin((2 * Math.PI * (doy - 80)) / 365 + Math.PI / 2.6));
  const clouds = 0.25 + 0.75 * randFor(seed, 'clouds'); // 1 = clear sky
  const curve = new Array(minutes).fill(0);
  for (let m = 0; m < minutes; m++) {
    const x = (m - noonMin) / halfDay;
    if (Math.abs(x) >= 1) continue;
    const elevation = Math.cos((x * Math.PI) / 2) ** 1.6;
    const passingClouds = 1 - (1 - clouds) * (0.5 + 0.5 * smoothNoise(`${seed}|wolk`, m));
    curve[m] = PV_PEAK_W * seasonal * elevation * Math.min(1, passingClouds);
  }
  return curve;
}

// Gas use (m³) per minute: a central heating with a night setback and
// morning/evening comfort periods in the heating season, plus hot water for
// showers and the dishes all year round.
function gasCurve(minutes, ctx) {
  const curve = new Array(minutes).fill(0);
  if (ctx.heatingSeason) {
    const dailyM3 = 3.5 + 3 * randFor(ctx.seed, 'gas');
    let total = 0;
    for (let m = 0; m < minutes; m++) {
      const h = m / 60;
      const comfort =
        h < 6 ? 0.15 : h < 9 ? 1.6 : h < 17 ? (ctx.weekend ? 0.9 : 0.55) : h < 22.5 ? 1.2 : 0.3;
      // The burner modulates and cycles rather than burning evenly.
      curve[m] = comfort * (0.6 + 0.4 * (smoothNoise(`${ctx.seed}|ketel`, m * 4) + 1));
      total += curve[m];
    }
    for (let m = 0; m < minutes; m++) curve[m] *= dailyM3 / total;
  }
  const shower = at(6, 45) + Math.floor(randFor(ctx.seed, 'douche') * 60);
  for (let m = shower; m < shower + 12 && m < minutes; m++) curve[m] += 0.022;
  for (let m = at(20, 15); m < at(20, 25); m++) curve[m] += 0.008;
  return curve;
}

const dayCache = new Map();

/**
 * The simulated local day starting at `dayStart`, minute by minute:
 * { start, minutes, devices: { label: W[] }, thuis, pv, batteryRaw (W,
 * > 0 = charging), soc (%), grid (W, > 0 = import), and running kWh
 * totals pvToday, importToday, exportToday, thuisToday, the running m³
 * gasToday, plus pvForecastKwh }.
 */
function simulateDay(dayStart, deviceLabels) {
  const key = `${dayStart.getTime()}|${deviceLabels.join(',')}`;
  if (dayCache.has(key)) return dayCache.get(key);

  const seed = `dag-${dayStart.getFullYear()}-${dayStart.getMonth() + 1}-${dayStart.getDate()}`;
  const nextDay = new Date(dayStart);
  nextDay.setDate(nextDay.getDate() + 1);
  const minutes = Math.round((nextDay - dayStart) / MINUTE_MS);
  const month = dayStart.getMonth();
  const ctx = {
    seed,
    seedFraction: randFor(seed, 'fraction'),
    weekend: dayStart.getDay() === 0 || dayStart.getDay() === 6,
    heatingSeason: month >= 9 || month <= 3,
    washDay: randFor(seed, 'was') < 0.45,
    washStart: at(9, 30) + Math.floor(randFor(seed, 'wasstart') * 180),
    bikeDay: randFor(seed, 'fiets') < 0.4,
  };

  const devices = {};
  for (const label of deviceLabels) {
    const fn = powerFn(label);
    const series = new Array(minutes);
    for (let m = 0; m < minutes; m++) series[m] = Math.max(0, fn(m, { ...ctx, seed: `${seed}|${label}` }));
    devices[label] = series;
  }

  const pv = solarCurve(dayStart, minutes, seed);
  const gas = gasCurve(minutes, ctx);
  const day = {
    start: dayStart,
    minutes,
    devices,
    pv,
    thuis: new Array(minutes),
    batteryRaw: new Array(minutes),
    soc: new Array(minutes),
    grid: new Array(minutes),
    pvToday: new Array(minutes),
    importToday: new Array(minutes),
    exportToday: new Array(minutes),
    thuisToday: new Array(minutes),
    gasToday: new Array(minutes),
    pvForecastKwh: 0,
  };
  let gasM3 = 0;
  for (let m = 0; m < minutes; m++) {
    gasM3 += gas[m];
    day.gasToday[m] = gasM3;
  }

  const thuisLoad = new Array(minutes);
  let pvTotal = 0;
  let thuisTotal = 0;
  for (let m = 0; m < minutes; m++) {
    let thuis = BASE_LOAD_W * (1 + 0.15 * smoothNoise(`${seed}|basis`, m));
    for (const label of deviceLabels) thuis += devices[label][m];
    thuisLoad[m] = thuis;
    pvTotal += pv[m];
    thuisTotal += thuis;
  }
  const gridCharging = pvTotal < thuisTotal * 1.3;

  // What the battery has left from the evening before.
  let socKwh = BATTERY_KWH * (0.45 + 0.15 * randFor(seed, 'soc'));
  let pvKwh = 0;
  let importKwh = 0;
  let exportKwh = 0;
  let thuisKwh = 0;
  let gridChargeDone = false;
  for (let m = 0; m < minutes; m++) {
    const thuis = thuisLoad[m];
    const surplus = pv[m] - thuis;
    // kWh × 60000 = the power (W) that moves that much energy in a minute.
    const topUp = BATTERY_KWH * GRID_CHARGE_SOC - socKwh;
    // Charging stops once the target is reached, rather than topping up
    // again with every bit the house draws.
    if (topUp <= 0.001) gridChargeDone = true;
    const battery =
      gridCharging && !gridChargeDone && m >= GRID_CHARGE_FROM && m < GRID_CHARGE_UNTIL
        ? Math.min(BATTERY_MAX_W * 0.7, topUp * 60000)
        : surplus > 0
          ? Math.min(surplus, BATTERY_MAX_W, (BATTERY_KWH - socKwh) * 60000)
          : -Math.min(-surplus, BATTERY_MAX_W, Math.max(0, socKwh - BATTERY_KWH * BATTERY_MIN_SOC) * 60000);
    socKwh = Math.min(BATTERY_KWH, Math.max(0, socKwh + battery / 60000));
    const grid = thuis - pv[m] + battery;

    pvKwh += pv[m] / 60000;
    thuisKwh += thuis / 60000;
    if (grid > 0) importKwh += grid / 60000;
    else exportKwh -= grid / 60000;

    day.thuis[m] = thuis;
    day.batteryRaw[m] = battery;
    day.soc[m] = (socKwh / BATTERY_KWH) * 100;
    day.grid[m] = grid;
    day.pvToday[m] = pvKwh;
    day.importToday[m] = importKwh;
    day.exportToday[m] = exportKwh;
    day.thuisToday[m] = thuisKwh;
  }
  day.pvForecastKwh = pvKwh * (0.9 + 0.2 * randFor(seed, 'voorspelling'));

  dayCache.set(key, day);
  if (dayCache.size > 8) dayCache.delete(dayCache.keys().next().value);
  return day;
}

// --- prices --------------------------------------------------------------

// A typical day-ahead curve (€/kWh, all-in): cheap at night and around
// noon (solar), expensive in the morning and evening peaks.
function syntheticPrice(date) {
  const h = date.getHours() + date.getMinutes() / 60;
  const seed = `prijs-${localMidnight(date).getTime()}`;
  const level = 0.22 + 0.04 * (randFor(seed, 'niveau') - 0.5);
  const morning = 0.07 * Math.exp(-((h - 8) ** 2) / 3);
  const evening = 0.1 * Math.exp(-((h - 19) ** 2) / 4);
  const solarDip = -0.08 * Math.exp(-((h - 13.5) ** 2) / 6);
  const night = -0.03 * Math.exp(-((h - 3.5) ** 2) / 5);
  return Math.round((level + morning + evening + solarDip + night + 0.01 * randFor(seed, date.getHours())) * 1000) / 1000;
}

// --- per parameter -------------------------------------------------------

// Which simulated signal a parameter shows, from its type, unit and label —
// the simulated woning's parameters are copies of a real woning's, so the
// same shapes come back.
function signalFor(parameter) {
  const unit = String(parameter.unit || '').trim().toLowerCase();
  const label = parameter.label || '';
  switch (parameter.type) {
    case 'solar_power':
      if (/resterend|remaining/i.test(label)) return 'pvRemaining';
      if (/geschat|forecast|voorspel/i.test(label)) return 'pvForecast';
      return unit === 'kwh' ? 'pvToday' : 'pv';
    case 'battery_soc':
      return 'soc';
    case 'battery_power':
    case 'ev_charger_power':
      return 'batteryRaw';
    case 'grid_power':
      if (/piek/i.test(label)) return 'peak';
      if (unit === 'kwh') return /gestoken|export|terug/i.test(label) ? 'exportToday' : 'importToday';
      return 'grid';
    case 'energy_consumption':
    case 'custom':
      if (unit === 'kwh') return 'thuisToday';
      if (unit === 'm3' || unit === 'm³') return 'gasMeter';
      if (/thuisverbruik|totaal verbruik/i.test(label)) return 'thuis';
      return unit === 'w' || unit === 'kw' ? 'device' : 'constant';
    case 'electricity_price':
      return 'electricityPrice';
    case 'gas_price':
      return 'gasPrice';
    case 'select_mode':
      return 'select';
    case 'number_controllable':
      return 'number';
    case 'switch_controllable':
    case 'switch_consumer':
      return 'switch';
    default:
      return 'constant';
  }
}

/** The appliance labels whose power is part of "Thuis" for these parameters. */
function deviceLabelsOf(parameters) {
  return [...new Set(parameters.filter((p) => signalFor(p) === 'device').map((p) => p.label))].sort();
}

/**
 * Value of `parameter` at `date` (already inverted when the parameter is),
 * rounded the way a sensor would report it. `priceAt(parameter, date)` may
 * supply a real market price; null falls back to a typical curve.
 */
function simulatedValue(parameter, date, deviceLabels, priceAt) {
  const signal = signalFor(parameter);
  const unit = String(parameter.unit || '').trim().toLowerCase();
  const sign = parameter.invert ? -1 : 1;
  const day = simulateDay(localMidnight(date), deviceLabels);
  const m = Math.min(day.minutes - 1, Math.max(0, Math.floor((date - day.start) / MINUTE_MS)));
  const watts = (w) => (unit === 'kw' ? Math.round(w * sign) / 1000 : Math.round(w * sign));
  const kwh = (v) => Math.round(v * 100) / 100;

  switch (signal) {
    case 'pv':
      return watts(day.pv[m]);
    case 'pvToday':
      return kwh(day.pvToday[m]);
    case 'pvForecast':
      return kwh(day.pvForecastKwh);
    case 'pvRemaining':
      return kwh(Math.max(0, day.pvForecastKwh - day.pvToday[m]));
    case 'soc':
      return Math.round(day.soc[m]);
    case 'batteryRaw':
      return watts(day.batteryRaw[m]);
    case 'grid':
      return watts(day.grid[m]);
    case 'peak':
      return Math.round(2800 + 900 * randFor(`piek-${date.getFullYear()}-${date.getMonth()}`, 'piek'));
    case 'importToday':
      return kwh(day.importToday[m]);
    case 'exportToday':
      return kwh(day.exportToday[m]);
    case 'thuisToday':
      return kwh(day.thuisToday[m]);
    case 'thuis':
      return watts(day.thuis[m]);
    case 'device':
      return watts(day.devices[parameter.label]?.[m] ?? 0);
    case 'gasMeter': {
      // A meter total that keeps rising: a fixed amount per day (more than
      // any day uses) plus today's use so far.
      const days = Math.floor(day.start.getTime() / (24 * 3600 * 1000));
      return Math.round((3200 + (days - 20000) * 8 + day.gasToday[m]) * 1000) / 1000;
    }
    case 'electricityPrice':
      return priceAt?.(parameter, date) ?? syntheticPrice(date);
    case 'gasPrice':
      return 0.089;
    case 'select':
      return parameter.options?.[0] ?? 'auto';
    case 'number':
      return /limiet|capaciteit/i.test(parameter.label) ? 2500 : 50;
    case 'switch': {
      const device = deviceLabels.find((l) => parameter.label.toLowerCase().startsWith(l.toLowerCase().split(' ')[0]));
      return device && (day.devices[device]?.[m] ?? 0) > 5 ? 'on' : 'off';
    }
    default:
      return 0;
  }
}

/** The day-ahead price curve for `date`'s day and the next: [{ timestamp, price }]. */
function simulatedPriceCurve(parameter, date, priceAt) {
  const start = localMidnight(date);
  const points = [];
  for (let d = new Date(start); points.length < 48; d.setHours(d.getHours() + 1)) {
    points.push({ timestamp: d.toISOString(), price: priceAt?.(parameter, d) ?? syntheticPrice(d) });
  }
  return points;
}

// The running total behind each counter signal, in the counter's own unit.
const COUNTER_TOTALS = {
  pvToday: 'pvToday',
  importToday: 'importToday',
  exportToday: 'exportToday',
  thuisToday: 'thuisToday',
  gasMeter: 'gasToday',
};

/**
 * How much the counter `parameter` rose over [from, to), both within one
 * local day — what a cost calculation multiplies by the price. 0 for a
 * parameter that isn't a counter.
 */
function simulatedMeterRise(parameter, from, to, deviceLabels) {
  const key = COUNTER_TOTALS[signalFor(parameter)];
  if (!key) return 0;
  const day = simulateDay(localMidnight(from), deviceLabels);
  const minuteOf = (d) => Math.min(day.minutes, Math.max(0, Math.round((d - day.start) / MINUTE_MS)));
  // Use over the first `m` minutes of the day.
  const usedBefore = (m) => (m > 0 ? day[key][m - 1] : 0);
  return Math.max(0, usedBefore(minuteOf(to)) - usedBefore(minuteOf(from)));
}

module.exports = {
  simulatedValue,
  simulatedPriceCurve,
  simulatedMeterRise,
  deviceLabelsOf,
  signalFor,
  simulateDay,
  localMidnight,
};
