import { useEffect, useState } from 'react';
import { useDispatch } from 'react-redux';
import { armTimer, disarmTimer, setTimerClock } from './automationsSlice';

function formatRemaining(ms) {
  const totalSeconds = Math.max(Math.floor(ms / 1000), 0);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Dashboard-level control for a 'timer' automation: lets any woning member
// arm/cancel a countdown, or adjust a daily clock time, without opening the
// automation editor (that only defines *which* device/mode is used).
export default function TimerWidget({ woningId, automation }) {
  const dispatch = useDispatch();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const { timerMode, timerArmed, timerTargetAt, timerDurationMinutes, timerClockTime } = automation.trigger;

  const [duration, setDuration] = useState(timerDurationMinutes ?? 30);
  const [clockTime, setClockTime] = useState(timerClockTime || '22:00');
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!(timerMode === 'countdown' && timerArmed)) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [timerMode, timerArmed]);

  useEffect(() => {
    setClockTime(timerClockTime || '22:00');
  }, [timerClockTime]);

  async function run(action) {
    setPending(true);
    setError(null);
    try {
      await dispatch(action).unwrap();
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
    }
  }

  if (timerMode === 'clock') {
    return (
      <div style={{ marginTop: 6 }}>
        <div className="muted" style={{ fontSize: '0.75em' }}>
          {automation.name}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            type="time"
            value={clockTime}
            onChange={(e) => setClockTime(e.target.value)}
            disabled={pending}
          />
          <button
            className="btn"
            disabled={pending || clockTime === timerClockTime}
            onClick={() =>
              run(setTimerClock({ woningId, automationId: automation._id, timerClockTime: clockTime }))
            }
          >
            Opslaan
          </button>
        </div>
        {error && <p className="error-text">{error}</p>}
      </div>
    );
  }

  const remainingMs = timerArmed && timerTargetAt ? new Date(timerTargetAt).getTime() - now : 0;
  const isRunning = timerArmed && remainingMs > 0;

  return (
    <div style={{ marginTop: 6 }}>
      <div className="muted" style={{ fontSize: '0.75em' }}>
        {automation.name}
      </div>
      {isRunning ? (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span>Nog {formatRemaining(remainingMs)}</span>
          <button className="btn" disabled={pending} onClick={() => run(disarmTimer({ woningId, automationId: automation._id }))}>
            Annuleren
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            type="number"
            min={1}
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            style={{ width: 70 }}
            disabled={pending}
          />
          <span className="muted" style={{ fontSize: '0.8em' }}>
            min
          </span>
          <button
            className="btn btn-primary"
            disabled={pending}
            onClick={() =>
              run(armTimer({ woningId, automationId: automation._id, durationMinutes: Number(duration) }))
            }
          >
            Start
          </button>
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
