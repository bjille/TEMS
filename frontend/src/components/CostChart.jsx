import { useEffect, useMemo, useState } from 'react';
import Chart from 'react-apexcharts';
import { api } from '../services/api';
import { CATEGORICAL } from '../palette';
import { chartRange, compareRange, windowTitle } from './chartRange';

// Fixed categorical order, assigned by a cost calculation's position among
// all of the woning's calculations (oldest first), so it keeps its color
// whichever page or chart shows it.
const TRACKER_COLORS = Object.values(CATEGORICAL);
export const trackerColor = (index) => TRACKER_COLORS[index % TRACKER_COLORS.length];

// Refresh periodically: the cost engine adds each finished hour a few
// minutes after it ends.
const REFRESH_MS = 15 * 60 * 1000;

export function formatEuro(value, decimals = 2) {
  if (typeof value !== 'number') return '—';
  return value.toLocaleString('nl-BE', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function formatQty(value, unit) {
  if (typeof value !== 'number') return '—';
  return `${value.toLocaleString('nl-BE', { maximumFractionDigits: value >= 100 ? 0 : 2 })} ${unit}`;
}

// "+12 %" / "−8 %": how `value` compares to `reference`.
export function formatChange(value, reference) {
  const pct = Math.round(((value - reference) / reference) * 100);
  return `${pct > 0 ? '+' : pct < 0 ? '−' : '±'}${Math.abs(pct)} %`;
}

export function formatBucketLabel(iso, interval) {
  const d = new Date(iso);
  if (interval === 'month') return d.toLocaleDateString('nl-BE', { month: 'short', year: 'numeric' });
  if (interval === 'day') return d.toLocaleDateString('nl-BE', { weekday: 'short', day: 'numeric', month: 'short' });
  return d.toLocaleTimeString('nl-BE', { hour: '2-digit', minute: '2-digit' });
}

// Gives every tracker in a costs-summary response its fixed color (by its
// position in the full, oldest-first list) before any filtering.
export function withTrackerColors(data) {
  return { ...data, trackers: data.trackers.map((t, i) => ({ ...t, color: trackerColor(i) })) };
}

/**
 * Stacked bars of cost per bucket, one series per cost calculation, for a
 * costs-summary response (GET /woningen/:id/costs) whose trackers carry a
 * `color` (see withTrackerColors).
 */
export function CostBarChart({ data, height = 300 }) {
  const { series, options } = useMemo(() => {
    const labels = (data.trackers[0]?.buckets || []).map((b) => formatBucketLabel(b.start, data.interval));
    return {
      series: data.trackers.map((t) => ({
        name: t.name,
        data: t.buckets.map((b) => Math.round(b.cost * 100) / 100),
      })),
      options: {
        chart: {
          stacked: true,
          toolbar: { show: false },
          zoom: { enabled: false },
          foreColor: 'var(--text-secondary)',
          background: 'transparent',
        },
        colors: data.trackers.map((t) => t.color),
        plotOptions: {
          bar: { columnWidth: '70%', borderRadius: 4, borderRadiusApplication: 'end', borderRadiusWhenStacked: 'last' },
        },
        stroke: { show: true, width: 2, colors: ['var(--surface-1)'] },
        dataLabels: { enabled: false },
        legend: { show: data.trackers.length > 1, position: 'top', horizontalAlign: 'left' },
        grid: { borderColor: 'var(--gridline)' },
        xaxis: { categories: labels, labels: { rotate: -45, hideOverlappingLabels: true } },
        yaxis: { labels: { formatter: (v) => formatEuro(v) } },
        tooltip: {
          shared: true,
          intersect: false,
          y: {
            formatter: (v, { seriesIndex, dataPointIndex }) => {
              const tracker = data.trackers[seriesIndex];
              const bucket = tracker?.buckets[dataPointIndex];
              return bucket ? `${formatEuro(v)} · ${formatQty(bucket.quantity, tracker.unit)}` : formatEuro(v);
            },
          },
        },
      },
    };
  }, [data]);

  return <Chart options={options} series={series} type="bar" height={height} />;
}

// Bucket size per kind of period: hourly over a day, daily over a week or
// month, monthly over a year.
const INTERVAL_FOR_KIND = { short: 'hour', medium: 'day', year: 'month' };

/**
 * Renders a saved DashboardChart of type 'cost': the cost of its selected
 * cost calculations (all of the woning's when none are selected) over its
 * period (see chartRange), with the total of the period above the bars.
 */
export default function CostChart({ chart, woningId, height = 300 }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const trackerIds = useMemo(() => (chart.costTrackers || []).map((t) => t._id || t), [chart.costTrackers]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const rangeChart = {
        rangeHours: chart.rangeHours,
        rangePeriod: chart.rangePeriod,
        window: chart.window,
        compareWindow: chart.compareWindow,
      };
      const { from, to, kind } = chartRange(rangeChart);
      const compare = compareRange(rangeChart);
      const interval = INTERVAL_FOR_KIND[kind];
      const select = (trackers) =>
        trackerIds.length > 0 ? trackers.filter((t) => trackerIds.includes(t._id)) : trackers;
      try {
        const [{ data: res }, previous] = await Promise.all([
          api.get(`/woningen/${woningId}/costs`, {
            params: { from: from.toISOString(), to: to.toISOString(), interval },
          }),
          compare
            ? api.get(`/woningen/${woningId}/costs`, {
                params: { from: compare.from.toISOString(), to: compare.to.toISOString(), interval },
              })
            : null,
        ]);
        if (cancelled) return;
        const colored = withTrackerColors(res);
        setData({
          ...colored,
          trackers: select(colored.trackers),
          // Totals of the comparison period, per tracker id.
          compare: previous
            ? {
                title: windowTitle(compare),
                totals: Object.fromEntries(select(previous.data.trackers).map((t) => [t._id, t.totals.cost])),
              }
            : null,
        });
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err.response?.data?.error?.message || 'Kon kosten niet laden');
      }
    }
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [woningId, chart.rangeHours, chart.rangePeriod, chart.window, chart.compareWindow, trackerIds]);

  if (error) return <p className="error-text">{error}</p>;
  if (!data) return <p className="muted">Laden...</p>;
  if (data.trackers.length === 0) {
    return <p className="muted">Nog geen kostenberekening voor deze woning. Maak er een aan onder Kosten.</p>;
  }

  const total = data.trackers.reduce((sum, t) => sum + t.totals.cost, 0);
  const compareTotal = data.compare
    ? data.trackers.reduce((sum, t) => sum + (data.compare.totals[t._id] || 0), 0)
    : null;
  return (
    <div>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <span style={{ fontSize: '1.5em', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
          {formatEuro(total)}
        </span>
        {data.trackers.length > 1 &&
          data.trackers.map((t) => (
            <span key={t._id} className="muted" style={{ fontSize: '0.85em' }}>
              {t.name}: {formatEuro(t.totals.cost)}
              {data.compare ? ` (${formatEuro(data.compare.totals[t._id] || 0)})` : ''}
            </span>
          ))}
        {data.compare && (
          <span className="muted" style={{ fontSize: '0.85em' }}>
            {data.compare.title}: {formatEuro(compareTotal)}
            {compareTotal > 0 ? ` · ${formatChange(total, compareTotal)}` : ''}
          </span>
        )}
      </div>
      <CostBarChart data={data} height={height} />
    </div>
  );
}
