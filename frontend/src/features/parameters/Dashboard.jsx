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
import { VIEW_MODES, fromDateInput, isCalendarPeriod, toDateInput, viewWindow } from '../../components/chartRange';
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

// The dashboard's view (see DateNavigator), kept for this browser tab so it
// survives opening a chart full-screen and coming back.
const VIEW_STORAGE_KEY = 'tems.dashboardView';
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function loadView() {
  const today = toDateInput(new Date());
  const fallback = { mode: 'live', anchor: new Date(), from: today, to: today };
  try {
    const saved = JSON.parse(sessionStorage.getItem(VIEW_STORAGE_KEY));
    if (saved && VIEW_MODES.includes(saved.mode)) {
      return {
        mode: saved.mode,
        anchor: DATE_PATTERN.test(saved.date) ? fromDateInput(saved.date) : new Date(),
        from: DATE_PATTERN.test(saved.from) ? saved.from : today,
        to: DATE_PATTERN.test(saved.to) ? saved.to : today,
      };
    }
  } catch {
    // no storage (private window, blocked) — fall back to live
  }
  return fallback;
}

function useView() {
  const [view, setView] = useState(loadView);
  useEffect(() => {
    try {
      sessionStorage.setItem(
        VIEW_STORAGE_KEY,
        JSON.stringify({ mode: view.mode, date: toDateInput(view.anchor), from: view.from, to: view.to })
      );
    } catch {
      // not persisted; the choice still works for this page view
    }
  }, [view]);
  return {
    view,
    setMode: (mode) => setView((v) => ({ ...v, mode })),
    setAnchor: (anchor) => setView((v) => ({ ...v, anchor })),
    setRange: ({ from, to }) => setView((v) => ({ ...v, from, to })),
  };
}

// The query that opens a chart's full-screen page on the same view.
function detailQuery(view) {
  if (isCalendarPeriod(view.mode)) return `?period=${view.mode}&date=${toDateInput(view.anchor)}`;
  if (view.mode === 'range') return `?period=custom&from=${view.from}&to=${view.to}`;
  return '';
}

// A `view` with a period shows that period on every chart — the energy
// flow then as the energy over it; 'live' (or no view, as on the overview
// of all installations) leaves each chart its own period, live.
function DashboardCharts({ woningId, view }) {
  const navigate = useNavigate();
  const charts = useSelector(selectChartsForWoning(woningId));
  const mode = view?.mode;
  const anchorKey = view ? toDateInput(view.anchor) : null;
  const from = view?.from;
  const to = view?.to;
  // Memoized on the dates (not the Date object), so charts only refetch
  // when the choice really changes.
  const window = useMemo(
    () => (mode ? viewWindow({ mode, anchor: fromDateInput(anchorKey), from, to }) : null),
    [mode, anchorKey, from, to]
  );
  const dashboardCharts = useMemo(() => {
    const shown = charts.filter((c) => c.showOnDashboard);
    if (!window) return shown;
    return shown.map((c) => ({ ...c, ...(isCalendarPeriod(mode) ? { rangePeriod: mode } : {}), window }));
  }, [charts, mode, window]);

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
              onClick={() => navigate(`/woningen/${woningId}/charts/${chart._id}${view ? detailQuery(view) : ''}`)}
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
  const viewChoice = useView();
  const charts = useSelector(selectChartsForWoning(woningId));
  const hasCharts = charts.some((c) => c.showOnDashboard);

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
      <DashboardCharts woningId={woningId} view={viewChoice.view} />
      {hasCharts && <DateNavigator {...viewChoice} />}
    </div>
  );
}
