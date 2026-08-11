import { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
  fetchAutomations,
  updateAutomation,
  deleteAutomation,
  selectAutomationsForWoning,
} from './automationsSlice';
import { fetchParameters } from '../parameters/parametersSlice';
import { selectSelectedWoningId, selectWoningen } from '../woningen/woningenSlice';
import AutomationForm from './AutomationForm';
import { DAY_LABELS, parseCronExpression } from './cronUtils';

const OPERATOR_LABELS = { gt: '>', gte: '≥', lt: '<', lte: '≤', eq: '=', neq: '≠' };
const ACTION_LABELS = { turn_on: 'inschakelen', turn_off: 'uitschakelen' };

function describeAction(automation) {
  if (automation.action.action === 'select_option') {
    return `instellen op "${automation.action.payload?.option}"`;
  }
  return ACTION_LABELS[automation.action.action] || automation.action.action;
}

function describeTrigger(automation) {
  if (automation.trigger.type === 'state') return 'Bij nieuwe meting';
  const { hour, minute, days } = parseCronExpression(automation.trigger.cronExpression);
  const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  const dayLabel = days.length === 0 ? 'elke dag' : days.map((d) => DAY_LABELS[d]).join(', ');
  return `Om ${time} (${dayLabel})`;
}

export default function AutomationsPage() {
  const dispatch = useDispatch();
  const woningId = useSelector(selectSelectedWoningId);
  const woningen = useSelector(selectWoningen);
  const woning = woningen.find((w) => w._id === woningId);
  const automations = useSelector(selectAutomationsForWoning(woningId));

  const canManage = woning?.role === 'owner' || woning?.role === 'superadmin';

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);

  useEffect(() => {
    if (woningId) {
      dispatch(fetchAutomations(woningId));
      dispatch(fetchParameters(woningId));
    }
  }, [woningId, dispatch]);

  async function toggleEnabled(automation) {
    await dispatch(
      updateAutomation({ woningId, automationId: automation._id, enabled: !automation.enabled })
    );
  }

  async function handleDelete(automationId) {
    if (!confirm('Deze automatisering verwijderen?')) return;
    await dispatch(deleteAutomation({ woningId, automationId }));
  }

  if (!woningId) {
    return (
      <p className="muted">Selecteer een specifieke woning via de dropdown om automatiseringen te beheren.</p>
    );
  }

  return (
    <div>
      <div className="section-header">
        <h1>Automatiseringen</h1>
        {canManage && (
          <button
            className="btn btn-primary"
            onClick={() => {
              setEditing(null);
              setShowForm((s) => !s);
            }}
          >
            {showForm && !editing ? 'Annuleren' : '+ Nieuwe automatisering'}
          </button>
        )}
      </div>

      {showForm && canManage && (
        <div style={{ marginBottom: 20 }}>
          <AutomationForm
            woningId={woningId}
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
        <p className="muted">Nog geen automatiseringen voor deze woning.</p>
      ) : (
        <div className="grid">
          {automations.map((automation) => (
            <div key={automation._id} className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                <h3 style={{ margin: '0 0 4px' }}>{automation.name}</h3>
                {canManage && (
                  <button className="btn btn-ghost" onClick={() => toggleEnabled(automation)}>
                    {automation.enabled ? 'Actief' : 'Uit'}
                  </button>
                )}
              </div>
              <p className="muted" style={{ fontSize: '0.85em' }}>
                {describeTrigger(automation)}
              </p>
              <p style={{ fontSize: '0.9em' }}>
                Als{' '}
                {automation.conditions.map((c, i) => (
                  <span key={i}>
                    {i > 0 && ' EN '}
                    <strong>{c.parameter?.label || '?'}</strong> {OPERATOR_LABELS[c.operator]}{' '}
                    {c.value}
                    {c.parameter?.unit || ''}
                  </span>
                ))}
                , dan <strong>{automation.action.parameter?.label || '?'}</strong> {describeAction(automation)}.
              </p>
              {canManage && (
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
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
