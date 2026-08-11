import { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
  fetchGlobalAutomations,
  updateGlobalAutomation,
  deleteGlobalAutomation,
  selectAllGlobalAutomations,
} from './globalAutomationsSlice';
import GlobalAutomationForm from './GlobalAutomationForm';
import { DAY_LABELS, parseCronExpression } from '../automations/cronUtils';

const OPERATOR_LABELS = { gt: '>', gte: '≥', lt: '<', lte: '≤', eq: '=', neq: '≠' };
const RECIPIENT_LABELS = {
  woning_owners: 'eigenaars van de woning',
  woning_users: 'alle gebruikers van de woning',
  custom: 'vaste adressen',
};

function describeTrigger(automation) {
  if (automation.trigger.type === 'state') return 'Bij nieuwe meting';
  const { hour, minute, days } = parseCronExpression(automation.trigger.cronExpression);
  const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  const dayLabel = days.length === 0 ? 'elke dag' : days.map((d) => DAY_LABELS[d]).join(', ');
  return `Om ${time} (${dayLabel})`;
}

export default function AdminGlobalAutomations() {
  const dispatch = useDispatch();
  const automations = useSelector(selectAllGlobalAutomations);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);

  useEffect(() => {
    dispatch(fetchGlobalAutomations());
  }, [dispatch]);

  async function toggleEnabled(automation) {
    await dispatch(updateGlobalAutomation({ id: automation._id, enabled: !automation.enabled }));
  }

  async function handleDelete(automationId) {
    if (!confirm('Deze globale automatisering verwijderen?')) return;
    await dispatch(deleteGlobalAutomation(automationId));
  }

  return (
    <div>
      <div className="section-header">
        <h2>Globale automatiseringen</h2>
        <button
          className="btn btn-primary"
          onClick={() => {
            setEditing(null);
            setShowForm((s) => !s);
          }}
        >
          {showForm && !editing ? 'Annuleren' : '+ Nieuwe globale automatisering'}
        </button>
      </div>
      <p className="muted" style={{ marginTop: -8 }}>
        Deze regels gelden voor alle woningen tegelijk — bijvoorbeeld: stuur een e-mail naar de klant
        zodra de batterij van een woning 100% bereikt.
      </p>

      {showForm && (
        <div style={{ marginBottom: 20 }}>
          <GlobalAutomationForm
            automation={editing}
            onDone={() => {
              setShowForm(false);
              setEditing(null);
            }}
            onCancel={() => {
              setShowForm(false);
              setEditing(null);
            }}
          />
        </div>
      )}

      {automations.length === 0 ? (
        <p className="muted">Nog geen globale automatiseringen.</p>
      ) : (
        <div className="grid">
          {automations.map((automation) => (
            <div key={automation._id} className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                <h3 style={{ margin: '0 0 4px' }}>{automation.name}</h3>
                <button className="btn btn-ghost" onClick={() => toggleEnabled(automation)}>
                  {automation.enabled ? 'Actief' : 'Uit'}
                </button>
              </div>
              <p className="muted" style={{ fontSize: '0.85em' }}>
                {describeTrigger(automation)}
              </p>
              <p style={{ fontSize: '0.9em' }}>
                Als{' '}
                {automation.conditions.map((c, i) => (
                  <span key={i}>
                    {i > 0 && ' EN '}
                    <strong>{c.parameterType}</strong> {OPERATOR_LABELS[c.operator]} {c.value}
                  </span>
                ))}
                , dan e-mail naar <strong>{RECIPIENT_LABELS[automation.action.recipients]}</strong>.
              </p>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button
                  className="btn"
                  onClick={() => {
                    setEditing(automation);
                    setShowForm(true);
                  }}
                >
                  Bewerken
                </button>
                <button className="btn btn-danger" onClick={() => handleDelete(automation._id)}>
                  Verwijderen
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
