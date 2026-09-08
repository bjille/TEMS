import { useEffect, useState } from 'react';
import Chart from 'react-apexcharts';
import { api } from '../services/api';
import { CATEGORICAL } from '../palette';

const PALETTE = Object.values(CATEGORICAL);

// Renders each selected parameter's total consumption over the chart's
// period as a pie chart. Reuses the day-bucketed, time-weighted readings
// (kWh per day, `interval=day`) and sums the days client-side — the same
// zero-order-hold accounting the hourly bar chart uses, so a device that
// cycles on/off isn't over- or under-counted here either.
export default function PieTotalsChart({ chart, woningId, height = 300 }) {
  const [totals, setTotals] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setError(null);
      try {
        const from = new Date(Date.now() - chart.rangeHours * 3600 * 1000).toISOString();
        const results = await Promise.all(
          chart.parameters.map((p) =>
            api.get(`/woningen/${woningId}/readings`, {
              params: { parameterId: p._id, from, interval: 'day' },
            })
          )
        );
        if (cancelled) return;
        setTotals(results.map((r) => r.data.reduce((sum, point) => sum + (point.value || 0), 0)));
      } catch (err) {
        if (!cancelled) setError(err.response?.data?.error?.message || 'Kon grafiek niet laden');
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [chart, woningId]);

  if (error) return <p className="error-text">{error}</p>;
  if (!totals) return <p className="muted">Laden...</p>;
  if (totals.every((t) => t === 0)) return <p className="muted">Geen verbruik in deze periode.</p>;

  const options = {
    chart: { foreColor: 'var(--text-secondary)', background: 'transparent' },
    labels: chart.parameters.map((p) => p.label),
    colors: chart.parameters.map((_, i) => PALETTE[i % PALETTE.length]),
    legend: { position: 'bottom' },
    tooltip: { y: { formatter: (v) => `${v.toFixed(2)} kWh` } },
    stroke: { colors: ['var(--surface-1)'] },
  };

  return <Chart options={options} series={totals} type="pie" height={height} />;
}
