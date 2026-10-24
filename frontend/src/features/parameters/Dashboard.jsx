import { useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { fetchParameters, selectParametersForWoning } from './parametersSlice';
import { fetchAutomations } from '../automations/automationsSlice';
import { fetchCharts, selectChartsForWoning } from '../charts/chartsSlice';
import { selectSelectedWoningId, selectWoningen, selectWoning } from '../woningen/woningenSlice';
import { useLiveReadings } from './useLiveReadings';
import Tile from '../../components/Tile';
import BadgeBar from '../../components/BadgeBar';
import ControlWidget from '../control/ControlWidget';
import ApexSeriesChart from '../../components/ApexSeriesChart';
import EnergyFlowChart from '../../components/EnergyFlowChart';
import PieTotalsChart from '../../components/PieTotalsChart';
import PriceForecastChart from '../../components/PriceForecastChart';
import CostChart from '../../components/CostChart';
import SmartChargeSavingsChart from '../../components/SmartChargeSavingsChart';
import DateNavigator from '../../components/DateNavigator';
import { fromDateInput, isCalendarPeriod, periodWindow, toDateInput } from '../../components/chartRange';
import { WONING_STATUS_COLOR } from '../../palette';
import { collectCategories, groupByCategory, categoryLabel } from './parameterCategories';
import { fetchParameterCategories, selectParameterCategories } from './parameterCategoriesSlice';

function ParameterGroups({ parameters, woningId, categoryFilter }) {
  const filtered = categoryFilter
    ? parameters.filter((p) => categoryLabel(p.category) === categoryFilter)
    : parameters;
  const groups = groupByCategory(filtered);

  return (
    <>
      {groups.map(({ category, parameters: groupParameters }) => (
        <div key={category} style={{ marginBottom: 16 }}>
          {groups.length > 1 && (
            <h4 className="muted" style={{ margin: '0 0 8px' }}>
              {category}
            </h4>
          )}
          <div className="grid">
            {groupParameters.map((parameter) => (
              <Tile key={parameter._id} parameter={parameter} woningId={woningId}>
                <ControlWidget woningId={woningId} parameter={parameter} />
              </Tile>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

function CategoryFilter({ parameters, value, onChange }) {
  const managedCategories = useSelector(selectParameterCategories);
  const categories = collectCategories(parameters, managedCategories);
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={{ minWidth: 180 }}>
      <option value="">Alle categorieën</option>
      {categories.map((c) => (
        <option key={c} value={c}>
          {c}
        </option>
      ))}
      <option value="Overig">Overig</option>
    </select>
  );
}

// Chart types that show a live snapshot, not a period — the date bar
// doesn't apply to them.
const PERIODLESS_TYPES = ['energyflow'];

// The dashboard's date bar choice, kept for this browser tab so it survives
// opening a chart full-screen and coming back.
const DATE_STORAGE_KEY = 'tems.dashboardDate';

function loadDateChoice() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(DATE_STORAGE_KEY));
    if (saved && isCalendarPeriod(saved.period) && /^\d{4}-\d{2}-\d{2}$/.test(saved.date)) {
      return { period: saved.period, anchor: fromDateInput(saved.date) };
    }
  } catch {
    // no storage (private window, blocked) — fall back to today
  }
  return { period: 'day', anchor: new Date() };
}

function useDateChoice() {
  const [choice, setChoice] = useState(loadDateChoice);
  useEffect(() => {
    try {
      sessionStorage.setItem(
        DATE_STORAGE_KEY,
        JSON.stringify({ period: choice.period, date: toDateInput(choice.anchor) })
      );
    } catch {
      // not persisted; the choice still works for this page view
    }
  }, [choice]);
  return {
    period: choice.period,
    anchor: choice.anchor,
    setPeriod: (period) => setChoice((c) => ({ ...c, period })),
    setAnchor: (anchor) => setChoice((c) => ({ ...c, anchor })),
  };
}

// `dateChoice` (from the date bar) overrides every chart's own period with
// that calendar period around the chosen date; without it, charts show
// their own period.
function DashboardCharts({ woningId, dateChoice }) {
  const navigate = useNavigate();
  const charts = useSelector(selectChartsForWoning(woningId));
  const period = dateChoice?.period;
  const anchorKey = dateChoice ? toDateInput(dateChoice.anchor) : null;
  // Memoized on the date (not the Date object), so charts only refetch when
  // the choice really changes.
  const dashboardCharts = useMemo(() => {
    const shown = charts.filter((c) => c.showOnDashboard);
    if (!period) return shown;
    const window = periodWindow(period, fromDateInput(anchorKey));
    return shown.map((c) => (PERIODLESS_TYPES.includes(c.type) ? c : { ...c, rangePeriod: period, window }));
  }, [charts, period, anchorKey]);

  if (dashboardCharts.length === 0) return null;

  return (
    <div
      className="grid"
      style={{ marginBottom: 20, gridTemplateColumns: 'repeat(auto-fill, minmax(min(420px, 100%), 1fr))' }}
    >
      {dashboardCharts.map((chart) => (
        <div key={chart._id} className="card">
          <div className="section-header" style={{ marginBottom: 8 }}>
            <h3 style={{ margin: 0 }}>{chart.name}</h3>
            <button
              className="btn btn-ghost"
              onClick={() =>
                navigate(
                  `/woningen/${woningId}/charts/${chart._id}` +
                    (period && !PERIODLESS_TYPES.includes(chart.type) ? `?period=${period}&date=${anchorKey}` : '')
                )
              }
            >
              Volledig scherm →
            </button>
          </div>
          {chart.type === 'energyflow' ? (
            <EnergyFlowChart chart={chart} woningId={woningId} />
          ) : chart.type === 'pie' ? (
            <PieTotalsChart chart={chart} woningId={woningId} />
          ) : chart.type === 'price_forecast' ? (
            <PriceForecastChart chart={chart} woningId={woningId} />
          ) : chart.type === 'cost' ? (
            <CostChart chart={chart} woningId={woningId} />
          ) : chart.type === 'smart_charge_savings' ? (
            <SmartChargeSavingsChart chart={chart} woningId={woningId} />
          ) : (
            <ApexSeriesChart chart={chart} woningId={woningId} />
          )}
        </div>
      ))}
    </div>
  );
}

function WoningOverviewSection({ woning }) {
  const dispatch = useDispatch();
  const parameters = useSelector(selectParametersForWoning(woning._id));
  const favorites = parameters.filter((p) => p.favorite);

  useEffect(() => {
    dispatch(fetchParameters(woning._id));
    dispatch(fetchAutomations(woning._id));
    dispatch(fetchCharts(woning._id));
  }, [woning._id, dispatch]);

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="section-header" style={{ marginBottom: favorites.length ? 12 : 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="status-dot" style={{ background: WONING_STATUS_COLOR[woning.status] }} />
          <h2 style={{ margin: 0 }}>{woning.name}</h2>
        </div>
        <button className="btn btn-ghost" onClick={() => dispatch(selectWoning(woning._id))}>
          Bekijk alles →
        </button>
      </div>
      <BadgeBar woningId={woning._id} />
      {favorites.length === 0 ? (
        <p className="muted">Geen favoriete parameters ingesteld voor deze woning.</p>
      ) : (
        <ParameterGroups parameters={favorites} woningId={woning._id} categoryFilter="" />
      )}
      <DashboardCharts woningId={woning._id} />
    </div>
  );
}

export default function Dashboard() {
  const dispatch = useDispatch();
  const woningId = useSelector(selectSelectedWoningId);
  const woningen = useSelector(selectWoningen);
  const parameters = useSelector(selectParametersForWoning(woningId));
  const [categoryFilter, setCategoryFilter] = useState('');
  const dateChoice = useDateChoice();
  const charts = useSelector(selectChartsForWoning(woningId));
  const hasPeriodCharts = charts.some((c) => c.showOnDashboard && !PERIODLESS_TYPES.includes(c.type));

  const overviewMode = woningen.length > 0 && !woningId;

  useLiveReadings(overviewMode ? woningen.map((w) => w._id) : woningId);

  useEffect(() => {
    dispatch(fetchParameterCategories());
  }, [dispatch]);

  useEffect(() => {
    if (woningId) {
      dispatch(fetchParameters(woningId));
      dispatch(fetchAutomations(woningId));
      dispatch(fetchCharts(woningId));
    }
  }, [woningId, dispatch]);

  if (woningen.length === 0) {
    return <p className="muted">Je bent nog aan geen enkele woning gekoppeld.</p>;
  }

  if (overviewMode) {
    return (
      <div>
        <div className="section-header">
          <h1>Overzicht — alle installaties</h1>
        </div>
        {woningen.map((w) => (
          <WoningOverviewSection key={w._id} woning={w} />
        ))}
      </div>
    );
  }

  return (
    <div>
      <div className="section-header">
        <h1>Dashboard</h1>
        {parameters.length > 0 && (
          <CategoryFilter parameters={parameters} value={categoryFilter} onChange={setCategoryFilter} />
        )}
      </div>
      <BadgeBar woningId={woningId} sticky />
      {parameters.length === 0 ? (
        <p className="muted">Nog geen parameters geconfigureerd voor deze woning.</p>
      ) : (
        <ParameterGroups parameters={parameters} woningId={woningId} categoryFilter={categoryFilter} />
      )}
      <DashboardCharts woningId={woningId} dateChoice={dateChoice} />
      {hasPeriodCharts && <DateNavigator {...dateChoice} />}
    </div>
  );
}
