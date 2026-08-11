import { useState } from 'react';
import { sendControlAction } from './controlApi';

export default function SelectControl({ woningId, parameter }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const current = parameter.latest?.value ?? '';
  const options = parameter.options || [];

  async function handleChange(e) {
    const option = e.target.value;
    if (!option || option === current) return;
    setPending(true);
    setError(null);
    try {
      await sendControlAction(woningId, parameter._id, 'select_option', { option });
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Actie mislukt');
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <select value={current} onChange={handleChange} disabled={pending}>
        {current && !options.includes(current) && <option value={current}>{current}</option>}
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
