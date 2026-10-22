import { useEffect, useMemo, useState } from 'react';
import Chart from 'react-apexcharts';
import { api } from '../services/api';
import { CATEGORICAL } from '../palette';
import { chartRange } from './chartRange';
import { formatEuro, formatBucketLabel } from './CostChart';

// Refresh periodically: the history backfill adds each finished hour a few
// minutes after it ends, same cadence as the cost engine's own charts.
const REFRESH_MS = 15 * 60 * 1000;

// Bucket size per kind of period: hourly over a day, daily over a week or
// month, monthly over a year — same convention as CostChart.
const INTERVAL_FOR_KIND = { short: 'hour', medium: 'day', year: 'month' };

const round2 = (v) => Math.round(v * 100) / 100;

/**
 * Renders a saved DashboardChart of type 'smart_charge_savings': the
 * woning's total grid import next to how much of that was the selected
 * smart-charge plan(s) charging the battery, and the derived "scenario
 * zonder net-laden" — the grid import without that charging, but with the
 * grid-charged energy back on the grid in the hours the battery discharged
 * it again (computed by the backend, needs the chart's battery power
 * sensor) — plus, above the
 * chart, what that charging actually cost versus what the same energy
 * would have cost at each plan's avoidedPrice reference (see
 * computeAvoidedPrice in the backend), i.e. what smart timing saved over
 * the period.
 */
export default function SmartChargeSavingsChart({ chart, woningId, height = 300 }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const planIds = useMemo(
    () => (chart.smartChargePlans || []).map((p) => p._id || p),
    [chart.smartChargePlans]
  );
  const gridParamId = chart.gridConsumptionParameter?._id || chart.gridConsumptionParameter || null;
  const batteryParamId = chart.batteryPowerParameter?._id || chart.batteryPowerParameter || null;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const { from, to, kind } = chartRange({
        rangeHours: chart.rangeHours,
        rangePeriod: chart.rangePeriod,
        window: chart.window,
      });
      const interval = INTERVAL_FOR_KIND[kind];
      try {
        const { data: res } = await api.get(`/woningen/${woningId}/smart-charge/history`, {
          params: {
            from: from.toISOString(),
            to: to.toISOString(),
            interval,
            ...(planIds.length > 0 ? { plans: planIds.join(',') } : {}),
            ...(gridParamId ? { gridConsumptionParameter: gridParamId } : {}),
            ...(batteryParamId ? { batteryPowerParameter: batteryParamId } : {}),
          },
        });
        if (cancelled) return;
        setData(res);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err.response?.data?.error?.message || 'Kon historiek niet laden');
      }
    }
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [woningId, chart.rangeHours, chart.rangePeriod, chart.window, planIds, gridParamId, batteryParamId]);

  if (error) return <p className="error-text">{error}</p>;
  if (!data) return <p className="muted">Laden...</p>;
  if (data.plans.length === 0) {
    return <p className="muted">Nog geen slim-laadplan voor deze woning. Maak er een aan onder Slim laden.</p>;
  }

  const bucketCount = data.plans[0].buckets.length;
  const labels = data.plans[0].buckets.map((b) => formatBucketLabel(b.start, data.interval));
  const totalKwh = data.gridConsumption ? data.gridConsumption.buckets.map((b) => b.kwh) : null;
  // The counterfactual comes from the backend: taking the charging off isn't
  // enough, since the battery later discharges that energy — without grid
  // charging those hours would have been drawn from the grid. Only shown
  // when the chart has a battery power sensor to tell when that happened.
  const measured =
    data.gridConsumption && data.gridConsumption.buckets.some((b) => typeof b.withoutGridChargingKwh === 'number');
  const withoutChargingKwh = measured ? data.gridConsumption.buckets.map((b) => b.withoutGridChargingKwh || 0) : null;
  // With a battery sensor the backend also caps the plans' estimated charging
  // (switch-on time × max power) at what the battery and grid really did.
  const batteryKwh = measured
    ? data.gridConsumption.buckets.map((b) => b.gridChargedKwh || 0)
    : Array.from({ length: bucketCount }, (_, i) =>
        data.plans.reduce((sum, p) => sum + (p.buckets[i]?.gridChargedKwh || 0), 0)
      );

  const series = [
    ...(totalKwh
      ? [{ name: 'Totaal verbruik van het net', data: totalKwh.map(round2) }]
      : []),
    { name: 'Waarvan laden batterij', data: batteryKwh.map(round2) },
    ...(withoutChargingKwh
      ? [{ name: 'Scenario zonder net-laden', data: withoutChargingKwh.map(round2) }]
      : []),
  ];
  const colors = [CATEGORICAL.magenta, CATEGORICAL.blue, CATEGORICAL.green].slice(0, series.length);

  // With a battery sensor the saving counts when grid-charged energy is
  // used: what it cost to charge versus the grid price in the hour it
  // replaced. Without one, the old estimate on the day of charging: the
  // charging cost versus each plan's avoidedPrice reference.
  const used = data.gridConsumption?.used || null;
  const totalActualCost = used ? used.paidCost : data.plans.reduce((s, p) => s + p.totals.actualCost, 0);
  const totalHypotheticalCost = used
    ? used.avoidedCost
    : data.plans.reduce((s, p) => s + p.totals.hypotheticalCost, 0);
  const savings = totalHypotheticalCost - totalActualCost;

  const options = {
    chart: {
      toolbar: { show: false },
      zoom: { enabled: false },
      foreColor: 'var(--text-secondary)',
      background: 'transparent',
    },
    colors,
    stroke: { width: 2, curve: 'smooth' },
    fill: { type: 'solid', opacity: series.length > 1 ? [0.12, 0.35, 0.08] : 0.25 },
    dataLabels: { enabled: false },
    legend: { show: series.length > 1, position: 'top', horizontalAlign: 'left' },
    grid: { borderColor: 'var(--gridline)' },
    xaxis: { categories: labels, labels: { rotate: -45, hideOverlappingLabels: true } },
    yaxis: { labels: { formatter: (v) => `${v.toFixed(1)} kWh` } },
    tooltip: { shared: true, intersect: false, y: { formatter: (v) => `${v.toFixed(2)} kWh` } },
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'baseline', marginBottom: 8 }}>
        <span style={{ fontSize: '1.5em', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
          {formatEuro(Math.abs(savings))}
        </span>
        <span className="muted" style={{ fontSize: '0.85em' }}>
          {savings < 0 ? 'meer betaald dan zonder net-laden' : 'bespaard door slim te laden'}
        </span>
        <span className="muted" style={{ fontSize: '0.85em' }}>
          {used
            ? `${used.kwh.toFixed(1).replace('.', ',')} kWh netgeladen batterijstroom verbruikt · betaald bij laden: ${formatEuro(
                totalActualCost
              )} · van het net op dat moment: ${formatEuro(totalHypotheticalCost)}`
            : `Betaald: ${formatEuro(totalActualCost)} · Zonder slim laden: ${formatEuro(totalHypotheticalCost)}`}
        </span>
      </div>
      <Chart options={options} series={series} type="area" height={height} />
      {totalKwh && !withoutChargingKwh && (
        <p className="muted" style={{ fontSize: '0.85em', margin: '4px 0 0' }}>
          Kies een batterijvermogen-sensor bij deze grafiek (Admin → Grafieken) om het scenario
          zonder net-laden te tonen.
        </p>
      )}
    </div>
  );
}
