import { useState } from 'react';
import { sendControlAction } from './controlApi';

// Control widget for a HA input_number: a plain number input + "Zet"
// button, mirroring how SwitchToggle/SelectControl call HA (this maps to
// the input_number.set_value service, entity_id derived automatically).
export default function NumberControl({ woningId, parameter }) {
  const current = parameter.latest?.value ?? '';
  const [value, setValue] = useState(current);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);

  async function handleSet() {
    if (value === '' || Number.isNaN(Number(value))) return;
    setPending(true);
    setError(null);
    try {
      await sendControlAction(woningId, parameter._id, 'set_value', { value: Number(value) });
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Actie mislukt');
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input
          type="number"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={pending}
          style={{ width: 90 }}
        />
        <button className="btn" disabled={pending || Number(value) === Number(current)} onClick={handleSet}>
          Zet
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
