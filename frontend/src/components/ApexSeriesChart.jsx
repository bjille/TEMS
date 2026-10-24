import { useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import Chart from 'react-apexcharts';
import { api } from '../services/api';
import { selectParametersForWoning } from '../features/parameters/parametersSlice';
import { CATEGORICAL } from '../palette';
import { chartRange, compareRange, isCalendarPeriod, windowTitle } from './chartRange';

const PALETTE = Object.values(CATEGORICAL);
// A chart whose period runs up to now is fetched again this often (a
// rolling window moves along); in between, a curve grows with every live
// reading.
const LIVE_REFRESH_MS = 5 * 60 * 1000;
const LIVE_FLUSH_MS = 15 * 1000;

// Which readings aggregation a chart asks for. Bar charts show consumption
// per slot: average power per hour over a day, kWh per day over a week or
// month, kWh per month over a year. Line/area charts show the raw curve up
// to a day, quarter-hour averages up to a week, hourly averages over a month
// and daily averages over a year —
// the longer views come from HA's long-term statistics, as raw history only
// reaches back ~10 days.
function intervalFor(chart, range) {
  if (chart.type === 'bar') {
    return range.kind === 'short' ? 'hour' : range.kind === 'year' ? 'month' : 'day';
  }
  if (range.kind === 'year') return 'day_avg';
  // (+1: a week with a daylight-saving change has 169 hours)
  if (range.kind === 'medium' && !(range.hours <= 24 * 7 + 1)) return 'hour';
  // Every raw reading of a few days is tens of thousands of points, which
  // freezes the page: quarter-hour averages there.
  if (range.kind === 'medium') return 'quarter';
  return null;
}

function tooltipFormat(chart, range) {
  if (range.kind === 'year') return chart.type === 'bar' ? 'MMM yyyy' : 'dd/MM/yyyy';
  if (range.kind === 'medium' && chart.type === 'bar') return 'ddd dd/MM';
  if (range.kind === 'short') return 'HH:mm';
  return 'dd/MM HH:mm';
}

// Renders a saved DashboardChart definition (a fixed set of parameters, a
// chart type and a time range) with ApexCharts. Unlike the drill-down
// comparison chart, ApexCharts takes each series' points independently
// (as [timestamp, value] pairs) so no manual timestamp-merging is needed.
// With a `chart.compareWindow` (see compareRange) every parameter gets a
// second, dashed/lighter series for that period, shifted onto this one's
// time axis so e.g. two days line up hour by hour.
export default function ApexSeriesChart({ chart, woningId, height = 300 }) {
  const [series, setSeries] = useState(null);
  const [error, setError] = useState(null);
  // Bumped every LIVE_REFRESH_MS while the period runs up to now.
  const [tick, setTick] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const range = useMemo(() => chartRange(chart), [chart, tick]);
  const compare = useMemo(() => compareRange(chart), [chart]);
  // A rolling window ends at "now" as of the last refresh, hence the margin.
  const isRunning = range.to.getTime() > Date.now() - LIVE_REFRESH_MS - 60 * 1000;
  const isRolling = !chart.window && !isCalendarPeriod(chart.rangePeriod);
  const isCurve = intervalFor(chart, range) === null;

  useEffect(() => {
    if (!isRunning) return undefined;
    const timer = setInterval(() => setTick((t) => t + 1), LIVE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [isRunning]);

  // Live readings since the last fetch, per parameter: [[ms, value], ...],
  // appended to the curve of a period that's still running. Collected as
  // they arrive (several a second across a woning) but drawn at most every
  // LIVE_FLUSH_MS — redrawing a curve of thousands of points per reading
  // would freeze the page.
  const parameters = useSelector(selectParametersForWoning(woningId));
  const [tail, setTail] = useState({});
  const pendingTail = useRef({});
  const fetchedUntil = useRef({});
  useEffect(() => {
    if (!isRunning || !isCurve) return;
    const byId = new Map(parameters.map((p) => [p._id, p]));
    for (const p of chart.parameters) {
      const latest = byId.get(p._id)?.latest;
      if (typeof latest?.value !== 'number' || !latest.timestamp) continue;
      const ms = new Date(latest.timestamp).getTime();
      const points = pendingTail.current[p._id] || [];
      const last = points.length ? points[points.length - 1][0] : fetchedUntil.current[p._id] ?? -Infinity;
      if (ms > last) pendingTail.current = { ...pendingTail.current, [p._id]: [...points, [ms, latest.value]] };
    }
  }, [parameters, chart.parameters, isRunning, isCurve]);
  useEffect(() => {
    if (!isRunning || !isCurve) return undefined;
    const timer = setInterval(() => setTail(pendingTail.current), LIVE_FLUSH_MS);
    return () => clearInterval(timer);
  }, [isRunning, isCurve]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setError(null);
      try {
        // Pre-aggregated by the backend instead of fetching full-resolution
        // history — for a busy sensor that's the difference between a
        // handful of points and tens of thousands, which is what made bar
        // charts take 15-20s to render.
        const interval = intervalFor(chart, range);
        const isEnergyBar = interval === 'day' || interval === 'month';
        // A bar overview runs to the end of its period (empty slots for
        // what's still to come); a curve stops at now.
        const clip = (to) => (isEnergyBar ? to : new Date(Math.min(to, Date.now())));
        const fetchWindow = (from, to) =>
          Promise.all(
            chart.parameters.map((p) =>
              api.get(`/woningen/${woningId}/readings`, {
                params: {
                  parameterId: p._id,
                  from: from.toISOString(),
                  to: clip(to).toISOString(),
                  ...(interval ? { interval } : {}),
                },
              })
            )
          );
        const [main, previous] = await Promise.all([
          fetchWindow(range.from, range.to),
          compare && compare.from < new Date() ? fetchWindow(compare.from, compare.to) : null,
        ]);
        if (cancelled) return;
        fetchedUntil.current = Object.fromEntries(
          chart.parameters.map((p, i) => {
            const last = main[i].data[main[i].data.length - 1];
            return [p._id, last ? new Date(last.timestamp).getTime() : range.from.getTime()];
          })
        );
        pendingTail.current = {};
        setTail({});

        // The backend's buckets include the one starting at `to` itself
        // (the next day/month), which doesn't belong to this period.
        const toPoints = (result, windowTo, offsetMs = 0) =>
          result.data
            .filter((r) => typeof r.value === 'number' && new Date(r.timestamp) < windowTo)
            .map((r) => [new Date(r.timestamp).getTime() + offsetMs, r.value]);
        const baseName = (p) => (isEnergyBar ? `${p.label} (kWh)` : p.unit ? `${p.label} (${p.unit})` : p.label);
        const mainTitle = windowTitle(range);
        const compareTitle = compare ? windowTitle(compare) : '';
        setSeries([
          ...chart.parameters.map((p, i) => ({
            name: compare ? `${baseName(p)} · ${mainTitle}` : baseName(p),
            group: 'main',
            parameterId: p._id,
            data: toPoints(main[i], range.to),
          })),
          ...(previous
            ? chart.parameters.map((p, i) => ({
                name: `${baseName(p)} · ${compareTitle}`,
                group: 'compare',
                data: toPoints(previous[i], compare.to, compare.offsetMs),
              }))
            : []),
        ]);
      } catch (err) {
        if (!cancelled) setError(err.response?.data?.error?.message || 'Kon grafiek niet laden');
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [chart, woningId, range, compare]);

  const shownSeries = useMemo(
    () =>
      series &&
      series.map((s) => (s.group === 'main' && tail[s.parameterId] ? { ...s, data: [...s.data, ...tail[s.parameterId]] } : s)),
    [series, tail]
  );
  const compareCount = series ? series.filter((s) => s.group === 'compare').length : 0;
  const options = useMemo(() => {
    const colors = chart.parameters.map((_, i) => PALETTE[i % PALETTE.length]);
    const mainCount = chart.parameters.length;
    return {
      chart: {
        toolbar: { show: false },
        zoom: { enabled: false },
        foreColor: 'var(--text-secondary)',
        background: 'transparent',
        // Bar charts stack each device's hourly average on top of the
        // others, so a bar's total height reads as that hour's combined
        // consumption across all selected devices. A comparison period gets
        // its own stack (series `group`) next to it.
        stacked: chart.type === 'bar',
      },
      // Color follows the parameter; the comparison period reuses it,
      // dashed (lines) or lighter (bars).
      colors: [...colors, ...colors.slice(0, compareCount)],
      stroke: {
        curve: 'smooth',
        width: 2,
        dashArray: [...Array(mainCount).fill(0), ...Array(compareCount).fill(5)],
      },
      ...(chart.type === 'bar'
        ? {
            plotOptions: { bar: { columnWidth: compareCount ? '85%' : '70%' } },
            fill: { opacity: [...Array(mainCount).fill(0.9), ...Array(compareCount).fill(0.4)] },
          }
        : {}),
      // Passing `fill: undefined` (instead of omitting the key) makes
      // ApexCharts overwrite its own internal fill/colors defaults with
      // undefined, which later crashes color setup for every non-'area'
      // chart with "Cannot read properties of undefined (reading 'colors')"
      // and renders nothing. Only set `fill` at all for 'area'/'bar' charts.
      ...(chart.type === 'area'
        ? { fill: { type: 'gradient', gradient: { opacityFrom: 0.35, opacityTo: 0.05 } } }
        : {}),
      grid: { borderColor: 'var(--gridline)' },
      xaxis: {
        type: 'datetime',
        labels: { datetimeUTC: false },
        // Fix the axis to the whole period, so a day that's still running
        // (or a comparison day that's longer) doesn't stretch it. A rolling
        // window's end is "now", which live readings move past: open-ended.
        min: range.from.getTime(),
        ...(isRolling && isRunning ? {} : { max: range.to.getTime() - (chart.type === 'bar' ? 1 : 0) }),
      },
      yaxis: { labels: { formatter: (v) => (Number.isInteger(v) ? v : v.toFixed(1)) } },
      legend: { position: 'top' },
      tooltip: { shared: chart.type !== 'bar', x: { format: tooltipFormat(chart, range) } },
      dataLabels: { enabled: false },
    };
  }, [chart, range, compareCount, isRolling, isRunning]);

  if (error) return <p className="error-text">{error}</p>;
  if (!series) return <p className="muted">Laden...</p>;

  return <Chart key={compareCount} options={options} series={shownSeries} type={chart.type} height={height} />;
}
