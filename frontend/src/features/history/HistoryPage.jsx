import { useEffect, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useSelector, useDispatch } from 'react-redux';
import { api } from '../../services/api';
import { fetchParameters, selectParametersForWoning } from '../parameters/parametersSlice';
import HistoryChart from '../../components/HistoryChart';
import { colorForType } from '../../palette';

const RANGES = [
  { label: '24 uur', hours: 24 },
  { label: '7 dagen', hours: 24 * 7 },
  { label: '30 dagen', hours: 24 * 30 },
];

export default function HistoryPage() {
  const { woningId, parameterId } = useParams();
  const dispatch = useDispatch();
  const parameters = useSelector(selectParametersForWoning(woningId));
  const parameter = parameters.find((p) => p._id === parameterId);

  const [rangeHours, setRangeHours] = useState(24);
  const [customFrom, setCustomFrom] = useState('');
  const [readings, setReadings] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!parameter) dispatch(fetchParameters(woningId));
  }, [woningId, parameter, dispatch]);

  function selectRange(hours) {
    setCustomFrom('');
    setRangeHours(hours);
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const from = customFrom
          ? new Date(customFrom).toISOString()
          : new Date(Date.now() - rangeHours * 3600 * 1000).toISOString();
        const { data } = await api.get(`/woningen/${woningId}/readings`, {
          params: { parameterId, from },
        });
        if (!cancelled) setReadings(data);
      } catch (err) {
        if (!cancelled) setError(err.response?.data?.error?.message || 'Kon historiek niet laden');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [woningId, parameterId, rangeHours, customFrom]);

  const color = useMemo(() => colorForType(parameter?.type), [parameter]);

  return (
    <div>
      <Link to="/" className="muted">
        ← Terug naar dashboard
      </Link>
      <div className="section-header" style={{ marginTop: 12 }}>
        <h1>{parameter?.label || 'Historiek'}</h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {RANGES.map((r) => (
            <button
              key={r.hours}
              className="btn"
              style={!customFrom && rangeHours === r.hours ? { borderColor: color, color } : undefined}
              onClick={() => selectRange(r.hours)}
            >
              {r.label}
            </button>
          ))}
          <input
            type="datetime-local"
            value={customFrom}
            onChange={(e) => setCustomFrom(e.target.value)}
            style={{
              padding: '8px 10px',
              border: `1px solid ${customFrom ? color : 'var(--border)'}`,
              borderRadius: 6,
              background: 'var(--surface-1)',
              color: customFrom ? color : 'var(--text-primary)',
            }}
          />
        </div>
      </div>

      {loading && <p className="muted">Laden...</p>}
      {error && <p className="error-text">{error}</p>}
      {!loading && !error && (
        <div className="card">
          <HistoryChart data={readings} color={color} unit={parameter?.unit} />
        </div>
      )}
    </div>
  );
}
