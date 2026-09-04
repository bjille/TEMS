import { useEffect, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { fetchCharts, selectChartsForWoning } from './chartsSlice';
import { fetchParameters } from '../parameters/parametersSlice';
import { useLiveReadings } from '../parameters/useLiveReadings';
import ApexSeriesChart from '../../components/ApexSeriesChart';
import EnergyFlowChart from '../../components/EnergyFlowChart';

const RANGES = [
  { label: '24 uur', hours: 24 },
  { label: '7 dagen', hours: 24 * 7 },
  { label: '30 dagen', hours: 24 * 30 },
];

export default function ChartDetailPage() {
  const { woningId, chartId } = useParams();
  const dispatch = useDispatch();
  const charts = useSelector(selectChartsForWoning(woningId));
  const chart = charts.find((c) => c._id === chartId);

  const [rangeHours, setRangeHours] = useState(null);

  useLiveReadings(woningId);

  useEffect(() => {
    dispatch(fetchCharts(woningId));
    dispatch(fetchParameters(woningId));
  }, [woningId, dispatch]);

  // Default the range picker to the chart's own configured period, once known.
  useEffect(() => {
    if (chart && rangeHours === null) setRangeHours(chart.rangeHours);
  }, [chart, rangeHours]);

  // Without this memo, spreading `chart` into a new object on every render
  // gives ApexSeriesChart a new prop identity on every unrelated re-render
  // (e.g. a live reading arriving via useLiveReadings), which re-triggers
  // its data fetch and forces react-apexcharts to tear down and recreate
  // the chart instance repeatedly — including while a previous async
  // render is still in flight, which can leave the chart blank.
  const displayChart = useMemo(
    () => (chart ? { ...chart, rangeHours: rangeHours || chart.rangeHours } : null),
    [chart, rangeHours]
  );

  if (!chart) {
    return (
      <div>
        <Link to="/" className="muted">
          ← Terug naar dashboard
        </Link>
        <p className="muted" style={{ marginTop: 12 }}>
          Grafiek laden...
        </p>
      </div>
    );
  }

  const isEnergyFlow = chart.type === 'energyflow';
  const subtitle = isEnergyFlow
    ? Object.values(chart.flowRoles || {})
        .filter(Boolean)
        .map((p) => p.label)
        .join(' · ')
    : chart.parameters.map((p) => p.label).join(' · ');

  return (
    <div>
      <Link to="/" className="muted">
        ← Terug naar dashboard
      </Link>
      <div className="section-header" style={{ marginTop: 12 }}>
        <h1>{chart.name}</h1>
        {!isEnergyFlow && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {RANGES.map((r) => (
              <button
                key={r.hours}
                className="btn"
                style={rangeHours === r.hours ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
                onClick={() => setRangeHours(r.hours)}
              >
                {r.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {subtitle && (
        <p className="muted" style={{ marginTop: 0 }}>
          {subtitle}
        </p>
      )}

      <div className="card">
        {isEnergyFlow ? (
          <EnergyFlowChart chart={chart} woningId={woningId} height={480} />
        ) : (
          <ApexSeriesChart chart={displayChart} woningId={woningId} height={480} />
        )}
      </div>
    </div>
  );
}
