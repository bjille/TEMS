import { useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
  fetchSmartChargePlans,
  createSmartChargePlan,
  updateSmartChargePlan,
  toggleSmartChargePlan,
  deleteSmartChargePlan,
  selectSmartChargePlansForWoning,
} from './smartChargeSlice';
import { fetchParameters, selectParametersForWoning } from '../parameters/parametersSlice';
import { selectSelectedWoningId, selectWoningen } from '../woningen/woningenSlice';
import { STATUS, colorForType } from '../../palette';

// Re-evaluate the plans' status this often while the page is open — matches
// the engine's own tick cadence, so what's shown here never lags far behind
// what actually drove (or would drive) the switch.
const REFRESH_MS = 5 * 60 * 1000;

const emptyForm = {
  name: '',
  capacityKwh: '',
  targetSocPercent: 100,
  maxChargePowerKw: '',
  socParameter: '',
  solarRemainingParameter: '',
  priceParameter: '',
  chargeSwitchParameter: '',
};

function ParameterSelect({ value, onChange, parameters, placeholder }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {parameters.map((p) => (
        <option key={p._id} value={p._id}>
          {p.label}
        </option>
      ))}
    </select>
  );
}

function formatKwh(value) {
  return typeof value === 'number' ? `${value.toFixed(2)} kWh` : '?';
}

function formatHour(timestamp) {
  return new Date(timestamp).toLocaleString('nl-BE', {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function PlanStatus({ status }) {
  if (!status) return <p className="muted">Status laden...</p>;
  if (!status.ready) {
    return <p className="error-text">{status.reason || 'Status niet beschikbaar'}</p>;
  }

  const dotColor = status.shortfallKwh <= 0 ? STATUS.good : status.shouldChargeNow ? STATUS.warning : 'var(--text-muted)';
  const headline =
    status.shortfallKwh <= 0
      ? 'Zon dekt de rest van vandaag — geen laadbeurt via het net nodig'
      : status.shouldChargeNow
      ? 'Laadt nu vanaf het net (dit is een van de goedkoopste uren)'
      : `Wacht op een goedkoper moment (${status.hoursNeeded} uur nog te plannen)`;

  return (
    <div>
      <div className="status-pill">
        <span className="status-dot" style={{ background: dotColor }} />
        {headline}
      </div>
      <p className="muted" style={{ margin: '6px 0 0', fontSize: '0.9em' }}>
        Huidige SOC: {status.currentSocPercent}% · Nog nodig tot streefwaarde:{' '}
        {formatKwh(status.neededKwh)} · Verwacht van zon vandaag: {formatKwh(status.solarRemainingKwh)} ·
        Van net: {formatKwh(status.shortfallKwh)}
      </p>
      {status.chargeHours.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          {status.chargeHours.map((h) => (
            <span
              key={h.timestamp}
              style={{
                fontSize: '0.8em',
                padding: '3px 8px',
                borderRadius: 999,
                background: `color-mix(in srgb, ${colorForType('battery_soc')} 18%, transparent)`,
                border: `1px solid ${colorForType('battery_soc')}`,
              }}
            >
              {formatHour(h.timestamp)} · {h.price.toFixed(3)} {status.priceUnit}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default function SmartChargePage() {
  const dispatch = useDispatch();
  const woningId = useSelector(selectSelectedWoningId);
  const woningen = useSelector(selectWoningen);
  const woning = woningen.find((w) => w._id === woningId);
  const parameters = useSelector(selectParametersForWoning(woningId));
  const plans = useSelector(selectSmartChargePlansForWoning(woningId));

  const canManage = woning?.role === 'owner' || woning?.role === 'superadmin';

  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState(null);

  const socParameters = useMemo(() => parameters.filter((p) => p.type === 'battery_soc'), [parameters]);
  const solarParameters = useMemo(() => parameters.filter((p) => p.type === 'solar_power'), [parameters]);
  const priceParameters = useMemo(() => parameters.filter((p) => p.type === 'electricity_price'), [parameters]);
  const switchParameters = useMemo(
    () => parameters.filter((p) => p.type === 'switch_controllable'),
    [parameters]
  );

  useEffect(() => {
    if (!woningId) return;
    dispatch(fetchParameters(woningId));
    dispatch(fetchSmartChargePlans(woningId));
    const interval = setInterval(() => dispatch(fetchSmartChargePlans(woningId)), REFRESH_MS);
    return () => clearInterval(interval);
  }, [woningId, dispatch]);

  function openEditForm(plan) {
    setEditingId(plan._id);
    setForm({
      name: plan.name,
      capacityKwh: plan.capacityKwh,
      targetSocPercent: plan.targetSocPercent,
      maxChargePowerKw: plan.maxChargePowerKw,
      socParameter: plan.socParameter?._id || '',
      solarRemainingParameter: plan.solarRemainingParameter?._id || '',
      priceParameter: plan.priceParameter?._id || '',
      chargeSwitchParameter: plan.chargeSwitchParameter?._id || '',
    });
    setShowForm(true);
    setError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setForm(emptyForm);
    setShowForm(false);
    setError(null);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    const payload = {
      name: form.name,
      capacityKwh: Number(form.capacityKwh),
      targetSocPercent: Number(form.targetSocPercent),
      maxChargePowerKw: Number(form.maxChargePowerKw),
      socParameter: form.socParameter,
      solarRemainingParameter: form.solarRemainingParameter,
      priceParameter: form.priceParameter,
      chargeSwitchParameter: form.chargeSwitchParameter,
    };
    try {
      if (editingId) {
        await dispatch(updateSmartChargePlan({ woningId, planId: editingId, ...payload })).unwrap();
      } else {
        await dispatch(createSmartChargePlan({ woningId, ...payload })).unwrap();
      }
      cancelEdit();
    } catch (err) {
      setError(err);
    }
  }

  async function handleDelete(planId) {
    if (!confirm('Dit slim-laadplan verwijderen?')) return;
    await dispatch(deleteSmartChargePlan({ woningId, planId }));
  }

  async function handleToggle(plan) {
    await dispatch(toggleSmartChargePlan({ woningId, planId: plan._id, enabled: !plan.enabled }));
  }

  if (!woningId) {
    return <p className="muted">Selecteer een specifieke woning via de dropdown om slim laden te beheren.</p>;
  }

  const canSubmit =
    form.name &&
    form.capacityKwh &&
    form.maxChargePowerKw &&
    form.socParameter &&
    form.solarRemainingParameter &&
    form.priceParameter &&
    form.chargeSwitchParameter;

  return (
    <div>
      <div className="section-header">
        <h1>Slim laden</h1>
        {canManage && !showForm && (
          <button className="btn btn-primary" onClick={() => setShowForm(true)}>
            + Nieuw plan
          </button>
        )}
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        Laadt de batterij (of een ander doel) enkel vanaf het net voor het deel dat de
        zonneprognose voor vandaag niet zal dekken — en kiest daarvoor de goedkoopste nog
        beschikbare uren.
      </p>

      {plans.length === 0 && !showForm && (
        <p className="muted">Nog geen slim-laadplan voor deze woning.</p>
      )}

      {plans.map((plan) => (
        <div key={plan._id} className="card" style={{ marginBottom: 16 }}>
          <div className="section-header" style={{ marginBottom: 8 }}>
            <h3 style={{ margin: 0 }}>{plan.name}</h3>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {canManage && (
                <button className="btn" onClick={() => handleToggle(plan)}>
                  {plan.enabled ? 'Slim laden: AAN' : 'Slim laden: UIT'}
                </button>
              )}
              {canManage && (
                <>
                  <button className="btn" onClick={() => openEditForm(plan)}>
                    Wijzigen
                  </button>
                  <button className="btn btn-danger" onClick={() => handleDelete(plan._id)}>
                    Verwijderen
                  </button>
                </>
              )}
            </div>
          </div>
          <p className="muted" style={{ fontSize: '0.85em', margin: '0 0 10px' }}>
            {plan.capacityKwh} kWh · streef {plan.targetSocPercent}% · max {plan.maxChargePowerKw} kW van het net
            {!plan.enabled && ' · alleen aanbeveling, schakelt de switch niet zelf'}
          </p>
          <PlanStatus status={plan.status} />
        </div>
      ))}

      {showForm && (
        <form className="card" onSubmit={handleSubmit} style={{ maxWidth: 480 }}>
          <h3 style={{ marginTop: 0 }}>{editingId ? 'Plan wijzigen' : 'Nieuw slim-laadplan'}</h3>
          <div className="form-field">
            <label>Naam</label>
            <input
              placeholder="Thuisbatterij"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
          </div>
          <div className="form-field">
            <label>Bruikbare capaciteit (kWh)</label>
            <input
              type="number"
              step="0.1"
              min="0.1"
              value={form.capacityKwh}
              onChange={(e) => setForm({ ...form, capacityKwh: e.target.value })}
              required
            />
          </div>
          <div className="form-field">
            <label>Streef-SOC (%)</label>
            <input
              type="number"
              min="1"
              max="100"
              value={form.targetSocPercent}
              onChange={(e) => setForm({ ...form, targetSocPercent: e.target.value })}
              required
            />
          </div>
          <div className="form-field">
            <label>Max. laadvermogen vanaf het net (kW)</label>
            <input
              type="number"
              step="0.01"
              min="0.01"
              value={form.maxChargePowerKw}
              onChange={(e) => setForm({ ...form, maxChargePowerKw: e.target.value })}
              required
            />
            <p className="muted" style={{ fontSize: '0.8em', margin: '4px 0 0' }}>
              Bv. 0.377 voor 377 W — bepaalt hoeveel uur nodig zijn om een tekort in te halen.
            </p>
          </div>
          <div className="form-field">
            <label>SOC-parameter (batterijpercentage)</label>
            <ParameterSelect
              value={form.socParameter}
              onChange={(v) => setForm({ ...form, socParameter: v })}
              parameters={socParameters}
              placeholder="— kies parameter —"
            />
          </div>
          <div className="form-field">
            <label>Zon-forecast (resterend vandaag, kWh)</label>
            <ParameterSelect
              value={form.solarRemainingParameter}
              onChange={(v) => setForm({ ...form, solarRemainingParameter: v })}
              parameters={solarParameters}
              placeholder="— kies parameter —"
            />
          </div>
          <div className="form-field">
            <label>Dynamische-prijzensensor (met uurcurve)</label>
            <ParameterSelect
              value={form.priceParameter}
              onChange={(v) => setForm({ ...form, priceParameter: v })}
              parameters={priceParameters}
              placeholder="— kies parameter —"
            />
          </div>
          <div className="form-field">
            <label>Laad-schakelaar (aan/uit vanaf het net)</label>
            <ParameterSelect
              value={form.chargeSwitchParameter}
              onChange={(v) => setForm({ ...form, chargeSwitchParameter: v })}
              parameters={switchParameters}
              placeholder="— kies parameter —"
            />
          </div>
          {error && <p className="error-text">{error}</p>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" type="submit" disabled={!canSubmit}>
              {editingId ? 'Opslaan' : 'Toevoegen'}
            </button>
            <button type="button" className="btn" onClick={cancelEdit}>
              Annuleren
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
