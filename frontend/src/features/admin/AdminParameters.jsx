import { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { fetchWoningen, selectWoningen, selectSelectedWoningId } from '../woningen/woningenSlice';
import {
  fetchParameters,
  createParameter,
  updateParameter,
  deleteParameter,
  copyParameter,
  selectParametersForWoning,
} from '../parameters/parametersSlice';
import { colorForType, CATEGORICAL } from '../../palette';
import { categoryLabel, collectCategories, sortParameters } from '../parameters/parameterCategories';
import { fetchParameterCategories, selectParameterCategories } from '../parameters/parameterCategoriesSlice';
import CopyToWoningen from '../../components/CopyToWoningen';
import { api } from '../../services/api';

const TYPE_OPTIONS = [
  'battery_soc',
  'battery_power',
  'solar_power',
  'electricity_price',
  'grid_power',
  'switch_consumer',
  'switch_controllable',
  'select_mode',
  'number_controllable',
  'ev_charger_power',
  'ev_status',
  'energy_consumption',
  'energy_meter',
  'gas_price',
  'custom',
];

const emptyForm = {
  entityId: '',
  energyEntityId: '',
  type: 'custom',
  label: '',
  unit: '',
  icon: '',
  category: '',
  controllable: false,
  favorite: false,
  badge: false,
  invert: false,
};

export default function AdminParameters() {
  const dispatch = useDispatch();
  const woningen = useSelector(selectWoningen);
  const selectedWoningId = useSelector(selectSelectedWoningId);
  const [woningId, setWoningId] = useState('');
  const parameters = useSelector(selectParametersForWoning(woningId));
  const [form, setForm] = useState(emptyForm);
  const [optionsText, setOptionsText] = useState('');
  const [aliasMap, setAliasMap] = useState({});
  const [editingId, setEditingId] = useState(null);
  const [error, setError] = useState(null);
  const [categoryFilter, setCategoryFilter] = useState('');
  const [sortBy, setSortBy] = useState('category');
  const [sortDir, setSortDir] = useState('asc');
  const managedCategories = useSelector(selectParameterCategories);
  // null until searched; then [{ parameterId, label, entityId, candidates }]
  const [suggestions, setSuggestions] = useState(null);
  const [suggestionChoice, setSuggestionChoice] = useState({});
  const [suggestionState, setSuggestionState] = useState({ loading: false, error: null });

  const categories = collectCategories(parameters, managedCategories);
  const filteredParameters = categoryFilter
    ? parameters.filter((p) => categoryLabel(p.category) === categoryFilter)
    : parameters;
  const visibleParameters = sortParameters(filteredParameters, sortBy, sortDir);

  function toggleSort(column) {
    if (sortBy === column) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(column);
      setSortDir('asc');
    }
  }

  function sortIndicator(column) {
    if (sortBy !== column) return null;
    return sortDir === 'asc' ? ' ▲' : ' ▼';
  }

  const parsedOptions =
    form.type === 'select_mode'
      ? optionsText
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

  useEffect(() => {
    dispatch(fetchWoningen());
    dispatch(fetchParameterCategories());
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
    if (woningId) dispatch(fetchParameters(woningId));
  }, [woningId, dispatch]);

  function openEditForm(parameter) {
    setEditingId(parameter._id);
    setForm({
      entityId: parameter.entityId,
      energyEntityId: parameter.energyEntityId || '',
      type: parameter.type,
      label: parameter.label,
      unit: parameter.unit || '',
      icon: parameter.icon || '',
      category: parameter.category || '',
      controllable: parameter.controllable,
      favorite: parameter.favorite,
      badge: parameter.badge || false,
      invert: parameter.invert || false,
    });
    setOptionsText((parameter.options || []).join(', '));
    setAliasMap(parameter.optionLabels || {});
    setError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setForm(emptyForm);
    setOptionsText('');
    setAliasMap({});
    setError(null);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    const options = parsedOptions;
    const optionLabels = {};
    options.forEach((opt) => {
      const alias = (aliasMap[opt] || '').trim();
      if (alias && alias !== opt) optionLabels[opt] = alias;
    });
    try {
      if (editingId) {
        const { energyEntityId, type, label, unit, icon, category, controllable, favorite, badge, invert } = form;
        await dispatch(
          updateParameter({
            woningId,
            parameterId: editingId,
            energyEntityId: energyEntityId.trim(),
            type,
            label,
            unit,
            icon,
            category,
            controllable,
            favorite,
            badge,
            invert,
            options,
            optionLabels,
          })
        ).unwrap();
        setEditingId(null);
      } else {
        await dispatch(createParameter({ woningId, ...form, options, optionLabels })).unwrap();
      }
      setForm(emptyForm);
      setOptionsText('');
      setAliasMap({});
    } catch (err) {
      setError(err);
    }
  }

  async function handleDelete(parameterId) {
    // Warn about — and name — whatever still uses this parameter, since
    // deleting it leaves those charts, automations, cost calculations or
    // smart-charge plans with a missing sensor.
    const label = parameters.find((p) => p._id === parameterId)?.label || 'deze parameter';
    let usages = [];
    try {
      ({ data: usages } = await api.get(`/woningen/${woningId}/parameters/${parameterId}/usages`));
    } catch {
      usages = null;
    }
    const message =
      usages === null
        ? `Kon niet nagaan waar "${label}" nog gebruikt wordt. Toch verwijderen?`
        : usages.length > 0
        ? `"${label}" is nog gekoppeld aan:\n\n${usages
            .map((u) => `• ${u.kind} "${u.name}" (${u.roles.join(', ')})`)
            .join('\n')}\n\nDie werken niet meer correct zonder deze parameter. Toch verwijderen?`
        : `"${label}" verwijderen?`;
    if (!confirm(message)) return;
    await dispatch(deleteParameter({ woningId, parameterId }));
  }

  // Looks up, per power parameter, the energy (kWh) sensors on the same HA
  // device — what HA's energy dashboard pairs as a device's long-term sensor.
  async function findEnergySensors() {
    setSuggestionState({ loading: true, error: null });
    try {
      const { data } = await api.get(`/woningen/${woningId}/parameters/energy-suggestions`);
      setSuggestions(data);
      // Only preselected when the device has a single energy sensor: on a
      // multi-sensor device (an inverter, a P1 meter) the right one is a choice.
      setSuggestionChoice(
        Object.fromEntries(data.map((s) => [s.parameterId, s.candidates.length === 1 ? s.candidates[0].entityId : '']))
      );
      setSuggestionState({ loading: false, error: null });
    } catch (err) {
      setSuggestionState({ loading: false, error: err.response?.data?.error?.message || 'Zoeken mislukt' });
    }
  }

  async function linkEnergySensors(parameterIds) {
    for (const parameterId of parameterIds) {
      const energyEntityId = suggestionChoice[parameterId];
      if (!energyEntityId) continue;
      await dispatch(updateParameter({ woningId, parameterId, energyEntityId })).unwrap();
      setSuggestions((list) => list.filter((s) => s.parameterId !== parameterId));
    }
  }

  async function toggleControllable(parameter) {
    await dispatch(
      updateParameter({
        woningId,
        parameterId: parameter._id,
        controllable: !parameter.controllable,
      })
    );
  }

  async function toggleFavorite(parameter) {
    await dispatch(
      updateParameter({
        woningId,
        parameterId: parameter._id,
        favorite: !parameter.favorite,
      })
    );
  }

  async function toggleBadge(parameter) {
    await dispatch(
      updateParameter({
        woningId,
        parameterId: parameter._id,
        badge: !parameter.badge,
      })
    );
  }

  async function toggleInvert(parameter) {
    await dispatch(
      updateParameter({
        woningId,
        parameterId: parameter._id,
        invert: !parameter.invert,
      })
    );
  }

  return (
    <div>
      <div className="section-header">
        <h2>Parameters</h2>
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
          <div className="section-header" style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', gap: 16 }}>
              <div className="form-field" style={{ marginBottom: 0, minWidth: 200 }}>
                <label>Filter op categorie</label>
                <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
                  <option value="">Alle categorieën</option>
                  {categories.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                  <option value="Overig">Overig</option>
                </select>
              </div>
            </div>
          </div>
          <EnergySuggestions
            suggestions={suggestions}
            choice={suggestionChoice}
            setChoice={setSuggestionChoice}
            state={suggestionState}
            onSearch={findEnergySensors}
            onLink={linkEnergySensors}
            onClose={() => setSuggestions(null)}
          />
          <table className="table" style={{ marginBottom: 24 }}>
            <thead>
              <tr>
                <th style={{ cursor: 'pointer' }} onClick={() => toggleSort('label')}>
                  Label{sortIndicator('label')}
                </th>
                <th>Entity ID</th>
                <th style={{ cursor: 'pointer' }} onClick={() => toggleSort('type')}>
                  Type{sortIndicator('type')}
                </th>
                <th style={{ cursor: 'pointer' }} onClick={() => toggleSort('category')}>
                  Categorie{sortIndicator('category')}
                </th>
                <th style={{ cursor: 'pointer' }} onClick={() => toggleSort('unit')}>
                  Eenheid{sortIndicator('unit')}
                </th>
                <th>Stuurbaar</th>
                <th>Favoriet</th>
                <th>Badge</th>
                <th>Omgekeerd</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visibleParameters.map((p) => (
                <tr key={p._id}>
                  <td>
                    <span
                      className="status-dot"
                      style={{ background: colorForType(p.type), marginRight: 6 }}
                    />
                    {p.label}
                  </td>
                  <td className="muted">
                    {p.entityId}
                    {p.energyEntityId && (
                      <div title="Lange termijn (energie)" style={{ fontSize: '0.85em' }}>
                        ⚡ {p.energyEntityId}
                      </div>
                    )}
                  </td>
                  <td>{p.type}</td>
                  <td>{categoryLabel(p.category)}</td>
                  <td>{p.unit}</td>
                  <td>
                    <button className="btn" onClick={() => toggleControllable(p)}>
                      {p.controllable ? 'Ja' : 'Nee'}
                    </button>
                  </td>
                  <td>
                    <button
                      className="btn"
                      style={p.favorite ? { borderColor: CATEGORICAL.yellow, color: CATEGORICAL.yellow } : undefined}
                      onClick={() => toggleFavorite(p)}
                    >
                      {p.favorite ? '★ Ja' : '☆ Nee'}
                    </button>
                  </td>
                  <td>
                    <button
                      className="btn"
                      style={p.badge ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
                      onClick={() => toggleBadge(p)}
                    >
                      {p.badge ? 'Ja' : 'Nee'}
                    </button>
                  </td>
                  <td>
                    <button className="btn" onClick={() => toggleInvert(p)}>
                      {p.invert ? 'Ja (×-1)' : 'Nee'}
                    </button>
                  </td>
                  <td style={{ display: 'flex', gap: 8 }}>
                    <button className="btn" onClick={() => openEditForm(p)}>
                      Wijzigen
                    </button>
                    <button className="btn btn-danger" onClick={() => handleDelete(p._id)}>
                      Verwijderen
                    </button>
                    <CopyToWoningen
                      woningen={woningen}
                      currentWoningId={woningId}
                      onCopy={(targetWoningIds) =>
                        dispatch(
                          copyParameter({ woningId, parameterId: p._id, targetWoningIds })
                        ).unwrap()
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <form className="card" onSubmit={handleSubmit} style={{ maxWidth: 480 }}>
            <h3 style={{ marginTop: 0 }}>{editingId ? 'Parameter wijzigen' : 'Nieuwe parameter'}</h3>
            <div className="form-field">
              <label>HA entity_id</label>
              <input
                placeholder="sensor.batterij_soc"
                value={form.entityId}
                onChange={(e) => setForm({ ...form, entityId: e.target.value })}
                required
                disabled={!!editingId}
              />
            </div>
            <div className="form-field">
              <label>Lange termijn-sensor (energie, optioneel)</label>
              <input
                placeholder="sensor.koffiezet_energie"
                value={form.energyEntityId}
                onChange={(e) => setForm({ ...form, energyEntityId: e.target.value })}
              />
              <p className="muted" style={{ fontSize: '0.85em', margin: '4px 0 0' }}>
                Zoals in het energiedashboard van Home Assistant: een kWh-teller van hetzelfde
                toestel. De entity_id hierboven levert dan enkel de live waarde (TEMS bewaart
                alleen de laatste); uur-, dag-, maand- en jaarrapportering komt uit de
                statistieken van deze sensor.
              </p>
            </div>
            <div className="form-field">
              <label>Type</label>
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                {TYPE_OPTIONS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            {form.type === 'select_mode' && (
              <div className="form-field">
                <label>Opties (komma-gescheiden)</label>
                <input
                  placeholder="auto, eco, handmatig"
                  value={optionsText}
                  onChange={(e) => setOptionsText(e.target.value)}
                  required
                />
                <p className="muted" style={{ fontSize: '0.85em', margin: '4px 0 0' }}>
                  Moet overeenkomen met de <code>options</code> van de HA select-entity, bv.{' '}
                  <code>select.garage_emma_ess_regelmodus</code>.
                </p>
              </div>
            )}
            {form.type === 'select_mode' && parsedOptions.length > 0 && (
              <div className="form-field">
                <label>Weergavenamen (optioneel)</label>
                {parsedOptions.map((opt) => (
                  <div key={opt} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <code className="muted" style={{ minWidth: 140 }}>
                      {opt}
                    </code>
                    <input
                      placeholder={opt}
                      value={aliasMap[opt] || ''}
                      onChange={(e) => setAliasMap({ ...aliasMap, [opt]: e.target.value })}
                    />
                  </div>
                ))}
                <p className="muted" style={{ fontSize: '0.85em', margin: '4px 0 0' }}>
                  Laat leeg om de ruwe waarde te tonen. De ruwe waarde wordt nog steeds naar HA
                  gestuurd bij bediening.
                </p>
              </div>
            )}
            <div className="form-field">
              <label>Label</label>
              <input
                value={form.label}
                onChange={(e) => setForm({ ...form, label: e.target.value })}
                required
              />
            </div>
            <div className="form-field">
              <label>Eenheid (optioneel)</label>
              <input
                placeholder="%, W, €/kWh"
                value={form.unit}
                onChange={(e) => setForm({ ...form, unit: e.target.value })}
              />
            </div>
            <div className="form-field">
              <label>Categorie (optioneel)</label>
              <select
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
              >
                <option value="">— Overig —</option>
                {managedCategories.map((c) => (
                  <option key={c._id} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
              <p className="muted" style={{ fontSize: '0.85em', margin: '4px 0 0' }}>
                Groepeert deze parameter bij het invoeren en op het dashboard. Categorieën beheer
                je onder <em>Admin → Categorieën</em>.
              </p>
            </div>
            <div className="form-field">
              <label>
                <input
                  type="checkbox"
                  checked={form.controllable}
                  onChange={(e) => setForm({ ...form, controllable: e.target.checked })}
                  style={{ marginRight: 6 }}
                />
                Stuurbaar
              </label>
              {form.controllable && (
                <p className="muted" style={{ fontSize: '0.85em', margin: '4px 0 0' }}>
                  Het HA-servicedomein wordt automatisch afgeleid uit de entity_id (bv.{' '}
                  <code>light.x</code> → <code>light</code>).
                </p>
              )}
            </div>
            <div className="form-field">
              <label>
                <input
                  type="checkbox"
                  checked={form.favorite}
                  onChange={(e) => setForm({ ...form, favorite: e.target.checked })}
                  style={{ marginRight: 6 }}
                />
                Favoriet (getoond in het overzicht van alle installaties)
              </label>
            </div>
            <div className="form-field">
              <label>
                <input
                  type="checkbox"
                  checked={form.badge}
                  onChange={(e) => setForm({ ...form, badge: e.target.checked })}
                  style={{ marginRight: 6 }}
                />
                Badge (live waarde bovenaan het dashboard en de detailgrafieken)
              </label>
            </div>
            <div className="form-field">
              <label>
                <input
                  type="checkbox"
                  checked={form.invert}
                  onChange={(e) => setForm({ ...form, invert: e.target.checked })}
                  style={{ marginRight: 6 }}
                />
                Waarde omkeren (× -1)
              </label>
              <p className="muted" style={{ fontSize: '0.85em', margin: '4px 0 0' }}>
                Draait het teken van elke binnenkomende meting om, bv. om een altijd-positieve
                vermogenssensor als negatief (export) te tonen. Geldt alleen voor nieuwe metingen.
              </p>
            </div>
            {error && <p className="error-text">{error}</p>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-primary" type="submit">
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

// Proposes, per power parameter without one, the energy sensor of the same
// HA device as its long-term sensor.
function EnergySuggestions({ suggestions, choice, setChoice, state, onSearch, onLink, onClose }) {
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState(null);
  async function link(ids) {
    setLinking(true);
    setError(null);
    try {
      await onLink(ids);
    } catch (err) {
      setError(typeof err === 'string' ? err : 'Koppelen mislukt');
    }
    setLinking(false);
  }

  if (suggestions === null) {
    return (
      <div style={{ marginBottom: 12 }}>
        <button className="btn" onClick={onSearch} disabled={state.loading}>
          {state.loading ? 'Zoeken…' : '⚡ Energiesensoren zoeken voor lange termijn'}
        </button>
        {state.error && <p className="error-text">{state.error}</p>}
      </div>
    );
  }

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="section-header" style={{ marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>Lange termijn-sensoren</h3>
        <button className="btn btn-ghost" onClick={onClose}>
          Sluiten
        </button>
      </div>
      {suggestions.length === 0 ? (
        <p className="muted">
          Geen voorstellen: elke vermogensparameter met een energiesensor op hetzelfde toestel is al gekoppeld.
        </p>
      ) : (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            Energiesensoren (kWh) op hetzelfde Home Assistant-toestel als de vermogenssensor. Bij
            het koppelen wordt de opgeslagen live-historiek van die parameter verwijderd, op de
            laatste waarde na.
          </p>
          <table className="table">
            <thead>
              <tr>
                <th>Parameter</th>
                <th>Live (vermogen)</th>
                <th>Lange termijn (energie)</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {suggestions.map((s) => (
                <tr key={s.parameterId}>
                  <td>{s.label}</td>
                  <td className="muted">{s.entityId}</td>
                  <td>
                    <select
                      value={choice[s.parameterId] || ''}
                      onChange={(e) => setChoice({ ...choice, [s.parameterId]: e.target.value })}
                    >
                      <option value="">— niet koppelen —</option>
                      {s.candidates.map((c) => (
                        <option key={c.entityId} value={c.entityId}>
                          {c.name} ({c.entityId})
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <button
                      className="btn"
                      disabled={linking || !choice[s.parameterId]}
                      onClick={() => link([s.parameterId])}
                    >
                      Koppelen
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button
            className="btn btn-primary"
            disabled={linking}
            onClick={() => link(suggestions.map((s) => s.parameterId))}
          >
            {linking ? 'Koppelen…' : 'Alle gekozen koppelen'}
          </button>
          {error && <p className="error-text">{error}</p>}
        </>
      )}
    </div>
  );
}
