import { useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { fetchWoningen, selectWoningen } from '../woningen/woningenSlice';
import { fetchParameters, selectParametersForWoning } from '../parameters/parametersSlice';
import { fetchCharts, createChart, updateChart, deleteChart, selectChartsForWoning } from '../charts/chartsSlice';
import { groupByCategory } from '../parameters/parameterCategories';

const TYPE_OPTIONS = [
  { value: 'line', label: 'Lijn' },
  { value: 'area', label: 'Vlak' },
  { value: 'bar', label: 'Balken' },
  { value: 'energyflow', label: 'Energieflow' },
];

const RANGE_OPTIONS = [
  { value: 24, label: '24 uur' },
  { value: 24 * 7, label: '7 dagen' },
  { value: 24 * 30, label: '30 dagen' },
];

const FLOW_ROLES = [
  { key: 'pv', label: 'Zonnepanelen (PV-opwek)' },
  { key: 'battery', label: 'Batterij (signed: + ontladen, − laden)' },
  { key: 'grid', label: 'Net (signed: + import, − export)' },
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
  rangeHours: 24,
  parameterIds: [],
  flowRoles: { pv: '', battery: '', grid: '' },
  devices: [], // [{ parameterId, parentId }] — parentId '' means directly under Thuis
  circular: false,
  showOnDashboard: false,
};

function chartSummary(chart) {
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
  const [woningId, setWoningId] = useState('');
  const parameters = useSelector(selectParametersForWoning(woningId));
  const chartableParameters = useMemo(
    () => parameters.filter((p) => !isSwitchEntity(p)),
    [parameters]
  );
  const charts = useSelector(selectChartsForWoning(woningId));
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState(null);
  const [error, setError] = useState(null);

  const isEnergyFlow = form.type === 'energyflow';
  const canSubmit = isEnergyFlow
    ? Object.values(form.flowRoles).some(Boolean)
    : form.parameterIds.length > 0;

  useEffect(() => {
    dispatch(fetchWoningen());
  }, [dispatch]);

  useEffect(() => {
    if (!woningId && woningen[0]) setWoningId(woningen[0]._id);
  }, [woningen, woningId]);

  useEffect(() => {
    if (woningId) {
      dispatch(fetchParameters(woningId));
      dispatch(fetchCharts(woningId));
    }
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
      rangeHours: chart.rangeHours,
      parameterIds: chart.parameters.map((p) => p._id),
      flowRoles: {
        pv: chart.flowRoles?.pv?._id || '',
        battery: chart.flowRoles?.battery?._id || '',
        grid: chart.flowRoles?.grid?._id || '',
      },
      devices: (chart.devices || [])
        .filter((d) => d.parameter)
        .map((d) => ({
          parameterId: d.parameter._id,
          parentId: d.parent?._id || '',
        })),
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
      rangeHours: form.rangeHours,
      showOnDashboard: form.showOnDashboard,
      ...(isEnergyFlow
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
        : { parameters: form.parameterIds, flowRoles: {}, devices: [], circular: false }),
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
                  <td>{c.type === 'energyflow' ? 'live' : RANGE_OPTIONS.find((r) => r.value === c.rangeHours)?.label || `${c.rangeHours}u`}</td>
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

            {isEnergyFlow ? (
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
            ) : (
              <>
                <div className="form-field">
                  <label>Periode</label>
                  <select
                    value={form.rangeHours}
                    onChange={(e) => setForm({ ...form, rangeHours: Number(e.target.value) })}
                  >
                    {RANGE_OPTIONS.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-field">
                  <label>Parameters</label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                    {chartableParameters.map((p) => (
                      <label key={p._id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <input
                          type="checkbox"
                          checked={form.parameterIds.includes(p._id)}
                          onChange={() => toggleParameter(p._id)}
                        />
                        {p.label}
                      </label>
                    ))}
                    {chartableParameters.length === 0 && (
                      <p className="muted" style={{ margin: 0 }}>
                        Deze woning heeft nog geen parameters.
                      </p>
                    )}
                  </div>
                </div>
              </>
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
