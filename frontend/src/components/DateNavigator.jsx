import { useEffect, useRef } from 'react';
import {
  fromDateInput,
  isCalendarPeriod,
  periodStart,
  periodWindow,
  shiftPeriod,
  toDateInput,
  windowTitle,
} from './chartRange';
import './DateNavigator.css';

// While a date is being typed, the field passes through dates like year
// 0002 (and every day typed on the way to the one meant), so a date field
// keeps its own input and only applies a plausible date once typing pauses.
const APPLY_DELAY_MS = 500;
const isPlausible = (value) => {
  const year = Number(value.slice(0, 4));
  return year >= 2000 && year <= new Date().getFullYear() + 1;
};

function DateField({ value, onChange, ...props }) {
  const ref = useRef(null);
  const timer = useRef(null);
  // Follow a value changed from outside (◀ ▶, "Vandaag") unless being typed in.
  useEffect(() => {
    if (ref.current && ref.current.value !== value && document.activeElement !== ref.current) {
      ref.current.value = value;
    }
  }, [value]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <input
      ref={ref}
      type="date"
      defaultValue={value}
      onChange={(e) => {
        const next = e.target.value;
        clearTimeout(timer.current);
        if (isPlausible(next)) timer.current = setTimeout(() => onChange(next), APPLY_DELAY_MS);
      }}
      onBlur={(e) => {
        if (e.target.value !== value && !isPlausible(e.target.value)) e.target.value = value;
      }}
      {...props}
    />
  );
}

const MODES = [
  { value: 'live', label: 'Live' },
  { value: 'day', label: 'Dag' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Maand' },
  { value: 'year', label: 'Jaar' },
  { value: 'range', label: 'Bereik' },
];

/**
 * Home Assistant-style view bar pinned to the bottom of the page: live, a
 * calendar period (day/week/month/year) browsed with ◀ ▶ and a date
 * picker, or a free range of days. `view` is { mode, anchor, from, to }
 * (see chartRange viewWindow).
 */
export default function DateNavigator({ view, setMode, setAnchor, setRange }) {
  const { mode, anchor } = view;
  const calendar = isCalendarPeriod(mode);
  const isCurrent = calendar && periodStart(mode, anchor).getTime() === periodStart(mode, new Date()).getTime();
  const today = toDateInput(new Date());
  return (
    <div className="date-navigator" role="toolbar" aria-label="Weergave">
      <div className="date-navigator-periods">
        {MODES.map((m) => (
          <button
            key={m.value}
            className={`btn${mode === m.value ? ' date-navigator-active' : ''}`}
            aria-pressed={mode === m.value}
            onClick={() => setMode(m.value)}
          >
            {m.value === 'live' && <span className="date-navigator-live-dot" aria-hidden="true" />}
            {m.label}
          </button>
        ))}
      </div>
      <div className="date-navigator-nav">
        {mode === 'live' && <span className="muted">Live meetwaarden, worden automatisch bijgewerkt</span>}
        {calendar && (
          <>
            <button className="btn" aria-label="Vorige periode" onClick={() => setAnchor(shiftPeriod(mode, anchor, -1))}>
              ◀
            </button>
            <strong className="date-navigator-title">{windowTitle(periodWindow(mode, anchor))}</strong>
            <button
              className="btn"
              aria-label="Volgende periode"
              disabled={isCurrent}
              onClick={() => setAnchor(shiftPeriod(mode, anchor, 1))}
            >
              ▶
            </button>
            <DateField
              aria-label="Ga naar datum"
              value={toDateInput(anchor)}
              max={today}
              onChange={(date) => setAnchor(fromDateInput(date))}
            />
            {!isCurrent && (
              <button className="btn btn-ghost" onClick={() => setAnchor(new Date())}>
                {mode === 'day' ? 'Vandaag' : 'Nu'}
              </button>
            )}
          </>
        )}
        {mode === 'range' && (
          <>
            <span className="muted">Van</span>
            <DateField
              aria-label="Van"
              value={view.from}
              max={view.to || today}
              onChange={(date) => setRange({ from: date, to: view.to })}
            />
            <span className="muted">tot en met</span>
            <DateField
              aria-label="Tot en met"
              value={view.to}
              min={view.from}
              max={today}
              onChange={(date) => setRange({ from: view.from, to: date })}
            />
          </>
        )}
      </div>
    </div>
  );
}
