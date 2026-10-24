import { useEffect, useMemo, useState } from 'react';
import { useDispatch } from 'react-redux';
import Chart from 'react-apexcharts';
import { api } from '../../services/api';
import { parametersLoaded } from '../parameters/parametersSlice';
import BadgeBar from '../../components/BadgeBar';
import EnergyFlowChart from '../../components/EnergyFlowChart';
import PriceForecastChart from '../../components/PriceForecastChart';
import CostChart from '../../components/CostChart';
import { CATEGORICAL } from '../../palette';

const PALETTE = Object.values(CATEGORICAL);
// The backend recomputes the simulation at most every 20 s.
const REFRESH_MS = 30 * 1000;

// Today's curve of a line/area chart, from the points the demo endpoint
// computed (the regular ApexSeriesChart fetches its own, behind a login).
function DemoSeriesChart({ chart, series, height }) {
  const options = useMemo(() => {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);
    return {
      chart: { toolbar: { show: false }, zoom: { enabled: false }, foreColor: 'var(--text-secondary)', background: 'transparent' },
      colors: series.map((_, i) => PALETTE[i % PALETTE.length]),
      stroke: { curve: 'smooth', width: 2 },
      ...(chart.type === 'area' ? { fill: { type: 'gradient', gradient: { opacityFrom: 0.35, opacityTo: 0.05 } } } : {}),
      grid: { borderColor: 'var(--gridline)' },
      xaxis: { type: 'datetime', labels: { datetimeUTC: false }, min: dayStart.getTime(), max: dayEnd.getTime() },
      yaxis: { labels: { formatter: (v) => (Number.isInteger(v) ? v : v.toFixed(1)) } },
      legend: { position: 'top' },
      tooltip: { shared: true, x: { format: 'HH:mm' } },
      dataLabels: { enabled: false },
    };
  }, [chart.type, series]);
  const data = series.map((s) => ({ name: s.unit ? `${s.label} (${s.unit})` : s.label, data: s.points }));
  return <Chart options={options} series={data} type={chart.type} height={height} />;
}

/**
 * A live, read-only dashboard of the simulated woning (see backend
 * routes/public.js), for visitors who aren't logged in. Renders `fallback`
 * when there's no demo to show.
 */
export default function DemoDashboard({ fallback = null }) {
  const dispatch = useDispatch();
  const [demo, setDemo] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const { data } = await api.get('/public/demo');
        if (cancelled) return;
        dispatch(parametersLoaded({ woningId: data.woning._id, parameters: data.parameters }));
        setDemo(data);
        setFailed(false);
      } catch {
        if (!cancelled) setFailed(true);
      }
    }
    load();
    const interval = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [dispatch]);

  if (failed && !demo) return fallback;
  if (!demo) return <p className="muted landing-demo-loading">Live demo laden…</p>;

  const woningId = demo.woning._id;
  return (
    <div className="landing-demo">
      <div className="landing-demo-header">
        <h2>Live demo</h2>
        <span className="landing-demo-tag">Gesimuleerde woning</span>
      </div>
      <p className="muted landing-demo-note">
        Zo ziet het dashboard eruit voor een woning met zonnepanelen, thuisbatterij, dynamisch
        tarief en afzonderlijk gemeten toestellen. De waarden en kosten zijn gesimuleerd en volgen
        het echte uur van de dag; de elektriciteitsprijzen zijn de echte day-ahead-prijzen.
      </p>
      <BadgeBar woningId={woningId} linkToHistory={false} />
      <div
        className="grid landing-demo-grid"
        style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(420px, 100%), 1fr))' }}
      >
        {demo.charts.map((chart) => (
          <div key={chart._id} className="card">
            <h3 style={{ marginTop: 0 }}>{chart.name}</h3>
            {chart.type === 'energyflow' ? (
              <EnergyFlowChart chart={chart} woningId={woningId} />
            ) : chart.type === 'price_forecast' ? (
              <PriceForecastChart chart={chart} woningId={woningId} data={demo.prices[chart._id]} />
            ) : chart.type === 'cost' ? (
              demo.costs && <CostChart chart={chart} woningId={woningId} data={demo.costs} />
            ) : demo.series[chart._id] ? (
              <DemoSeriesChart chart={chart} series={demo.series[chart._id]} height={300} />
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
