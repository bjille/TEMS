import { useState } from 'react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';

function formatTick(ts) {
  const d = new Date(ts);
  return d.toLocaleString('nl-BE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function formatDayTick(ts) {
  return new Date(ts).toLocaleDateString('nl-BE', { day: '2-digit', month: '2-digit' });
}

function formatDayLabel(ts) {
  return new Date(ts).toLocaleDateString('nl-BE', { weekday: 'long', day: '2-digit', month: '2-digit' });
}

function CustomTooltip({ active, payload, label, unit, daily }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="card" style={{ padding: '8px 12px' }}>
      <div className="muted" style={{ fontSize: '0.8em' }}>
        {daily ? formatDayLabel(label) : new Date(label).toLocaleString('nl-BE')}
      </div>
      <div style={{ fontWeight: 600 }}>
        {payload[0].value}
        {unit ? ` ${unit}` : ''}
      </div>
    </div>
  );
}

// `daily` renders one bar per day (total consumption, e.g. kWh) instead of a
// continuous line of raw readings — used for the 7-days/30-days presets,
// where plotting every raw point would be both slow and unreadable.
export default function HistoryChart({ data, color, unit, daily = false }) {
  const [showTable, setShowTable] = useState(false);

  if (!data || data.length === 0) {
    return <p className="muted">Geen historische data voor deze periode.</p>;
  }

  const chartData = data.map((r) => ({ timestamp: new Date(r.timestamp).getTime(), value: r.value }));

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        <button className="btn btn-ghost" onClick={() => setShowTable((s) => !s)}>
          {showTable ? 'Toon grafiek' : 'Toon als tabel'}
        </button>
      </div>

      {showTable ? (
        <div style={{ maxHeight: 400, overflowY: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>{daily ? 'Dag' : 'Tijdstip'}</th>
                <th>{daily ? 'Totaal verbruik' : 'Waarde'}</th>
              </tr>
            </thead>
            <tbody>
              {data.map((r, i) => (
                <tr key={i}>
                  <td>
                    {daily
                      ? new Date(r.timestamp).toLocaleDateString('nl-BE', {
                          weekday: 'short',
                          day: '2-digit',
                          month: '2-digit',
                        })
                      : new Date(r.timestamp).toLocaleString('nl-BE')}
                  </td>
                  <td>
                    {r.value}
                    {unit ? ` ${unit}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : daily ? (
        <ResponsiveContainer width="100%" height={360}>
          <BarChart data={chartData} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
            <CartesianGrid stroke="var(--gridline)" vertical={false} />
            <XAxis
              dataKey="timestamp"
              type="number"
              domain={['dataMin', 'dataMax']}
              tickFormatter={formatDayTick}
              stroke="var(--baseline)"
              tick={{ fill: 'var(--text-muted)', fontSize: 12 }}
            />
            <YAxis stroke="var(--baseline)" tick={{ fill: 'var(--text-muted)', fontSize: 12 }} />
            <Tooltip content={<CustomTooltip unit={unit} daily />} />
            <Bar dataKey="value" fill={color} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      ) : (
        <ResponsiveContainer width="100%" height={360}>
          <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
            <CartesianGrid stroke="var(--gridline)" vertical={false} />
            <XAxis
              dataKey="timestamp"
              type="number"
              domain={['dataMin', 'dataMax']}
              tickFormatter={formatTick}
              stroke="var(--baseline)"
              tick={{ fill: 'var(--text-muted)', fontSize: 12 }}
            />
            <YAxis stroke="var(--baseline)" tick={{ fill: 'var(--text-muted)', fontSize: 12 }} />
            <Tooltip content={<CustomTooltip unit={unit} />} />
            <Line
              type="monotone"
              dataKey="value"
              stroke={color}
              strokeWidth={2}
              dot={chartData.length <= 60}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
