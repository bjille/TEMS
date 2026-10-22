import { useEffect, useState } from 'react';
import Chart from 'react-apexcharts';
import { api } from '../services/api';
import { CATEGORICAL } from '../palette';
import { chartRange, compareRange, windowTitle } from './chartRange';
import { formatChange } from './CostChart';

const PALETTE = Object.values(CATEGORICAL);

// Renders each selected parameter's total consumption over the chart's
// period as a pie chart. Reuses the day-bucketed, time-weighted readings
// (kWh per day, `interval=day`) and sums the days client-side — the same
// zero-order-hold accounting the hourly bar chart uses, so a device that
// cycles on/off isn't over- or under-counted here either.
export default function PieTotalsChart({ chart, woningId, height = 300 }) {
  const [totals, setTotals] = useState(null);
  const [compareTotals, setCompareTotals] = useState(null);
  const compare = compareRange(chart);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setError(null);
      try {
        const range = chartRange(chart);
        const compareWindow = compareRange(chart);
        const fetchTotals = (fromDate, toDate) =>
          Promise.all(
            chart.parameters.map((p) =>
              api.get(`/woningen/${woningId}/readings`, {
                params: {
                  parameterId: p._id,
                  from: fromDate.toISOString(),
                  to: new Date(Math.min(toDate, Date.now())).toISOString(),
                  interval: 'day',
                },
              })
            )
          ).then((results) => results.map((r) => r.data.reduce((sum, point) => sum + (point.value || 0), 0)));
        const [main, previous] = await Promise.all([
          fetchTotals(range.from, range.to),
          compareWindow ? fetchTotals(compareWindow.from, compareWindow.to) : null,
        ]);
        if (cancelled) return;
        setTotals(main);
        setCompareTotals(previous);
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

  const sum = totals.reduce((s, t) => s + t, 0);
  const compareSum = compareTotals ? compareTotals.reduce((s, t) => s + t, 0) : 0;
  return (
    <div>
      <Chart options={options} series={totals} type="pie" height={height} />
      {compareTotals && compare && (
        <table className="table" style={{ marginTop: 8, fontSize: '0.9em' }}>
          <thead>
            <tr>
              <th />
              <th style={{ textAlign: 'right' }}>{windowTitle(chartRange(chart))}</th>
              <th style={{ textAlign: 'right' }}>{windowTitle(compare)}</th>
              <th style={{ textAlign: 'right' }}>Verschil</th>
            </tr>
          </thead>
          <tbody>
            {[...chart.parameters.map((p, i) => [p.label, totals[i], compareTotals[i]]), ['Totaal', sum, compareSum]].map(
              ([label, value, reference]) => (
                <tr key={label}>
                  <td>{label}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{value.toFixed(2)} kWh</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{reference.toFixed(2)} kWh</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    {reference > 0 ? formatChange(value, reference) : '—'}
                  </td>
                </tr>
              )
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
