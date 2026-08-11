import { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { fetchParameters, selectParametersForWoning } from '../parameters/parametersSlice';
import { selectSelectedWoningId } from '../woningen/woningenSlice';
import { useLiveReadings } from '../parameters/useLiveReadings';
import ControlWidget from './ControlWidget';
import { fetchControlHistory } from './controlApi';
import { colorForType } from '../../palette';

export default function ControlPage() {
  const dispatch = useDispatch();
  const woningId = useSelector(selectSelectedWoningId);
  const parameters = useSelector(selectParametersForWoning(woningId));
  const controllable = parameters.filter((p) => p.controllable);

  const [history, setHistory] = useState([]);
  const [historyError, setHistoryError] = useState(null);

  useLiveReadings(woningId);

  useEffect(() => {
    if (woningId) dispatch(fetchParameters(woningId));
  }, [woningId, dispatch]);

  useEffect(() => {
    if (!woningId) return;
    fetchControlHistory(woningId)
      .then(setHistory)
      .catch((err) => setHistoryError(err.response?.data?.error?.message || 'Kon geschiedenis niet laden'));
  }, [woningId]);

  if (!woningId) {
    return <p className="muted">Selecteer een specifieke woning via de dropdown om toestellen te bedienen.</p>;
  }

  return (
    <div>
      <div className="section-header">
        <h1>Besturing</h1>
      </div>

      {controllable.length === 0 ? (
        <p className="muted">Geen stuurbare toestellen geconfigureerd voor deze woning.</p>
      ) : (
        <div className="grid" style={{ marginBottom: 32 }}>
          {controllable.map((parameter) => (
            <div
              key={parameter._id}
              className="card"
              style={{ borderLeft: `4px solid ${colorForType(parameter.type)}` }}
            >
              <div className="tile-label">{parameter.label}</div>
              <div style={{ margin: '8px 0' }}>
                Status: <strong>{parameter.latest?.value ?? '—'}</strong>
              </div>
              <ControlWidget woningId={woningId} parameter={parameter} />
            </div>
          ))}
        </div>
      )}

      <h2>Recente commando's</h2>
      {historyError && <p className="error-text">{historyError}</p>}
      <table className="table">
        <thead>
          <tr>
            <th>Tijdstip</th>
            <th>Toestel</th>
            <th>Actie</th>
            <th>Gebruiker</th>
            <th>Resultaat</th>
          </tr>
        </thead>
        <tbody>
          {history.map((h) => (
            <tr key={h._id}>
              <td>{new Date(h.createdAt).toLocaleString('nl-BE')}</td>
              <td>{h.parameter?.label || h.parameter?.entityId}</td>
              <td>{h.action}</td>
              <td>{h.user?.name}</td>
              <td>{h.result === 'success' ? 'OK' : `Fout: ${h.error}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
