import { useEffect, useMemo, useState } from 'react';
import Chart from 'react-apexcharts';
import { api } from '../services/api';
import { CATEGORICAL } from '../palette';

const PALETTE = Object.values(CATEGORICAL);

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
        const from = new Date(Date.now() - chart.rangeHours * 3600 * 1000).toISOString();
        // Bar charts show one stacked bar per hour (each device's average
        // power that hour), so ask the backend to pre-aggregate to hourly
        // points instead of fetching the full-resolution history — for a
        // busy sensor that's the difference between ~24 points and tens of
        // thousands, which is what made this chart take 15-20s to render.
        const params = chart.type === 'bar' ? { interval: 'hour' } : {};
        const results = await Promise.all(
          chart.parameters.map((p) =>
            api.get(`/woningen/${woningId}/readings`, { params: { parameterId: p._id, from, ...params } })
          )
        );
        if (cancelled) return;
        setSeries(
          chart.parameters.map((p, i) => ({
            name: p.unit ? `${p.label} (${p.unit})` : p.label,
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
      tooltip: { x: { format: 'dd/MM HH:mm' } },
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
