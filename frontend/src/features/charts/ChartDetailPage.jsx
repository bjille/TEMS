import { useEffect, useMemo, useState } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { fetchCharts, selectChartsForWoning } from './chartsSlice';
import { fetchParameters } from '../parameters/parametersSlice';
import { useLiveReadings } from '../parameters/useLiveReadings';
import ApexSeriesChart from '../../components/ApexSeriesChart';
import EnergyFlowChart from '../../components/EnergyFlowChart';
import PieTotalsChart from '../../components/PieTotalsChart';
import PriceForecastChart from '../../components/PriceForecastChart';
import CostChart from '../../components/CostChart';
import SmartChargeSavingsChart from '../../components/SmartChargeSavingsChart';
import BadgeBar from '../../components/BadgeBar';
import {
  fromDateInput,
  isCalendarPeriod,
  periodStart,
  periodWindow,
  rangeFields,
  rangeValue,
  shiftPeriod,
  toDateInput,
  windowTitle,
} from '../../components/chartRange';

// The period choices on this page: calendar periods you can browse back and
// forth through (like Home Assistant's energy dashboard), a free date range,
// and the rolling windows ending now.
const PERIOD_BUTTONS = [
  { value: 'day', label: 'Dag' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Maand' },
  { value: 'year', label: 'Jaar' },
  { value: 'custom', label: 'Aangepast' },
  { value: '24', label: '24 u' },
  { value: '168', label: '7 d' },
  { value: '720', label: '30 d' },
];

// An energy flow chart shows live power, or the energy over a period.
const FLOW_BUTTONS = [
  { value: 'live', label: 'Live' },
  ...PERIOD_BUTTONS.filter((r) => Number.isNaN(Number(r.value))),
];

const DAY_MS = 24 * 3600 * 1000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const PREVIOUS_LABEL = {
  day: 'de dag ervoor',
  week: 'de week ervoor',
  month: 'de maand ervoor',
  year: 'het jaar ervoor',
};

// The window shown for the page's choices, or null for a rolling window
// (which the chart computes itself, ending now).
function mainWindow(range, anchor, custom) {
  if (isCalendarPeriod(range)) return periodWindow(range, anchor);
  if (range === 'custom' && custom.from && custom.to) {
    const from = fromDateInput(custom.from);
    const to = new Date(fromDateInput(custom.to).getTime() + DAY_MS);
    return to > from ? { from, to } : null;
  }
  return null;
}

// The comparison window: the period before, or the same kind of period
// starting at a chosen date.
function compareWindow(range, main, mode, date) {
  if (mode === 'off' || !main) return null;
  if (isCalendarPeriod(range)) {
    return mode === 'date' && date
      ? periodWindow(range, fromDateInput(date))
      : periodWindow(range, shiftPeriod(range, main.from, -1));
  }
  const length = main.to - main.from;
  const from = mode === 'date' && date ? fromDateInput(date) : new Date(main.from.getTime() - length);
  return { from, to: new Date(from.getTime() + length) };
}

const activeStyle = { borderColor: 'var(--accent)', color: 'var(--accent)' };

export default function ChartDetailPage() {
  const { woningId, chartId } = useParams();
  const dispatch = useDispatch();
  const charts = useSelector(selectChartsForWoning(woningId));
  const chart = charts.find((c) => c._id === chartId);

  // Opened from the dashboard's view bar: ?period=day&date=2026-10-21, or
  // ?period=custom&from=2026-10-01&to=2026-10-21 for a range.
  const [searchParams] = useSearchParams();
  const linkedFrom = DATE_PATTERN.test(searchParams.get('from') || '') ? searchParams.get('from') : null;
  const linkedTo = DATE_PATTERN.test(searchParams.get('to') || '') ? searchParams.get('to') : null;
  const periodParam = searchParams.get('period');
  const linkedPeriod = isCalendarPeriod(periodParam)
    ? periodParam
    : periodParam === 'custom' && linkedFrom && linkedTo
    ? 'custom'
    : null;
  const linkedDate = DATE_PATTERN.test(searchParams.get('date') || '') ? searchParams.get('date') : null;

  // A PERIOD_BUTTONS value; null until the chart's own period is known.
  const [range, setRange] = useState(linkedPeriod);
  // Any moment inside the calendar period shown (browsed with the arrows).
  const [anchor, setAnchor] = useState(() => (linkedDate ? fromDateInput(linkedDate) : new Date()));
  const [custom, setCustom] = useState(() => {
    const today = toDateInput(new Date());
    return linkedPeriod === 'custom' ? { from: linkedFrom, to: linkedTo } : { from: today, to: today };
  });
  // 'off' | 'previous' (the period before) | 'date' (starting at compareDate)
  const [compareMode, setCompareMode] = useState('off');
  const [compareDate, setCompareDate] = useState('');

  useLiveReadings(woningId);

  useEffect(() => {
    dispatch(fetchCharts(woningId));
    dispatch(fetchParameters(woningId));
  }, [woningId, dispatch]);

  // Default the range picker to the chart's own configured period, once known.
  // A price chart has no saved period of its own: it opens on today (and
  // tomorrow's published prices); an energy flow chart opens live.
  useEffect(() => {
    if (chart && range === null) {
      setRange(chart.type === 'price_forecast' ? 'day' : chart.type === 'energyflow' ? 'live' : rangeValue(chart));
    }
  }, [chart, range]);

  // Without this memo, spreading `chart` into a new object on every render
  // gives ApexSeriesChart a new prop identity on every unrelated re-render
  // (e.g. a live reading arriving via useLiveReadings), which re-triggers
  // its data fetch and forces react-apexcharts to tear down and recreate
  // the chart instance repeatedly — including while a previous async
  // render is still in flight, which can leave the chart blank.
  const shownWindow = useMemo(() => (range ? mainWindow(range, anchor, custom) : null), [range, anchor, custom]);
  // A rolling window ends now, so it's compared with the one before it.
  const rollingWindow = useMemo(() => {
    if (!range || isCalendarPeriod(range) || range === 'custom' || range === 'live') return null;
    const now = new Date();
    return { from: new Date(now.getTime() - Number(range) * 3600 * 1000), to: now };
  }, [range]);
  const comparison = useMemo(
    () => (range ? compareWindow(range, shownWindow || rollingWindow, compareMode, compareDate) : null),
    [range, shownWindow, rollingWindow, compareMode, compareDate]
  );
  const displayChart = useMemo(() => {
    if (!chart) return null;
    if (!range) return chart;
    return {
      ...chart,
      ...(range === 'custom' || range === 'live' ? {} : rangeFields(range)),
      ...(shownWindow ? { window: shownWindow } : {}),
      ...(comparison ? { compareWindow: comparison } : {}),
    };
  }, [chart, range, shownWindow, comparison]);

  if (!chart) {
    return (
      <div>
        <Link to="/" className="muted">
          ← Terug naar dashboard
        </Link>
        <p className="muted" style={{ marginTop: 12 }}>
          Grafiek laden...
        </p>
      </div>
    );
  }

  const isEnergyFlow = chart.type === 'energyflow';
  const isPrice = chart.type === 'price_forecast';
  // Price history is stored per calendar day, so a price chart only browses
  // calendar periods and custom ranges, not windows rolling with "now".
  const periodButtons = isEnergyFlow
    ? FLOW_BUTTONS
    : isPrice
    ? PERIOD_BUTTONS.filter((r) => Number.isNaN(Number(r.value)))
    : PERIOD_BUTTONS;
  const subtitle = isEnergyFlow
    ? Object.values(chart.flowRoles || {})
        .filter(Boolean)
        .map((p) => p.label)
        .join(' · ')
    : chart.type === 'cost'
    ? (chart.costTrackers || []).map((t) => t.name).join(' · ')
    : chart.type === 'smart_charge_savings'
    ? (chart.smartChargePlans || []).map((p) => p.name).join(' · ')
    : chart.parameters.map((p) => p.label).join(' · ');

  return (
    <div>
      <Link to="/" className="muted">
        ← Terug naar dashboard
      </Link>
      <div className="section-header" style={{ marginTop: 12 }}>
        <h1>{chart.name}</h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {periodButtons.map((r) => (
            <button
              key={r.value}
              className="btn"
              style={range === r.value ? activeStyle : undefined}
              onClick={() => {
                setRange(r.value);
                setCompareDate('');
              }}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {range && range !== 'live' && (
        <PeriodBar
          range={range}
          anchor={anchor}
          setAnchor={setAnchor}
          custom={custom}
          setCustom={setCustom}
          shownWindow={shownWindow}
          comparison={comparison}
          compareMode={compareMode}
          setCompareMode={setCompareMode}
          compareDate={compareDate}
          setCompareDate={setCompareDate}
          canCompare={chart.type !== 'smart_charge_savings' && !isPrice && !isEnergyFlow}
        />
      )}

      <BadgeBar woningId={woningId} sticky />

      {subtitle && (
        <p className="muted" style={{ marginTop: 0 }}>
          {subtitle}
        </p>
      )}

      <div className="card">
        {isEnergyFlow ? (
          <EnergyFlowChart chart={displayChart} woningId={woningId} height={480} />
        ) : chart.type === 'pie' ? (
          <PieTotalsChart chart={displayChart} woningId={woningId} height={480} />
        ) : chart.type === 'price_forecast' ? (
          <PriceForecastChart chart={displayChart} woningId={woningId} height={480} />
        ) : chart.type === 'cost' ? (
          <CostChart chart={displayChart} woningId={woningId} height={480} />
        ) : chart.type === 'smart_charge_savings' ? (
          <SmartChargeSavingsChart chart={displayChart} woningId={woningId} height={480} />
        ) : (
          <ApexSeriesChart chart={displayChart} woningId={woningId} height={480} />
        )}
      </div>
    </div>
  );
}

// Second toolbar row: which period is shown and how to move through it, and
// what it's compared with.
function PeriodBar({
  range,
  anchor,
  setAnchor,
  custom,
  setCustom,
  shownWindow,
  comparison,
  compareMode,
  setCompareMode,
  compareDate,
  setCompareDate,
  canCompare,
}) {
  const calendar = isCalendarPeriod(range);
  const isCurrent = calendar && periodStart(range, anchor).getTime() === periodStart(range, new Date()).getTime();
  return (
    <div
      className="card"
      style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', padding: '10px 14px', marginBottom: 12 }}
    >
      {calendar && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn" aria-label="Vorige periode" onClick={() => setAnchor(shiftPeriod(range, anchor, -1))}>
            ◀
          </button>
          <strong style={{ minWidth: 150, textAlign: 'center' }}>{windowTitle(shownWindow)}</strong>
          <button
            className="btn"
            aria-label="Volgende periode"
            disabled={isCurrent}
            onClick={() => setAnchor(shiftPeriod(range, anchor, 1))}
          >
            ▶
          </button>
          {!isCurrent && (
            <button className="btn btn-ghost" onClick={() => setAnchor(new Date())}>
              {range === 'day' ? 'Vandaag' : 'Nu'}
            </button>
          )}
          <input
            type="date"
            aria-label="Ga naar datum"
            value={toDateInput(anchor)}
            max={toDateInput(new Date())}
            onChange={(e) => e.target.value && setAnchor(fromDateInput(e.target.value))}
          />
        </div>
      )}
      {range === 'custom' && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="muted">Van</span>
          <input
            type="date"
            aria-label="Van"
            value={custom.from}
            max={custom.to || undefined}
            onChange={(e) => setCustom({ ...custom, from: e.target.value })}
          />
          <span className="muted">tot en met</span>
          <input
            type="date"
            aria-label="Tot en met"
            value={custom.to}
            min={custom.from || undefined}
            onChange={(e) => setCustom({ ...custom, to: e.target.value })}
          />
        </div>
      )}
      {!calendar && range !== 'custom' && <span className="muted">Tot nu</span>}

      {canCompare && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginLeft: 'auto' }}>
          <span className="muted">Vergelijk met</span>
          <select aria-label="Vergelijk met" value={compareMode} onChange={(e) => setCompareMode(e.target.value)}>
            <option value="off">— niets —</option>
            <option value="previous">{PREVIOUS_LABEL[range] || 'de periode ervoor'}</option>
            <option value="date">{range === 'day' ? 'een andere dag' : 'een andere periode'}</option>
          </select>
          {compareMode === 'date' && (
            <input
              type="date"
              aria-label="Vergelijkingsdatum"
              value={compareDate}
              max={toDateInput(new Date())}
              onChange={(e) => setCompareDate(e.target.value)}
            />
          )}
          {comparison && <span className="muted">({windowTitle(comparison)})</span>}
        </div>
      )}
    </div>
  );
}
