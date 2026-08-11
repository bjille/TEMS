import { useState } from 'react';
import { sendControlAction } from './controlApi';

export default function SwitchToggle({ woningId, parameter }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const isOn = parameter.latest?.value === 'on';

  async function toggle() {
    setPending(true);
    setError(null);
    try {
      await sendControlAction(woningId, parameter._id, isOn ? 'turn_off' : 'turn_on');
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Actie mislukt');
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <button className="btn" disabled={pending} onClick={toggle}>
        {isOn ? 'Uitschakelen' : 'Inschakelen'}
      </button>
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
