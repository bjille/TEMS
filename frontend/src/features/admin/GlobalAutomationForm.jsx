import { useState } from 'react';
import { useDispatch } from 'react-redux';
import { createGlobalAutomation, updateGlobalAutomation } from './globalAutomationsSlice';
import { buildCronExpression, parseCronExpression, DAY_LABELS, ALL_DAYS } from '../automations/cronUtils';

const OPERATORS = [
  { value: 'gt', label: '>' },
  { value: 'gte', label: '≥' },
  { value: 'lt', label: '<' },
  { value: 'lte', label: '≤' },
  { value: 'eq', label: '=' },
  { value: 'neq', label: '≠' },
];

const PARAMETER_TYPE_OPTIONS = [
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
  'custom',
];

const RECIPIENT_OPTIONS = [
  { value: 'woning_owners', label: 'Eigenaars van de woning' },
  { value: 'woning_users', label: 'Alle gebruikers van de woning' },
  { value: 'custom', label: 'Vaste e-mailadressen' },
];

function toInitialConditions(automation) {
  if (!automation) return [{ parameterType: 'battery_soc', operator: 'gte', value: '' }];
  return automation.conditions.map((c) => ({
    parameterType: c.parameterType,
    operator: c.operator,
    value: c.value,
  }));
}

export default function GlobalAutomationForm({ automation, onDone, onCancel }) {
  const dispatch = useDispatch();

  const initialCron = parseCronExpression(automation?.trigger?.cronExpression);

  const [name, setName] = useState(automation?.name || '');
  const [triggerType, setTriggerType] = useState(automation?.trigger?.type || 'state');
  const [hour, setHour] = useState(initialCron.hour);
  const [minute, setMinute] = useState(initialCron.minute);
  const [days, setDays] = useState(initialCron.days);
  const [conditions, setConditions] = useState(toInitialConditions(automation));
  const [subject, setSubject] = useState(automation?.action?.subject || '');
  const [message, setMessage] = useState(
    automation?.action?.message || 'Batterij van {{woning}} heeft de drempel bereikt.'
  );
  const [recipients, setRecipients] = useState(automation?.action?.recipients || 'woning_owners');
  const [customEmails, setCustomEmails] = useState((automation?.action?.customEmails || []).join(', '));
  const [cooldownMinutes, setCooldownMinutes] = useState(automation?.cooldownMinutes ?? 60);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  function updateCondition(index, patch) {
    setConditions((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  }

  function addCondition() {
    setConditions((prev) => [...prev, { parameterType: 'battery_soc', operator: 'gte', value: '' }]);
  }

  function removeCondition(index) {
    setConditions((prev) => prev.filter((_, i) => i !== index));
  }

  function toggleDay(day) {
    setDays((prev) => (prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);

    const trigger =
      triggerType === 'schedule'
        ? { type: 'schedule', cronExpression: buildCronExpression({ hour, minute, days }) }
        : { type: 'state' };

    const payload = {
      name,
      trigger,
      conditions: conditions.map((c) => ({
        parameterType: c.parameterType,
        operator: c.operator,
        value: c.value === '' || Number.isNaN(Number(c.value)) ? c.value : Number(c.value),
      })),
      action: {
        subject,
        message,
        recipients,
        customEmails:
          recipients === 'custom'
            ? customEmails
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
            : [],
      },
      cooldownMinutes: Number(cooldownMinutes),
    };

    setSaving(true);
    try {
      if (automation) {
        await dispatch(updateGlobalAutomation({ id: automation._id, ...payload })).unwrap();
      } else {
        await dispatch(createGlobalAutomation(payload)).unwrap();
      }
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="card" onSubmit={handleSubmit} style={{ maxWidth: 560 }}>
      <h3 style={{ marginTop: 0 }}>
        {automation ? 'Globale automatisering bewerken' : 'Nieuwe globale automatisering'}
      </h3>
      <p className="muted" style={{ fontSize: '0.85em', marginTop: -8 }}>
        Deze regel geldt voor alle woningen: de voorwaarde wordt per woning geëvalueerd op elke
        parameter van het gekozen type.
      </p>

      <div className="form-field">
        <label>Naam</label>
        <input value={name} onChange={(e) => setName(e.target.value)} required />
      </div>

      <div className="form-field">
        <label>Trigger</label>
        <select value={triggerType} onChange={(e) => setTriggerType(e.target.value)}>
          <option value="state">Bij nieuwe meting (state-based)</option>
          <option value="schedule">Op een vast tijdstip</option>
        </select>
      </div>

      {triggerType === 'schedule' && (
        <div className="form-field">
          <label>Tijdstip en dagen</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <input
              type="number"
              min={0}
              max={23}
              value={hour}
              onChange={(e) => setHour(Number(e.target.value))}
              style={{ width: 70 }}
            />
            <span>:</span>
            <input
              type="number"
              min={0}
              max={59}
              value={minute}
              onChange={(e) => setMinute(Number(e.target.value))}
              style={{ width: 70 }}
            />
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {ALL_DAYS.map((d) => (
              <button
                type="button"
                key={d}
                className="btn"
                style={days.includes(d) ? { borderColor: '#2a78d6', color: '#2a78d6' } : undefined}
                onClick={() => toggleDay(d)}
              >
                {DAY_LABELS[d]}
              </button>
            ))}
          </div>
          <p className="muted" style={{ fontSize: '0.8em' }}>
            Geen dag geselecteerd = elke dag.
          </p>
        </div>
      )}

      <div className="form-field">
        <label>Voorwaarden (allemaal moeten kloppen, per woning geëvalueerd)</label>
        {conditions.map((condition, index) => (
          <div key={index} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
            <select
              value={condition.parameterType}
              onChange={(e) => updateCondition(index, { parameterType: e.target.value })}
              style={{ flex: 2 }}
            >
              {PARAMETER_TYPE_OPTIONS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <select
              value={condition.operator}
              onChange={(e) => updateCondition(index, { operator: e.target.value })}
              style={{ flex: 1 }}
            >
              {OPERATORS.map((op) => (
                <option key={op.value} value={op.value}>
                  {op.label}
                </option>
              ))}
            </select>
            <input
              value={condition.value}
              onChange={(e) => updateCondition(index, { value: e.target.value })}
              placeholder="waarde (bv. 100)"
              required
              style={{ flex: 1 }}
            />
            {conditions.length > 1 && (
              <button type="button" className="btn btn-ghost" onClick={() => removeCondition(index)}>
                ✕
              </button>
            )}
          </div>
        ))}
        <button type="button" className="btn" onClick={addCondition}>
          + Voorwaarde toevoegen
        </button>
      </div>

      <div className="form-field">
        <label>E-mail onderwerp</label>
        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder={`TEMS: ${name || 'melding'}`}
        />
      </div>

      <div className="form-field">
        <label>E-mail bericht</label>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={3}
          style={{
            padding: '8px 10px',
            border: '1px solid var(--border)',
            borderRadius: 6,
            background: 'var(--surface-1)',
            color: 'var(--text-primary)',
            fontFamily: 'inherit',
          }}
        />
        <p className="muted" style={{ fontSize: '0.8em', margin: '4px 0 0' }}>
          Gebruik <code>{'{{woning}}'}</code> voor de naam van de woning.
        </p>
      </div>

      <div className="form-field">
        <label>Ontvangers</label>
        <select value={recipients} onChange={(e) => setRecipients(e.target.value)}>
          {RECIPIENT_OPTIONS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </div>

      {recipients === 'custom' && (
        <div className="form-field">
          <label>E-mailadressen (komma-gescheiden)</label>
          <input
            value={customEmails}
            onChange={(e) => setCustomEmails(e.target.value)}
            placeholder="klant@voorbeeld.be, support@voorbeeld.be"
          />
        </div>
      )}

      <div className="form-field">
        <label>Afkoelperiode per woning (minuten, voorkomt herhaaldelijke mails)</label>
        <input
          type="number"
          min={0}
          value={cooldownMinutes}
          onChange={(e) => setCooldownMinutes(e.target.value)}
          style={{ width: 100 }}
        />
      </div>

      {error && <p className="error-text">{error}</p>}

      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-primary" type="submit" disabled={saving}>
          {saving ? 'Bezig...' : 'Opslaan'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Annuleren
        </button>
      </div>
    </form>
  );
}
