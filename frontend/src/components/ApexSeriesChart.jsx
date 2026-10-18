import { useEffect, useMemo, useState } from 'react';
import Chart from 'react-apexcharts';
import { api } from '../services/api';
import { CATEGORICAL } from '../palette';
import { chartRange } from './chartRange';

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
  if (range.kind === 'medium' && !(range.hours <= 24 * 7)) return 'hour';
  return null;
}

// Renders a saved DashboardChart definition (a fixed set of parameters, a
// chart type and a time range) with ApexCharts. Unlike the drill-down
// comparison chart, ApexCharts takes each series' points independently
// (as [timestamp, value] pairs) so no manual timestamp-merging is needed.
export default function ApexSeriesChart({ chart, woningId, height = 300 }) {
  const [series, setSeries] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setError(null);
      try {
        const range = chartRange(chart);
        // Pre-aggregated by the backend instead of fetching full-resolution
        // history — for a busy sensor that's the difference between a
        // handful of points and tens of thousands, which is what made bar
        // charts take 15-20s to render.
        const interval = intervalFor(chart, range);
        const isEnergyBar = interval === 'day' || interval === 'month';
        const from = range.from.toISOString();
        // A bar overview runs to the end of its month/year (empty slots for
        // what's still to come); a curve stops at now.
        const to = (isEnergyBar ? range.to : new Date(Math.min(range.to, Date.now()))).toISOString();
        const params = { to, ...(interval ? { interval } : {}) };
        const results = await Promise.all(
          chart.parameters.map((p) =>
            api.get(`/woningen/${woningId}/readings`, { params: { parameterId: p._id, from, ...params } })
          )
        );
        if (cancelled) return;
        setSeries(
          chart.parameters.map((p, i) => ({
            name: isEnergyBar ? `${p.label} (kWh)` : p.unit ? `${p.label} (${p.unit})` : p.label,
            data: results[i].data
              .filter((r) => typeof r.value === 'number')
              .map((r) => [new Date(r.timestamp).getTime(), r.value]),
          }))
        );
      } catch (err) {
        if (!cancelled) setError(err.response?.data?.error?.message || 'Kon grafiek niet laden');
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [chart, woningId]);

  const options = useMemo(
    () => ({
      chart: {
        toolbar: { show: false },
        zoom: { enabled: false },
        foreColor: 'var(--text-secondary)',
        background: 'transparent',
        // Bar charts stack each device's hourly average on top of the
        // others, so a bar's total height reads as that hour's combined
        // consumption across all selected devices.
        stacked: chart.type === 'bar',
      },
      colors: chart.parameters.map((_, i) => PALETTE[i % PALETTE.length]),
      stroke: { curve: 'smooth', width: 2 },
      ...(chart.type === 'bar' ? { plotOptions: { bar: { columnWidth: '70%' } } } : {}),
      // Passing `fill: undefined` (instead of omitting the key) makes
      // ApexCharts overwrite its own internal fill/colors defaults with
      // undefined, which later crashes color setup for every non-'area'
      // chart with "Cannot read properties of undefined (reading 'colors')"
      // and renders nothing. Only set `fill` at all for 'area' charts.
      ...(chart.type === 'area'
        ? { fill: { type: 'gradient', gradient: { opacityFrom: 0.35, opacityTo: 0.05 } } }
        : {}),
      grid: { borderColor: 'var(--gridline)' },
      xaxis: {
        type: 'datetime',
        labels: { datetimeUTC: false },
      },
      yaxis: { labels: { formatter: (v) => (Number.isInteger(v) ? v : v.toFixed(1)) } },
      legend: { position: 'top' },
      tooltip: {
        x: { format: chart.rangePeriod === 'year' ? (chart.type === 'bar' ? 'MMM yyyy' : 'dd/MM/yyyy') : 'dd/MM HH:mm' },
      },
      dataLabels: { enabled: false },
    }),
    [chart]
  );

  if (error) return <p className="error-text">{error}</p>;
  if (!series) return <p className="muted">Laden...</p>;

  return (
    <Chart options={options} series={series} type={chart.type} height={height} />
  );
}
