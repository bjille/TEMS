// The periods a chart can show: a calendar period (day, week, month, year —
// like Home Assistant's energy dashboard), or a rolling window ending now.
// Encoded as one select value — 'day' / 'week' / 'month' / 'year', or the
// hour count for a rolling window — and stored on a DashboardChart as
// `rangePeriod` (+ `rangeHours` for 'rolling').
export const CALENDAR_PERIODS = ['day', 'week', 'month', 'year'];

export const RANGE_OPTIONS = [
  { value: 'day', label: 'Vandaag' },
  { value: 'week', label: 'Deze week' },
  { value: 'month', label: 'Deze maand' },
  { value: 'year', label: 'Dit jaar' },
  { value: '24', label: 'Laatste 24 uur' },
  { value: '168', label: 'Laatste 7 dagen' },
  { value: '720', label: 'Laatste 30 dagen' },
];

const DAY_MS = 24 * 3600 * 1000;

export function isCalendarPeriod(value) {
  return CALENDAR_PERIODS.includes(value);
}

export function rangeValue(chart) {
  return isCalendarPeriod(chart.rangePeriod) ? chart.rangePeriod : String(chart.rangeHours);
}

// The { rangeHours, rangePeriod } fields for a select value.
export function rangeFields(value) {
  if (isCalendarPeriod(value)) return { rangePeriod: value };
  return { rangePeriod: 'rolling', rangeHours: Number(value) };
}

export function rangeLabel(chart) {
  const value = rangeValue(chart);
  return RANGE_OPTIONS.find((r) => r.value === value)?.label || `${chart.rangeHours}u`;
}

// Start of the calendar `period` containing `date` (weeks start on Monday).
export function periodStart(period, date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  if (period === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  if (period === 'month') d.setDate(1);
  if (period === 'year') d.setMonth(0, 1);
  return d;
}

// `date` moved by `n` calendar periods.
export function shiftPeriod(period, date, n) {
  const d = new Date(date);
  if (period === 'day') d.setDate(d.getDate() + n);
  if (period === 'week') d.setDate(d.getDate() + 7 * n);
  if (period === 'month') d.setMonth(d.getMonth() + n, 1);
  if (period === 'year') d.setFullYear(d.getFullYear() + n);
  return d;
}

// { from, to } of the calendar `period` containing `anchor`.
export function periodWindow(period, anchor) {
  const from = periodStart(period, anchor);
  return { from, to: shiftPeriod(period, from, 1) };
}

// A window's size, which picks the bucket size: 'short' (≤ 1 day), 'medium'
// (≤ about two months) or 'year'.
function withKind({ from, to }) {
  const hours = Math.round((to - from) / 3600000);
  return { from, to, hours, kind: hours <= 25 ? 'short' : hours <= 24 * 62 ? 'medium' : 'year' };
}

/**
 * The concrete window a chart covers: `from`/`to` (a calendar period runs to
 * its end, so what's still to come shows as empty slots), `hours` and
 * `kind`. An explicit `chart.window` ({ from, to }, set by the detail page
 * when browsing to another day or choosing a custom range) wins; otherwise
 * the chart's own period, around today.
 */
export function chartRange(chart) {
  if (chart.window) return withKind(chart.window);
  if (isCalendarPeriod(chart.rangePeriod)) return withKind(periodWindow(chart.rangePeriod, new Date()));
  const hours = chart.rangeHours || 24;
  const now = new Date();
  return withKind({ from: new Date(now.getTime() - hours * 3600 * 1000), to: now });
}

/**
 * The comparison window of a chart (`chart.compareWindow`, same length as
 * the main one, set by the detail page), with `offsetMs`: how far its
 * points must shift to line up with the main window's — or null.
 */
export function compareRange(chart) {
  if (!chart.compareWindow) return null;
  const main = chartRange(chart);
  const from = new Date(chart.compareWindow.from);
  const to = new Date(chart.compareWindow.to);
  return { from, to, offsetMs: main.from.getTime() - from.getTime() };
}

const fmt = (date, options) => date.toLocaleDateString('nl-BE', options);

// Human title of a window, e.g. "wo 22 okt 2026", "20 – 26 okt 2026",
// "oktober 2026", "2026".
export function windowTitle({ from, to }) {
  const last = new Date(to.getTime() - 1);
  const days = Math.round((to - from) / DAY_MS);
  const wholeDays = from.getHours() === 0 && from.getMinutes() === 0;
  if (wholeDays && from.getMonth() === 0 && from.getDate() === 1 && days >= 365 && days <= 366) {
    return String(from.getFullYear());
  }
  if (wholeDays && from.getDate() === 1 && last.getMonth() === from.getMonth() && last.getDate() >= 28) {
    return fmt(from, { month: 'long', year: 'numeric' });
  }
  if (wholeDays && days === 1) return fmt(from, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const sameYear = from.getFullYear() === last.getFullYear();
  return `${fmt(from, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) })} – ${fmt(last, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })}`;
}

// "YYYY-MM-DD" for an <input type="date">, in local time.
export function toDateInput(date) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Local midnight of an <input type="date"> value.
export function fromDateInput(value) {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d);
}
