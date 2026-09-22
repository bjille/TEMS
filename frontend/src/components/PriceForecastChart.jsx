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

// Renders a saved DashboardChart of type 'price_forecast': the hourly price
// curve read live from a dynamic-prices HA entity's `prices_today` /
// `prices_tomorrow` attributes (see backend `price-forecast` route), not
// from stored Readings — those attributes describe hours that haven't
// happened yet, so there's no reading history for them.
export default function PriceForecastChart({ chart, woningId, height = 300 }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const parameter = chart.parameters?.[0];

  useEffect(() => {
    if (!parameter) return;
    let cancelled = false;
    async function load() {
      setError(null);
      try {
        const { data: res } = await api.get(
          `/woningen/${woningId}/parameters/${parameter._id}/price-forecast`
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
  }, [parameter, woningId]);

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
    return {
      chart: {
        toolbar: { show: false },
        zoom: { enabled: false },
        foreColor: 'var(--text-secondary)',
        background: 'transparent',
      },
      colors: barColors,
      plotOptions: { bar: { columnWidth: '80%', distributed: true } },
      legend: { show: false },
      dataLabels: { enabled: false },
      grid: { borderColor: 'var(--gridline)' },
      xaxis: {
        type: 'datetime',
        labels: { datetimeUTC: false, format: 'HH:mm' },
      },
      yaxis: {
        labels: { formatter: (v) => (typeof v === 'number' ? v.toFixed(2) : v) },
        title: { text: unit },
      },
      annotations: {
        xaxis: [
          {
            x: nowHourMs,
            borderColor: 'var(--text-secondary)',
            label: {
              text: 'Nu',
              orientation: 'horizontal',
              style: { color: 'var(--text-secondary)', background: 'transparent' },
            },
          },
        ],
      },
      tooltip: {
        x: { format: 'ddd d MMM, HH:mm' },
        y: { formatter: (v) => `${v.toFixed(3)} ${unit}` },
      },
    };
  }, [data, nowHourMs]);

  if (!parameter) return <p className="muted">Geen parameter gekoppeld aan deze grafiek.</p>;
  if (error) return <p className="error-text">{error}</p>;
  if (!data) return <p className="muted">Laden...</p>;
  if (data.points.length === 0) {
    return (
      <p className="muted">
        Geen uurprijzen beschikbaar voor {parameter.label}. Controleer of de sensor in Home
        Assistant een <code>prices</code>- of <code>prices_today</code>-attribuut levert.
      </p>
    );
  }

  return <Chart options={options} series={series} type="bar" height={height} />;
}
