import { useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { createAutomation, updateAutomation } from './automationsSlice';
import { selectParametersForWoning } from '../parameters/parametersSlice';
import { buildCronExpression, parseCronExpression, DAY_LABELS, ALL_DAYS } from './cronUtils';

const OPERATORS = [
  { value: 'gt', label: '>' },
  { value: 'gte', label: '≥' },
  { value: 'lt', label: '<' },
  { value: 'lte', label: '≤' },
  { value: 'eq', label: '=' },
  { value: 'neq', label: '≠' },
];

function toInitialConditions(automation) {
  if (!automation) return [{ parameter: '', operator: 'gt', value: '' }];
  return automation.conditions.map((c) => ({
    parameter: c.parameter?._id || c.parameter,
    operator: c.operator,
    value: c.value,
  }));
}

export default function AutomationForm({ woningId, automation, onDone, onCancel }) {
  const dispatch = useDispatch();
  const parameters = useSelector(selectParametersForWoning(woningId));
  const controllableParameters = parameters.filter((p) => p.controllable);

  const initialCron = parseCronExpression(automation?.trigger?.cronExpression);

  const [name, setName] = useState(automation?.name || '');
  const [triggerType, setTriggerType] = useState(automation?.trigger?.type || 'state');
  const [hour, setHour] = useState(initialCron.hour);
  const [minute, setMinute] = useState(initialCron.minute);
  const [days, setDays] = useState(initialCron.days);
  const [conditions, setConditions] = useState(toInitialConditions(automation));
  const [actionParameter, setActionParameter] = useState(
    automation?.action?.parameter?._id || automation?.action?.parameter || ''
  );
  const [actionName, setActionName] = useState(automation?.action?.action || 'turn_on');
  const [actionOption, setActionOption] = useState(automation?.action?.payload?.option || '');
  const [cooldownMinutes, setCooldownMinutes] = useState(automation?.cooldownMinutes ?? 5);

  const selectedActionParameter = controllableParameters.find((p) => p._id === actionParameter);
  const isSelectAction = selectedActionParameter?.type === 'select_mode';

  function handleActionParameterChange(parameterId) {
    setActionParameter(parameterId);
    const parameter = controllableParameters.find((p) => p._id === parameterId);
    if (parameter?.type === 'select_mode') {
      setActionName('select_option');
      setActionOption(parameter.options?.[0] || '');
    } else if (actionName === 'select_option') {
      setActionName('turn_on');
    }
  }
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  function updateCondition(index, patch) {
    setConditions((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  }

  function addCondition() {
    setConditions((prev) => [...prev, { parameter: '', operator: 'gt', value: '' }]);
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
        parameter: c.parameter,
        operator: c.operator,
        value: c.value === '' || Number.isNaN(Number(c.value)) ? c.value : Number(c.value),
      })),
      action: {
        parameter: actionParameter,
        action: isSelectAction ? 'select_option' : actionName,
        ...(isSelectAction ? { payload: { option: actionOption } } : {}),
      },
      cooldownMinutes: Number(cooldownMinutes),
    };

    setSaving(true);
    try {
      if (automation) {
        await dispatch(
          updateAutomation({ woningId, automationId: automation._id, ...payload })
        ).unwrap();
      } else {
        await dispatch(createAutomation({ woningId, ...payload })).unwrap();
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
      <h3 style={{ marginTop: 0 }}>{automation ? 'Automatisering bewerken' : 'Nieuwe automatisering'}</h3>

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
        <label>Voorwaarden (allemaal moeten kloppen)</label>
        {conditions.map((condition, index) => (
          <div key={index} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
            <select
              value={condition.parameter}
              onChange={(e) => updateCondition(index, { parameter: e.target.value })}
              required
              style={{ flex: 2 }}
            >
              <option value="" disabled>
                Kies parameter
              </option>
              {parameters.map((p) => (
                <option key={p._id} value={p._id}>
                  {p.label}
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
              placeholder="waarde"
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
        <label>Actie</label>
        <div style={{ display: 'flex', gap: 6 }}>
          <select
            value={actionParameter}
            onChange={(e) => handleActionParameterChange(e.target.value)}
            required
            style={{ flex: 2 }}
          >
            <option value="" disabled>
              Kies stuurbaar toestel
            </option>
            {controllableParameters.map((p) => (
              <option key={p._id} value={p._id}>
                {p.label}
              </option>
            ))}
          </select>
          {isSelectAction ? (
            <select
              value={actionOption}
              onChange={(e) => setActionOption(e.target.value)}
              required
              style={{ flex: 1 }}
            >
              {(selectedActionParameter.options || []).map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          ) : (
            <select value={actionName} onChange={(e) => setActionName(e.target.value)} style={{ flex: 1 }}>
              <option value="turn_on">Inschakelen</option>
              <option value="turn_off">Uitschakelen</option>
            </select>
          )}
        </div>
        {controllableParameters.length === 0 && (
          <p className="error-text" style={{ fontSize: '0.85em' }}>
            Geen stuurbare parameters voor deze woning. Voeg er eerst een toe via Admin → Parameters.
          </p>
        )}
      </div>

      <div className="form-field">
        <label>Afkoelperiode (minuten, voorkomt herhaaldelijk afvuren)</label>
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
