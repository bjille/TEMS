import { useEffect, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { fetchCharts, selectChartsForWoning } from './chartsSlice';
import { fetchParameters } from '../parameters/parametersSlice';
import { useLiveReadings } from '../parameters/useLiveReadings';
import ApexSeriesChart from '../../components/ApexSeriesChart';
import EnergyFlowChart from '../../components/EnergyFlowChart';
import PieTotalsChart from '../../components/PieTotalsChart';
import PriceForecastChart from '../../components/PriceForecastChart';
import CostChart from '../../components/CostChart';
import BadgeBar from '../../components/BadgeBar';
import { RANGE_OPTIONS, rangeFields, rangeValue } from '../../components/chartRange';

export default function ChartDetailPage() {
  const { woningId, chartId } = useParams();
  const dispatch = useDispatch();
  const charts = useSelector(selectChartsForWoning(woningId));
  const chart = charts.find((c) => c._id === chartId);

  // Select value from RANGE_OPTIONS ('24', ..., 'month', 'year').
  const [range, setRange] = useState(null);

  useLiveReadings(woningId);

  useEffect(() => {
    dispatch(fetchCharts(woningId));
    dispatch(fetchParameters(woningId));
  }, [woningId, dispatch]);

  // Default the range picker to the chart's own configured period, once known.
  useEffect(() => {
    if (chart && range === null) setRange(rangeValue(chart));
  }, [chart, range]);

  // Without this memo, spreading `chart` into a new object on every render
  // gives ApexSeriesChart a new prop identity on every unrelated re-render
  // (e.g. a live reading arriving via useLiveReadings), which re-triggers
  // its data fetch and forces react-apexcharts to tear down and recreate
  // the chart instance repeatedly — including while a previous async
  // render is still in flight, which can leave the chart blank.
  const displayChart = useMemo(
    () => (chart ? { ...chart, ...(range ? rangeFields(range) : {}) } : null),
    [chart, range]
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
  // Neither chart type is a fixed-range history query: energyflow is a live
  // snapshot, price_forecast is HA's own forecast window (today/tomorrow).
  const hasNoRange = isEnergyFlow || chart.type === 'price_forecast';
  const subtitle = isEnergyFlow
    ? Object.values(chart.flowRoles || {})
        .filter(Boolean)
        .map((p) => p.label)
        .join(' · ')
    : chart.type === 'cost'
    ? (chart.costTrackers || []).map((t) => t.name).join(' · ')
    : chart.parameters.map((p) => p.label).join(' · ');

  return (
    <div>
      <Link to="/" className="muted">
        ← Terug naar dashboard
      </Link>
      <div className="section-header" style={{ marginTop: 12 }}>
        <h1>{chart.name}</h1>
        {!hasNoRange && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {RANGE_OPTIONS.map((r) => (
              <button
                key={r.value}
                className="btn"
                style={range === r.value ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
                onClick={() => setRange(r.value)}
              >
                {r.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <BadgeBar woningId={woningId} sticky />

      {subtitle && (
        <p className="muted" style={{ marginTop: 0 }}>
          {subtitle}
        </p>
      )}

      <div className="card">
        {isEnergyFlow ? (
          <EnergyFlowChart chart={chart} woningId={woningId} height={480} />
        ) : chart.type === 'pie' ? (
          <PieTotalsChart chart={displayChart} woningId={woningId} height={480} />
        ) : chart.type === 'price_forecast' ? (
          <PriceForecastChart chart={chart} woningId={woningId} height={480} />
        ) : chart.type === 'cost' ? (
          <CostChart chart={displayChart} woningId={woningId} height={480} />
        ) : (
          <ApexSeriesChart chart={displayChart} woningId={woningId} height={480} />
        )}
      </div>
    </div>
  );
}
