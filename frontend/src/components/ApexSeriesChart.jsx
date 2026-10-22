import { useEffect, useMemo, useState } from 'react';
import Chart from 'react-apexcharts';
import { api } from '../services/api';
import { CATEGORICAL } from '../palette';
import { chartRange, compareRange, windowTitle } from './chartRange';

const PALETTE = Object.values(CATEGORICAL);

// Which readings aggregation a chart asks for. Bar charts show consumption
// per slot: average power per hour over a day, kWh per day over a week or
// month, kWh per month over a year. Line/area charts show the raw curve up
// to a week, hourly averages over a month and daily averages over a year —
// the longer views come from HA's long-term statistics, as raw history only
// reaches back ~10 days.
function intervalFor(chart, range) {
  if (chart.type === 'bar') {
    return range.kind === 'short' ? 'hour' : range.kind === 'year' ? 'month' : 'day';
  }
  if (range.kind === 'year') return 'day_avg';
  // (+1: a week with a daylight-saving change has 169 hours)
  if (range.kind === 'medium' && !(range.hours <= 24 * 7 + 1)) return 'hour';
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
  const range = useMemo(() => chartRange(chart), [chart]);
  const compare = useMemo(() => compareRange(chart), [chart]);

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
        // (or a comparison day that's longer) doesn't stretch it.
        min: range.from.getTime(),
        max: range.to.getTime() - (chart.type === 'bar' ? 1 : 0),
      },
      yaxis: { labels: { formatter: (v) => (Number.isInteger(v) ? v : v.toFixed(1)) } },
      legend: { position: 'top' },
      tooltip: { shared: chart.type !== 'bar', x: { format: tooltipFormat(chart, range) } },
      dataLabels: { enabled: false },
    };
  }, [chart, range, compareCount]);

  if (error) return <p className="error-text">{error}</p>;
  if (!series) return <p className="muted">Laden...</p>;

  return <Chart key={compareCount} options={options} series={series} type={chart.type} height={height} />;
}
