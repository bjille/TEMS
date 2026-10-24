import { useEffect, useMemo, useState } from 'react';
import Chart from 'react-apexcharts';
import { api } from '../services/api';
import { colorForType } from '../palette';

const ACCENT = colorForType('electricity_price'); // fixed identity color for this parameter type
// A translucent tint of the same hue for every hour except "now" — same
// identity color at two lightness steps rather than a second hue, so a
// single series still reads as one thing with one hour emphasized.
const MUTED = `color-mix(in srgb, ${ACCENT} 35%, transparent)`;

// Refresh periodically: tomorrow's prices are published by ENTSO-E only
// once a day (typically mid-afternoon CET), and the "now" highlight needs
// to move forward every hour — a 15 minute poll keeps both current without
// hammering Home Assistant.
const REFRESH_MS = 15 * 60 * 1000;

function floorToHour(date) {
  const d = new Date(date);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

// The window to ask the backend for: `chart.window` (a date bar choice), and
// when that reaches into the future, extended through tomorrow so the
// published forecast stays visible. Null without a window: the live curve.
function fetchWindow(window) {
  if (!window) return null;
  const from = new Date(window.from);
  let to = new Date(window.to);
  if (to.getTime() > Date.now()) {
    const afterTomorrow = new Date();
    afterTomorrow.setHours(0, 0, 0, 0);
    afterTomorrow.setDate(afterTomorrow.getDate() + 2);
    if (afterTomorrow > to) to = afterTomorrow;
  }
  return { from, to };
}

// Renders a saved DashboardChart of type 'price_forecast': the hourly price
// curve of a dynamic-prices HA entity's `prices_today` / `prices_tomorrow`
// attributes (see backend `price-forecast` route) — live, plus for a chosen
// period (`chart.window`) the past days' curves TEMS stored in PriceHistory.
// `data` ({ unit, points }) skips the fetch, for curves computed elsewhere
// (the public demo).
export default function PriceForecastChart({ chart, woningId, height = 300, data: givenData = null }) {
  const [fetchedData, setData] = useState(null);
  const data = givenData || fetchedData;
  const [error, setError] = useState(null);
  const parameter = chart.parameters?.[0];
  const fromMs = chart.window ? new Date(chart.window.from).getTime() : null;
  const toMs = chart.window ? new Date(chart.window.to).getTime() : null;
  const range = useMemo(
    () => (fromMs === null ? null : fetchWindow({ from: fromMs, to: toMs })),
    [fromMs, toMs]
  );
  // Long windows get a line instead of hundreds of bars.
  const isLong = range ? range.to - range.from > 3 * 24 * 3600 * 1000 : false;

  useEffect(() => {
    if (!parameter || givenData) return;
    let cancelled = false;
    async function load() {
      setError(null);
      try {
        const { data: res } = await api.get(
          `/woningen/${woningId}/parameters/${parameter._id}/price-forecast`,
          range ? { params: { from: range.from.toISOString(), to: range.to.toISOString() } } : undefined
        );
        if (!cancelled) setData(res);
      } catch (err) {
        if (!cancelled) setError(err.response?.data?.error?.message || 'Kon prijsdata niet laden');
      }
    }
    load();
    const interval = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [parameter, woningId, range, givenData]);

  const nowHourMs = useMemo(() => floorToHour(Date.now()), [data]);

  const series = useMemo(() => {
    if (!data) return null;
    return [
      {
        name: parameter?.label || 'Prijs',
        data: data.points.map((p) => [new Date(p.timestamp).getTime(), p.price]),
      },
    ];
  }, [data, parameter]);

  const options = useMemo(() => {
    const unit = data?.unit || '€/kWh';
    const barColors = (data?.points || []).map((p) =>
      new Date(p.timestamp).getTime() === nowHourMs ? ACCENT : MUTED
    );
    const nowShown = (data?.points || []).some((p) => new Date(p.timestamp).getTime() === nowHourMs);
    return {
      chart: {
        toolbar: { show: false },
        zoom: { enabled: false },
        foreColor: 'var(--text-secondary)',
        background: 'transparent',
      },
      colors: isLong ? [ACCENT] : barColors,
      // Only set at all for a line: an explicit `stroke: undefined` makes
      // ApexCharts drop its own defaults and crash on "colors".
      ...(isLong ? { stroke: { width: 2, curve: 'stepline' } } : {}),
      plotOptions: { bar: { columnWidth: '80%', distributed: true } },
      legend: { show: false },
      dataLabels: { enabled: false },
      grid: { borderColor: 'var(--gridline)' },
      xaxis: {
        type: 'datetime',
        labels: { datetimeUTC: false, ...(range && range.to - range.from > 2 * 24 * 3600 * 1000 ? {} : { format: 'HH:mm' }) },
        ...(range ? { min: range.from.getTime(), max: range.to.getTime() } : {}),
      },
      yaxis: {
        labels: { formatter: (v) => (typeof v === 'number' ? v.toFixed(2) : v) },
        title: { text: unit },
      },
      annotations: {
        xaxis: nowShown ? [
          {
            x: nowHourMs,
            borderColor: 'var(--text-secondary)',
            label: {
              text: 'Nu',
              orientation: 'horizontal',
              style: { color: 'var(--text-secondary)', background: 'transparent' },
            },
          },
        ] : [],
      },
      tooltip: {
        x: { format: 'ddd d MMM, HH:mm' },
        y: { formatter: (v) => `${v.toFixed(3)} ${unit}` },
      },
    };
  }, [data, nowHourMs, range, isLong]);

  if (!parameter) return <p className="muted">Geen parameter gekoppeld aan deze grafiek.</p>;
  if (error) return <p className="error-text">{error}</p>;
  if (!data) return <p className="muted">Laden...</p>;
  if (data.points.length === 0 && range && range.to.getTime() <= Date.now()) {
    return <p className="muted">Geen prijzen opgeslagen voor deze periode.</p>;
  }
  if (data.points.length === 0) {
    return (
      <p className="muted">
        Geen uurprijzen beschikbaar voor {parameter.label}. Deze sensor levert (nog) geen{' '}
        <code>prices</code>-, <code>prices_today</code>- of <code>from</code>/<code>till</code>
        -attribuut in Home Assistant. Dit betekent meestal dat het om een "huidige prijs"-sensor
        gaat i.p.v. de "gemiddelde prijs"/curve-sensor van dezelfde integratie — kies in Admin →
        Grafieken de variant die wél de volledige dagcurve publiceert.
      </p>
    );
  }

  return <Chart key={isLong ? 'line' : 'bar'} options={options} series={series} type={isLong ? 'line' : 'bar'} height={height} />;
}
