import {
  fromDateInput,
  periodStart,
  periodWindow,
  shiftPeriod,
  toDateInput,
  windowTitle,
} from './chartRange';
import './DateNavigator.css';

const PERIODS = [
  { value: 'day', label: 'Dag' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Maand' },
  { value: 'year', label: 'Jaar' },
];

/**
 * Home Assistant-style date bar pinned to the bottom of the page: a calendar
 * period (day/week/month/year) and the moment it's anchored on, browsed
 * with ◀ ▶, a date picker, and a jump back to today.
 */
export default function DateNavigator({ period, setPeriod, anchor, setAnchor }) {
  const isCurrent = periodStart(period, anchor).getTime() === periodStart(period, new Date()).getTime();
  return (
    <div className="date-navigator" role="toolbar" aria-label="Periode">
      <div className="date-navigator-periods">
        {PERIODS.map((p) => (
          <button
            key={p.value}
            className={`btn${period === p.value ? ' date-navigator-active' : ''}`}
            onClick={() => setPeriod(p.value)}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="date-navigator-nav">
        <button className="btn" aria-label="Vorige periode" onClick={() => setAnchor(shiftPeriod(period, anchor, -1))}>
          ◀
        </button>
        <strong className="date-navigator-title">{windowTitle(periodWindow(period, anchor))}</strong>
        <button
          className="btn"
          aria-label="Volgende periode"
          disabled={isCurrent}
          onClick={() => setAnchor(shiftPeriod(period, anchor, 1))}
        >
          ▶
        </button>
        <input
          type="date"
          aria-label="Ga naar datum"
          value={toDateInput(anchor)}
          max={toDateInput(new Date())}
          onChange={(e) => e.target.value && setAnchor(fromDateInput(e.target.value))}
        />
        {!isCurrent && (
          <button className="btn btn-ghost" onClick={() => setAnchor(new Date())}>
            {period === 'day' ? 'Vandaag' : 'Nu'}
          </button>
        )}
      </div>
    </div>
  );
}
