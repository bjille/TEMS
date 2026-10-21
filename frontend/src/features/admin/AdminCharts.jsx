import { useEffect, useMemo, useState } from 'react';
import { api } from '../../services/api';
import { RANGE_OPTIONS, rangeFields, rangeLabel, rangeValue } from '../../components/chartRange';
import { useDispatch, useSelector } from 'react-redux';
import { fetchWoningen, selectWoningen, selectSelectedWoningId } from '../woningen/woningenSlice';
import { fetchParameters, selectParametersForWoning } from '../parameters/parametersSlice';
import { fetchCharts, createChart, updateChart, deleteChart, copyChart, selectChartsForWoning } from '../charts/chartsSlice';
import { groupByCategory, collectCategories, categoryLabel } from '../parameters/parameterCategories';
import CopyToWoningen from '../../components/CopyToWoningen';

const TYPE_OPTIONS = [
  { value: 'line', label: 'Lijn' },
  { value: 'area', label: 'Vlak' },
  { value: 'bar', label: 'Balken' },
  { value: 'pie', label: 'Cirkeldiagram (totalen)' },
  { value: 'energyflow', label: 'Energieflow' },
  { value: 'price_forecast', label: 'Dynamische prijzen (uurcurve)' },
  { value: 'cost', label: 'Kosten' },
  { value: 'smart_charge_savings', label: 'Slim laden — besparing' },
];


const FLOW_ROLES = [
  { key: 'pv', label: 'Zonnepanelen (PV-opwek)' },
  { key: 'battery', label: 'Batterij (signed: + ontladen, − laden)' },
  { key: 'grid', label: 'Net (signed: + import, − export)' },
  {
    key: 'thuis',
    label: 'Thuisverbruik (optioneel, rechtstreekse meting — anders afgeleid uit bovenstaande)',
  },
];

// Switch entities (e.g. "switch.keuken_droogkast") report string states
// ("on"/"off") rather than numeric readings, so they can't be plotted on a
// line/area/bar chart or used as a signed power role in an energyflow
// diagram — keep them out of every parameter picker in this section.
function isSwitchEntity(parameter) {
  return parameter.entityId?.split('.')[0] === 'switch';
}

function ParameterOptions({ parameters }) {
  return groupByCategory(parameters).map(({ category, parameters: groupParameters }) => (
    <optgroup key={category} label={category}>
      {groupParameters.map((p) => (
        <option key={p._id} value={p._id}>
          {p.label}
        </option>
      ))}
    </optgroup>
  ));
}

const emptyForm = {
  name: '',
  type: 'line',
  range: '24', // see RANGE_OPTIONS
  parameterIds: [],
  flowRoles: { pv: '', battery: '', grid: '', thuis: '' },
  devices: [], // [{ parameterId, parentId }] — parentId '' means directly under Thuis
  costTrackerIds: [], // empty = all of the woning's cost calculations
  smartChargePlanIds: [], // empty = all of the woning's smart-charge plans
  gridConsumptionParameterId: '', // optional: cumulative grid-import meter for the "totaal" line
  // Auto-include rule: every parameter of this type + unit, minus excludedIds.
  autoType: '',
  autoUnit: '',
  excludedIds: [],
  circular: false,
  showOnDashboard: false,
};

function chartSummary(chart) {
  if (chart.type === 'cost') {
    const names = (chart.costTrackers || []).map((t) => t.name);
    return names.length > 0 ? names.join(', ') : 'Alle kostenberekeningen';
  }
  if (chart.type === 'smart_charge_savings') {
    const names = (chart.smartChargePlans || []).map((p) => p.name);
    const base = names.length > 0 ? names.join(', ') : 'Alle slim-laadplannen';
    return chart.gridConsumptionParameter ? `${base} · ${chart.gridConsumptionParameter.label}` : base;
  }
  if (chart.type === 'energyflow') {
    const roles = Object.values(chart.flowRoles || {})
      .filter(Boolean)
      .map((p) => p.label);
    const devices = (chart.devices || []).map(
      (d) => `${d.parameter?.label} (${d.parent?.label || 'Thuis'})`
    );
    return [...roles, ...devices].join(', ');
  }
  return chart.parameters.map((p) => p.label).join(', ');
}

export default function AdminCharts() {
  const dispatch = useDispatch();
  const woningen = useSelector(selectWoningen);
  const selectedWoningId = useSelector(selectSelectedWoningId);
  const [woningId, setWoningId] = useState('');
  const parameters = useSelector(selectParametersForWoning(woningId));
  const chartableParameters = useMemo(
    () => parameters.filter((p) => !isSwitchEntity(p)),
    [parameters]
  );
  // A price-forecast chart reads the hourly curve off a dynamic-prices HA
  // entity's own attributes (see backend `price-forecast` route), so only
  // parameters of that type are meaningful choices here.
  const priceForecastParameters = useMemo(
    () => chartableParameters.filter((p) => p.type === 'electricity_price'),
    [chartableParameters]
  );
  const parameterCategoryOptions = useMemo(
    () => collectCategories(chartableParameters),
    [chartableParameters]
  );
  const charts = useSelector(selectChartsForWoning(woningId));
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState(null);
  const [error, setError] = useState(null);
  const [parameterCategoryFilter, setParameterCategoryFilter] = useState('');
  const filteredChartableParameters = parameterCategoryFilter
    ? chartableParameters.filter((p) => categoryLabel(p.category) === parameterCategoryFilter)
    : chartableParameters;

  const isEnergyFlow = form.type === 'energyflow';
  const isPriceForecast = form.type === 'price_forecast';
  const isCost = form.type === 'cost';
  const isSmartChargeSavings = form.type === 'smart_charge_savings';
  const [costTrackers, setCostTrackers] = useState([]);
  const [smartChargePlans, setSmartChargePlans] = useState([]);
  // A cumulative grid-import meter (kWh) — same shape as a CostTracker's own
  // meterParameter — for the savings chart's optional "totaal verbruik van
  // het net" line.
  const gridConsumptionCandidates = useMemo(
    () =>
      chartableParameters.filter(
        (p) => (p.type === 'grid_power' || p.type === 'energy_consumption') && (p.unit || '').trim().toLowerCase() === 'kwh'
      ),
    [chartableParameters]
  );
  // Line/area/bar/pie charts and the energyflow device breakdown can pull in
  // their parameters automatically by type + unit.
  const supportsAutoInclude = !isCost && !isSmartChargeSavings && !isPriceForecast;
  const autoTypes = useMemo(
    () => [...new Set(chartableParameters.map((p) => p.type))].sort(),
    [chartableParameters]
  );
  const autoUnits = useMemo(
    () => [
      ...new Set(
        chartableParameters.filter((p) => p.type === form.autoType).map((p) => (p.unit || '').trim())
      ),
    ],
    [chartableParameters, form.autoType]
  );
  const matchesAuto = (p) =>
    supportsAutoInclude &&
    !!form.autoType &&
    p.type === form.autoType &&
    (p.unit || '').trim().toLowerCase() === form.autoUnit.trim().toLowerCase();
  // What the rule currently picks up — for an energyflow diagram minus the
  // sensors already used as a flow role or an explicitly placed device.
  const autoMatches = chartableParameters.filter(
    (p) =>
      matchesAuto(p) &&
      !(
        isEnergyFlow &&
        (Object.values(form.flowRoles).includes(p._id) || form.devices.some((d) => d.parameterId === p._id))
      )
  );
  const explicitParameterIds = form.parameterIds.filter(
    (id) => !matchesAuto(chartableParameters.find((p) => p._id === id) || {})
  );
  const canSubmit = isCost || isSmartChargeSavings
    ? true
    : isEnergyFlow
    ? Object.values(form.flowRoles).some(Boolean)
    : isPriceForecast
    ? form.parameterIds.length === 1
    : explicitParameterIds.length > 0 || autoMatches.length > 0;

  useEffect(() => {
    dispatch(fetchWoningen());
  }, [dispatch]);

  // Default to whichever woning is selected up top in the header, so
  // opening Admin lands you on the same woning you were just looking at
  // instead of always the first one — falls back to that first woning only
  // when nothing (or "Alle installaties") is selected there.
  useEffect(() => {
    if (woningId || woningen.length === 0) return;
    const stillExists = selectedWoningId && woningen.some((w) => w._id === selectedWoningId);
    setWoningId(stillExists ? selectedWoningId : woningen[0]._id);
  }, [woningen, woningId, selectedWoningId]);

  useEffect(() => {
    if (woningId) {
      dispatch(fetchParameters(woningId));
      dispatch(fetchCharts(woningId));
      api
        .get(`/woningen/${woningId}/costs/trackers`)
        .then(({ data }) => setCostTrackers(data))
        .catch(() => setCostTrackers([]));
      api
        .get(`/woningen/${woningId}/smart-charge`)
        .then(({ data }) => setSmartChargePlans(data))
        .catch(() => setSmartChargePlans([]));
    }
    setParameterCategoryFilter('');
  }, [woningId, dispatch]);

  function toggleParameter(id) {
    setForm((f) => ({
      ...f,
      parameterIds: f.parameterIds.includes(id)
        ? f.parameterIds.filter((x) => x !== id)
        : [...f.parameterIds, id],
    }));
  }

  function setFlowRole(key, value) {
    setForm((f) => ({ ...f, flowRoles: { ...f.flowRoles, [key]: value } }));
  }

  function addDeviceRow() {
    setForm((f) => ({ ...f, devices: [...f.devices, { parameterId: '', parentId: '' }] }));
  }

  function updateDeviceRow(index, field, value) {
    setForm((f) => {
      if (field === 'parameterId') {
        const oldId = f.devices[index].parameterId;
        return {
          ...f,
          devices: f.devices.map((d, i) => {
            if (i === index) return { ...d, parameterId: value };
            if (oldId && d.parentId === oldId) return { ...d, parentId: '' };
            return d;
          }),
        };
      }
      return { ...f, devices: f.devices.map((d, i) => (i === index ? { ...d, [field]: value } : d)) };
    });
  }

  function removeDeviceRow(index) {
    setForm((f) => {
      const removedId = f.devices[index].parameterId;
      const devices = f.devices
        .filter((_, i) => i !== index)
        .map((d) => (removedId && d.parentId === removedId ? { ...d, parentId: '' } : d));
      return { ...f, devices };
    });
  }

  function openEditForm(chart) {
    setEditingId(chart._id);
    setForm({
      name: chart.name,
      type: chart.type,
      range: rangeValue(chart),
      // Only the explicitly chosen ones: auto-included entries come back
      // from the server marked `auto` and are managed by the rule below.
      parameterIds: chart.parameters.filter((p) => !p.auto).map((p) => p._id),
      flowRoles: {
        pv: chart.flowRoles?.pv?._id || '',
        battery: chart.flowRoles?.battery?._id || '',
        grid: chart.flowRoles?.grid?._id || '',
        thuis: chart.flowRoles?.thuis?._id || '',
      },
      devices: (chart.devices || [])
        .filter((d) => d.parameter && !d.auto)
        .map((d) => ({
          parameterId: d.parameter._id,
          parentId: d.parent?._id || '',
        })),
      costTrackerIds: (chart.costTrackers || []).map((t) => t._id),
      smartChargePlanIds: (chart.smartChargePlans || []).map((p) => p._id),
      gridConsumptionParameterId: chart.gridConsumptionParameter?._id || '',
      autoType: chart.autoInclude?.type || '',
      autoUnit: chart.autoInclude?.unit || '',
      excludedIds: (chart.excludedParameters || []).map((id) => String(id._id || id)),
      circular: chart.circular || false,
      showOnDashboard: chart.showOnDashboard,
    });
    setError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setForm(emptyForm);
    setError(null);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    const payload = {
      name: form.name,
      type: form.type,
      ...rangeFields(form.range),
      showOnDashboard: form.showOnDashboard,
      costTrackers: isCost ? form.costTrackerIds : [],
      smartChargePlans: isSmartChargeSavings ? form.smartChargePlanIds : [],
      gridConsumptionParameter: isSmartChargeSavings ? form.gridConsumptionParameterId || null : null,
      autoInclude: supportsAutoInclude && form.autoType ? { type: form.autoType, unit: form.autoUnit } : { type: null, unit: '' },
      excludedParameters:
        supportsAutoInclude && form.autoType
          ? form.excludedIds.filter((id) => autoMatches.some((p) => p._id === id))
          : [],
      ...(isCost || isSmartChargeSavings
        ? { parameters: [], flowRoles: {}, devices: [], circular: false }
        : isEnergyFlow
        ? {
            flowRoles: Object.fromEntries(
              Object.entries(form.flowRoles).filter(([, v]) => v)
            ),
            devices: form.devices
              .filter((d) => d.parameterId)
              .map((d) => ({ parameter: d.parameterId, parent: d.parentId || null })),
            circular: form.circular,
            parameters: [],
          }
        : { parameters: explicitParameterIds, flowRoles: {}, devices: [], circular: false }),
    };
    try {
      if (editingId) {
        await dispatch(updateChart({ woningId, chartId: editingId, ...payload })).unwrap();
        setEditingId(null);
      } else {
        await dispatch(createChart({ woningId, ...payload })).unwrap();
      }
      setForm(emptyForm);
    } catch (err) {
      setError(err);
    }
  }

  async function handleDelete(chartId) {
    if (!confirm('Deze grafiek verwijderen?')) return;
    await dispatch(deleteChart({ woningId, chartId }));
  }

  async function toggleShowOnDashboard(chart) {
    await dispatch(
      updateChart({ woningId, chartId: chart._id, showOnDashboard: !chart.showOnDashboard })
    );
  }

  return (
    <div>
      <div className="section-header">
        <h2>Grafieken</h2>
        <div className="form-field" style={{ marginBottom: 0, minWidth: 240 }}>
          <label>Woning</label>
          <select value={woningId} onChange={(e) => setWoningId(e.target.value)}>
            {woningen.map((w) => (
              <option key={w._id} value={w._id}>
                {w.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {woningId && (
        <>
          <table className="table" style={{ marginBottom: 24 }}>
            <thead>
              <tr>
                <th>Naam</th>
                <th>Type</th>
                <th>Periode</th>
                <th>Parameters</th>
                <th>Op dashboard</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {charts.map((c) => (
                <tr key={c._id}>
                  <td>{c.name}</td>
                  <td>{TYPE_OPTIONS.find((t) => t.value === c.type)?.label || c.type}</td>
                  <td>
                    {c.type === 'energyflow' || c.type === 'price_forecast'
                      ? 'live'
                      : rangeLabel(c)}
                  </td>
                  <td className="muted">{chartSummary(c)}</td>
                  <td>
                    <button className="btn" onClick={() => toggleShowOnDashboard(c)}>
                      {c.showOnDashboard ? 'Ja' : 'Nee'}
                    </button>
                  </td>
                  <td style={{ display: 'flex', gap: 8 }}>
                    <button className="btn" onClick={() => openEditForm(c)}>
                      Wijzigen
                    </button>
                    <button className="btn btn-danger" onClick={() => handleDelete(c._id)}>
                      Verwijderen
                    </button>
                    <CopyToWoningen
                      woningen={woningen}
                      currentWoningId={woningId}
                      onCopy={(targetWoningIds) =>
                        dispatch(copyChart({ woningId, chartId: c._id, targetWoningIds })).unwrap()
                      }
                    />
                  </td>
                </tr>
              ))}
              {charts.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted">
                    Nog geen grafieken voor deze woning.
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          <form className="card" onSubmit={handleSubmit} style={{ maxWidth: 480 }}>
            <h3 style={{ marginTop: 0 }}>{editingId ? 'Grafiek wijzigen' : 'Nieuwe grafiek'}</h3>
            <div className="form-field">
              <label>Naam</label>
              <input
                placeholder="Energiestromen"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
              />
            </div>
            <div className="form-field">
              <label>Type</label>
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                {TYPE_OPTIONS.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
              {isEnergyFlow && (
                <p className="muted" style={{ fontSize: '0.85em', margin: '4px 0 0' }}>
                  Toont de actuele (live) vermogens als Sankey-diagram — geen periode, werkt via de
                  live metingen.
                </p>
              )}
              {form.type === 'pie' && (
                <p className="muted" style={{ fontSize: '0.85em', margin: '4px 0 0' }}>
                  Toont het totale verbruik (kWh) per gekozen parameter over de hele periode, als
                  aandeel van het geheel.
                </p>
              )}
              {isCost && (
                <p className="muted" style={{ fontSize: '0.85em', margin: '4px 0 0' }}>
                  Toont de kosten van de gekozen kostenberekeningen (zie Kosten) over de periode:
                  per uur bij 24 uur, per dag bij 7 of 30 dagen en deze maand, per maand bij dit jaar.
                </p>
              )}
              {isPriceForecast && (
                <p className="muted" style={{ fontSize: '0.85em', margin: '4px 0 0' }}>
                  Toont de uurprijzen van vandaag (en morgen zodra ENTSO-E die publiceert) als
                  staafdiagram, rechtstreeks uit het <code>prices</code>/<code>prices_today</code>
                  -attribuut van de sensor in Home Assistant — geen periode, werkt niet via de
                  opgeslagen historiek.
                </p>
              )}
              {isSmartChargeSavings && (
                <p className="muted" style={{ fontSize: '0.85em', margin: '4px 0 0' }}>
                  Toont hoeveel van het net geladen is voor de gekozen slim-laadplannen, optioneel
                  naast het totale netverbruik van de woning, en wat dat laden effectief heeft
                  bespaard tegenover de referentieprijs van elk plan (zie Slim laden).
                </p>
              )}
            </div>

            {isEnergyFlow ? (
              <div className="form-field">
                <label>Vermogenssensoren</label>
                {FLOW_ROLES.map((role) => (
                  <div key={role.key} style={{ marginBottom: 8 }}>
                    <label className="muted" style={{ fontSize: '0.85em' }}>
                      {role.label}
                    </label>
                    <select
                      value={form.flowRoles[role.key]}
                      onChange={(e) => setFlowRole(role.key, e.target.value)}
                    >
                      <option value="">— geen —</option>
                      <ParameterOptions parameters={chartableParameters} />
                    </select>
                  </div>
                ))}
              </div>
            ) : null}

            {isEnergyFlow ? (
              <div className="form-field">
                <label>Toestellen (onderverdeling van Thuis)</label>
                {form.devices.map((d, i) => {
                  const usedElsewhere = form.devices
                    .filter((_, j) => j !== i)
                    .map((x) => x.parameterId);
                  const availableParams = chartableParameters.filter(
                    (p) => p._id === d.parameterId || !usedElsewhere.includes(p._id)
                  );
                  const availableParents = form.devices.slice(0, i).filter((x) => x.parameterId);
                  return (
                    <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                      <select
                        value={d.parameterId}
                        onChange={(e) => updateDeviceRow(i, 'parameterId', e.target.value)}
                      >
                        <option value="">— kies sensor —</option>
                        <ParameterOptions parameters={availableParams} />
                      </select>
                      <span className="muted" style={{ fontSize: '0.85em' }}>
                        onder
                      </span>
                      <select
                        value={d.parentId}
                        onChange={(e) => updateDeviceRow(i, 'parentId', e.target.value)}
                      >
                        <option value="">Thuis (hoofdniveau)</option>
                        {availableParents.map((x) => {
                          const param = parameters.find((p) => p._id === x.parameterId);
                          return (
                            <option key={x.parameterId} value={x.parameterId}>
                              {param?.label}
                            </option>
                          );
                        })}
                      </select>
                      <button type="button" className="btn btn-danger" onClick={() => removeDeviceRow(i)}>
                        ×
                      </button>
                    </div>
                  );
                })}
                <button type="button" className="btn" onClick={addDeviceRow}>
                  + Toestel toevoegen
                </button>
                {chartableParameters.length === 0 && (
                  <p className="muted" style={{ margin: '6px 0 0' }}>
                    Deze woning heeft nog geen parameters.
                  </p>
                )}
                <p className="muted" style={{ fontSize: '0.85em', margin: '6px 0 0' }}>
                  Optioneel: vermogenssensoren per toestel. Kies bij “onder” een ander toestel om
                  het daaronder te nesten (bv. Frigo en Oven onder Stroomkring A) — laat op “Thuis”
                  staan voor een toestel op hoofdniveau. Wat niet gedekt wordt door de eigen
                  kinderen van een niveau, verschijnt daar als “Overig”.
                </p>
              </div>
            ) : null}

            {isCost ? (
              <>
                <div className="form-field">
                  <label>Periode</label>
                  <select value={form.range} onChange={(e) => setForm({ ...form, range: e.target.value })}>
                    {RANGE_OPTIONS.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-field">
                  <label>Kostenberekeningen</label>
                  {costTrackers.map((t) => (
                    <label key={t._id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <input
                        type="checkbox"
                        checked={form.costTrackerIds.includes(t._id)}
                        onChange={() =>
                          setForm((f) => ({
                            ...f,
                            costTrackerIds: f.costTrackerIds.includes(t._id)
                              ? f.costTrackerIds.filter((x) => x !== t._id)
                              : [...f.costTrackerIds, t._id],
                          }))
                        }
                      />
                      {t.name}
                    </label>
                  ))}
                  {costTrackers.length === 0 && (
                    <p className="muted" style={{ margin: 0 }}>
                      Deze woning heeft nog geen kostenberekening. Maak er eerst een aan onder Kosten.
                    </p>
                  )}
                  <p className="muted" style={{ fontSize: '0.85em', margin: '6px 0 0' }}>
                    Niets aangevinkt = alle kostenberekeningen van de woning, ook die later bijkomen.
                  </p>
                </div>
              </>
            ) : isSmartChargeSavings ? (
              <>
                <div className="form-field">
                  <label>Periode</label>
                  <select value={form.range} onChange={(e) => setForm({ ...form, range: e.target.value })}>
                    {RANGE_OPTIONS.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-field">
                  <label>Slim-laadplannen</label>
                  {smartChargePlans.map((p) => (
                    <label key={p._id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <input
                        type="checkbox"
                        checked={form.smartChargePlanIds.includes(p._id)}
                        onChange={() =>
                          setForm((f) => ({
                            ...f,
                            smartChargePlanIds: f.smartChargePlanIds.includes(p._id)
                              ? f.smartChargePlanIds.filter((x) => x !== p._id)
                              : [...f.smartChargePlanIds, p._id],
                          }))
                        }
                      />
                      {p.name}
                    </label>
                  ))}
                  {smartChargePlans.length === 0 && (
                    <p className="muted" style={{ margin: 0 }}>
                      Deze woning heeft nog geen slim-laadplan. Maak er eerst een aan onder Slim
                      laden.
                    </p>
                  )}
                  <p className="muted" style={{ fontSize: '0.85em', margin: '6px 0 0' }}>
                    Niets aangevinkt = alle slim-laadplannen van de woning, ook die later bijkomen.
                  </p>
                </div>
                <div className="form-field">
                  <label>Totaal netverbruik (optioneel)</label>
                  <select
                    value={form.gridConsumptionParameterId}
                    onChange={(e) => setForm({ ...form, gridConsumptionParameterId: e.target.value })}
                  >
                    <option value="">— geen totaallijn —</option>
                    <ParameterOptions parameters={gridConsumptionCandidates} />
                  </select>
                  <p className="muted" style={{ fontSize: '0.85em', margin: '6px 0 0' }}>
                    Een cumulatieve teller (kWh) voor wat de woning in totaal van het net afneemt —
                    bv. “van net afgehaald vandaag”. Zonder deze keuze toont de grafiek enkel het
                    net-laden van de batterij, niet de vergelijking met het totale huisverbruik.
                  </p>
                </div>
              </>
            ) : isEnergyFlow ? (
              <div className="form-field">
                <label>
                  <input
                    type="checkbox"
                    checked={form.circular}
                    onChange={(e) => setForm({ ...form, circular: e.target.checked })}
                    style={{ marginRight: 6 }}
                  />
                  Circulaire lay-out
                </label>
                <p className="muted" style={{ fontSize: '0.85em', margin: '4px 0 0' }}>
                  Rangschikt de knooppunten in een cirkel i.p.v. in lagen naast elkaar.
                </p>
              </div>
            ) : isPriceForecast ? (
              <div className="form-field">
                <label>Prijzensensor</label>
                <select
                  value={form.parameterIds[0] || ''}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      parameterIds: e.target.value ? [e.target.value] : [],
                    }))
                  }
                >
                  <option value="">— kies sensor —</option>
                  <ParameterOptions parameters={priceForecastParameters} />
                </select>
                {priceForecastParameters.length === 0 && (
                  <p className="muted" style={{ margin: '6px 0 0' }}>
                    Deze woning heeft nog geen parameter van het type “Elektriciteitsprijs”. Voeg
                    de sensor eerst toe onder Parameters.
                  </p>
                )}
                <p className="muted" style={{ fontSize: '0.85em', margin: '6px 0 0' }}>
                  Let op: niet elke “Elektriciteitsprijs”-parameter heeft uurdata — alleen de
                  sensor die HA's volledige daguur-curve publiceert werkt hier (vaak “gemiddelde
                  prijs” genoemd). Een “huidige prijs”-sensor van dezelfde integratie geeft meestal
                  maar één actuele waarde en toont dan “geen uurprijzen beschikbaar”.
                </p>
              </div>
            ) : (
              <>
                <div className="form-field">
                  <label>Periode</label>
                  <select value={form.range} onChange={(e) => setForm({ ...form, range: e.target.value })}>
                    {RANGE_OPTIONS.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-field">
                  <label>Parameters</label>
                  {parameterCategoryOptions.length > 0 && (
                    <select
                      value={parameterCategoryFilter}
                      onChange={(e) => setParameterCategoryFilter(e.target.value)}
                      style={{ marginBottom: 10, maxWidth: 260 }}
                    >
                      <option value="">Alle categorieën</option>
                      {parameterCategoryOptions.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  )}
                  {groupByCategory(filteredChartableParameters.filter((p) => !matchesAuto(p))).map(({ category, parameters: groupParams }) => (
                    <div key={category} style={{ marginBottom: 10 }}>
                      <div className="muted" style={{ fontSize: '0.8em', fontWeight: 600, marginBottom: 4 }}>
                        {category}
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                        {groupParams.map((p) => (
                          <label key={p._id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <input
                              type="checkbox"
                              checked={form.parameterIds.includes(p._id)}
                              onChange={() => toggleParameter(p._id)}
                            />
                            {p.label}
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                  {chartableParameters.length === 0 && (
                    <p className="muted" style={{ margin: 0 }}>
                      Deze woning heeft nog geen parameters.
                    </p>
                  )}
                  {chartableParameters.length > 0 && filteredChartableParameters.length === 0 && (
                    <p className="muted" style={{ margin: 0 }}>
                      Geen parameters in deze categorie.
                    </p>
                  )}
                </div>
              </>
            )}

            {supportsAutoInclude && (
              <div className="form-field">
                <label>Automatisch toevoegen</label>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <select
                    value={form.autoType}
                    onChange={(e) => {
                      const autoType = e.target.value;
                      const units = [
                        ...new Set(
                          chartableParameters.filter((p) => p.type === autoType).map((p) => (p.unit || '').trim())
                        ),
                      ];
                      setForm({ ...form, autoType, autoUnit: units.includes('W') ? 'W' : units[0] || '', excludedIds: [] });
                    }}
                  >
                    <option value="">— uit —</option>
                    {autoTypes.map((t) => (
                      <option key={t} value={t}>
                        alle van type {t}
                      </option>
                    ))}
                  </select>
                  {form.autoType && (
                    <select value={form.autoUnit} onChange={(e) => setForm({ ...form, autoUnit: e.target.value })}>
                      {autoUnits.map((u) => (
                        <option key={u} value={u}>
                          met eenheid {u || '(geen)'}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                {form.autoType && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 8 }}>
                    {autoMatches.map((p) => (
                      <label key={p._id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <input
                          type="checkbox"
                          checked={!form.excludedIds.includes(p._id)}
                          onChange={() =>
                            setForm((f) => ({
                              ...f,
                              excludedIds: f.excludedIds.includes(p._id)
                                ? f.excludedIds.filter((x) => x !== p._id)
                                : [...f.excludedIds, p._id],
                            }))
                          }
                        />
                        {p.label}
                      </label>
                    ))}
                    {autoMatches.length === 0 && (
                      <span className="muted">Geen parameters die hieraan voldoen.</span>
                    )}
                  </div>
                )}
                <p className="muted" style={{ fontSize: '0.85em', margin: '6px 0 0' }}>
                  Elke parameter van dit type en deze eenheid komt automatisch in de grafiek
                  {isEnergyFlow ? ' (als toestel rechtstreeks onder Thuis)' : ''}, ook die je later
                  toevoegt. Vink uit wat er niet in hoort (bv. een totaal zoals Thuisverbruik) — dat
                  blijft eruit. Parameters van een ander type kies je hierboven nog altijd zelf.
                </p>
              </div>
            )}

            <div className="form-field">
              <label>
                <input
                  type="checkbox"
                  checked={form.showOnDashboard}
                  onChange={(e) => setForm({ ...form, showOnDashboard: e.target.checked })}
                  style={{ marginRight: 6 }}
                />
                Toon op dashboard
              </label>
            </div>
            {error && <p className="error-text">{error}</p>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-primary" type="submit" disabled={!canSubmit}>
                {editingId ? 'Opslaan' : 'Toevoegen'}
              </button>
              {editingId && (
                <button type="button" className="btn" onClick={cancelEdit}>
                  Annuleren
                </button>
              )}
            </div>
          </form>
        </>
      )}
    </div>
  );
}
