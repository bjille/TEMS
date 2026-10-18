// The periods a chart can show: a rolling window ending now, or an overview
// of the current calendar month / year. Encoded as one select value — the
// hour count for a rolling window, or 'month' / 'year' — and stored on a
// DashboardChart as `rangeHours` + `rangePeriod`.
export const RANGE_OPTIONS = [
  { value: '24', label: '24 uur' },
  { value: '168', label: '7 dagen' },
  { value: '720', label: '30 dagen' },
  { value: 'month', label: 'Deze maand' },
  { value: 'year', label: 'Dit jaar' },
];

export function rangeValue(chart) {
  return chart.rangePeriod === 'month' || chart.rangePeriod === 'year'
    ? chart.rangePeriod
    : String(chart.rangeHours);
}

// The { rangeHours, rangePeriod } fields for a select value.
export function rangeFields(value) {
  if (value === 'month' || value === 'year') return { rangePeriod: value };
  return { rangePeriod: 'rolling', rangeHours: Number(value) };
}

export function rangeLabel(chart) {
  const value = rangeValue(chart);
  return RANGE_OPTIONS.find((r) => r.value === value)?.label || `${chart.rangeHours}u`;
}

/**
 * The concrete window a chart covers right now: `from`/`to` (a calendar
 * period runs to its end, so the rest of the month/year shows as empty
 * slots) and `kind` — 'short' (≤ 1 day), 'medium' (≤ about a month) or
 * 'year' — for picking a sensible bucket size.
 */
export function chartRange(chart) {
  const now = new Date();
  if (chart.rangePeriod === 'year') {
    return {
      from: new Date(now.getFullYear(), 0, 1),
      to: new Date(now.getFullYear() + 1, 0, 1),
      kind: 'year',
    };
  }
  if (chart.rangePeriod === 'month') {
    return {
      from: new Date(now.getFullYear(), now.getMonth(), 1),
      to: new Date(now.getFullYear(), now.getMonth() + 1, 1),
      kind: 'medium',
    };
  }
  const hours = chart.rangeHours || 24;
  return {
    from: new Date(now.getTime() - hours * 3600 * 1000),
    to: now,
    kind: hours <= 24 ? 'short' : hours <= 24 * 62 ? 'medium' : 'year',
    hours,
  };
}
