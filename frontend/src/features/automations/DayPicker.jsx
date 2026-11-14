import { ALL_DAYS, DAY_LABELS } from './cronUtils';

// Weekday toggle buttons (0 = zondag … 6 = zaterdag), shown ma → zo.
// An empty selection means "every day".
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

export default function DayPicker({ days, onChange, disabled, hint = true }) {
  function toggle(day) {
    onChange(days.includes(day) ? days.filter((d) => d !== day) : [...days, day].sort());
  }
  return (
    <>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {WEEK_ORDER.filter((d) => ALL_DAYS.includes(d)).map((d) => (
          <button
            type="button"
            key={d}
            className="btn"
            disabled={disabled}
            style={days.includes(d) ? { borderColor: '#2a78d6', color: '#2a78d6' } : undefined}
            onClick={() => toggle(d)}
          >
            {DAY_LABELS[d]}
          </button>
        ))}
      </div>
      {hint && (
        <p className="muted" style={{ fontSize: '0.8em' }}>
          Geen dag geselecteerd = elke dag.
        </p>
      )}
    </>
  );
}

export function describeDays(days) {
  if (!days || days.length === 0 || days.length === 7) return 'elke dag';
  return WEEK_ORDER.filter((d) => days.includes(d)).map((d) => DAY_LABELS[d]).join(', ');
}
