import { useState } from 'react';

// A small "Kopiëren naar…" toggle with a checklist of other woningen and a
// per-target result summary. `onCopy(targetWoningIds)` must resolve to the
// backend's `{ results: [{ woningId, status, message? }] }.results` array.
export default function CopyToWoningen({ woningen, currentWoningId, onCopy }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState([]);
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(false);

  const targets = woningen.filter((w) => w._id !== currentWoningId);
  if (targets.length === 0) return null;

  function toggle(id) {
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  }

  async function handleCopy() {
    setBusy(true);
    setResults(null);
    try {
      const res = await onCopy(selected);
      setResults(res);
      setSelected([]);
    } catch {
      setResults(selected.map((woningId) => ({ woningId, status: 'error', message: 'Kopiëren mislukt' })));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'inline-block', position: 'relative' }}>
      <button type="button" className="btn" onClick={() => setOpen((o) => !o)}>
        Kopiëren naar…
      </button>
      {open && (
        <div
          className="card"
          style={{ position: 'absolute', zIndex: 5, marginTop: 4, padding: 12, minWidth: 220 }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
            {targets.map((w) => (
              <label key={w._id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={selected.includes(w._id)} onChange={() => toggle(w._id)} />
                {w.name}
              </label>
            ))}
          </div>
          <button
            type="button"
            className="btn btn-primary"
            disabled={selected.length === 0 || busy}
            onClick={handleCopy}
          >
            {busy ? 'Bezig…' : 'Kopiëren'}
          </button>
          {results && (
            <ul style={{ marginTop: 10, paddingLeft: 18, fontSize: '0.85em' }}>
              {results.map((r) => {
                const name = targets.find((w) => w._id === r.woningId)?.name || r.woningId;
                return (
                  <li key={r.woningId} className={r.status === 'created' ? undefined : 'error-text'}>
                    {name}: {r.status === 'created' ? 'gekopieerd ✓' : r.message}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
