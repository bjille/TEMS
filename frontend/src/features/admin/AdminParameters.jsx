import { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { fetchWoningen, selectWoningen } from '../woningen/woningenSlice';
import {
  fetchParameters,
  createParameter,
  updateParameter,
  deleteParameter,
  selectParametersForWoning,
} from '../parameters/parametersSlice';
import { colorForType, CATEGORICAL } from '../../palette';

const TYPE_OPTIONS = [
  'battery_soc',
  'battery_power',
  'solar_power',
  'electricity_price',
  'grid_power',
  'switch_consumer',
  'switch_controllable',
  'select_mode',
  'ev_charger_power',
  'ev_status',
  'custom',
];

const emptyForm = {
  entityId: '',
  type: 'custom',
  label: '',
  unit: '',
  icon: '',
  controllable: false,
  favorite: false,
};

export default function AdminParameters() {
  const dispatch = useDispatch();
  const woningen = useSelector(selectWoningen);
  const [woningId, setWoningId] = useState('');
  const parameters = useSelector(selectParametersForWoning(woningId));
  const [form, setForm] = useState(emptyForm);
  const [optionsText, setOptionsText] = useState('');
  const [aliasMap, setAliasMap] = useState({});
  const [editingId, setEditingId] = useState(null);
  const [error, setError] = useState(null);

  const parsedOptions =
    form.type === 'select_mode'
      ? optionsText
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

  useEffect(() => {
    dispatch(fetchWoningen());
  }, [dispatch]);

  useEffect(() => {
    if (!woningId && woningen[0]) setWoningId(woningen[0]._id);
  }, [woningen, woningId]);

  useEffect(() => {
    if (woningId) dispatch(fetchParameters(woningId));
  }, [woningId, dispatch]);

  function openEditForm(parameter) {
    setEditingId(parameter._id);
    setForm({
      entityId: parameter.entityId,
      type: parameter.type,
      label: parameter.label,
      unit: parameter.unit || '',
      icon: parameter.icon || '',
      controllable: parameter.controllable,
      favorite: parameter.favorite,
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
        const { type, label, unit, icon, controllable, favorite } = form;
        await dispatch(
          updateParameter({
            woningId,
            parameterId: editingId,
            type,
            label,
            unit,
            icon,
            controllable,
            favorite,
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
    if (!confirm('Deze parameter verwijderen?')) return;
    await dispatch(deleteParameter({ woningId, parameterId }));
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
          <table className="table" style={{ marginBottom: 24 }}>
            <thead>
              <tr>
                <th>Label</th>
                <th>Entity ID</th>
                <th>Type</th>
                <th>Eenheid</th>
                <th>Stuurbaar</th>
                <th>Favoriet</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {parameters.map((p) => (
                <tr key={p._id}>
                  <td>
                    <span
                      className="status-dot"
                      style={{ background: colorForType(p.type), marginRight: 6 }}
                    />
                    {p.label}
                  </td>
                  <td className="muted">{p.entityId}</td>
                  <td>{p.type}</td>
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
                  <td style={{ display: 'flex', gap: 8 }}>
                    <button className="btn" onClick={() => openEditForm(p)}>
                      Wijzigen
                    </button>
                    <button className="btn btn-danger" onClick={() => handleDelete(p._id)}>
                      Verwijderen
                    </button>
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
