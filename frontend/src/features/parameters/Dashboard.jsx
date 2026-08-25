import { useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { fetchParameters, selectParametersForWoning } from './parametersSlice';
import { fetchAutomations } from '../automations/automationsSlice';
import { fetchCharts, selectChartsForWoning } from '../charts/chartsSlice';
import { selectSelectedWoningId, selectWoningen, selectWoning } from '../woningen/woningenSlice';
import { useLiveReadings } from './useLiveReadings';
import Tile from '../../components/Tile';
import ControlWidget from '../control/ControlWidget';
import ApexSeriesChart from '../../components/ApexSeriesChart';
import EnergyFlowChart from '../../components/EnergyFlowChart';
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

function DashboardCharts({ woningId }) {
  const navigate = useNavigate();
  const charts = useSelector(selectChartsForWoning(woningId));
  const dashboardCharts = useMemo(() => charts.filter((c) => c.showOnDashboard), [charts]);

  if (dashboardCharts.length === 0) return null;

  return (
    <div
      className="grid"
      style={{ marginBottom: 20, gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))' }}
    >
      {dashboardCharts.map((chart) => (
        <div key={chart._id} className="card">
          <div className="section-header" style={{ marginBottom: 8 }}>
            <h3 style={{ margin: 0 }}>{chart.name}</h3>
            <button
              className="btn btn-ghost"
              onClick={() => navigate(`/woningen/${woningId}/charts/${chart._id}`)}
            >
              Volledig scherm →
            </button>
          </div>
          {chart.type === 'energyflow' ? (
            <EnergyFlowChart chart={chart} woningId={woningId} />
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
      {parameters.length === 0 ? (
        <p className="muted">Nog geen parameters geconfigureerd voor deze woning.</p>
      ) : (
        <ParameterGroups parameters={parameters} woningId={woningId} categoryFilter={categoryFilter} />
      )}
      <DashboardCharts woningId={woningId} />
    </div>
  );
}
