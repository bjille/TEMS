import { useState } from 'react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';

function formatTick(ts) {
  const d = new Date(ts);
  return d.toLocaleString('nl-BE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function CustomTooltip({ active, payload, label, unit }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="card" style={{ padding: '8px 12px' }}>
      <div className="muted" style={{ fontSize: '0.8em' }}>
        {new Date(label).toLocaleString('nl-BE')}
      </div>
      <div style={{ fontWeight: 600 }}>
        {payload[0].value}
        {unit ? ` ${unit}` : ''}
      </div>
    </div>
  );
}

export default function HistoryChart({ data, color, unit }) {
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
                <th>Tijdstip</th>
                <th>Waarde</th>
              </tr>
            </thead>
            <tbody>
              {data.map((r, i) => (
                <tr key={i}>
                  <td>{new Date(r.timestamp).toLocaleString('nl-BE')}</td>
                  <td>
                    {r.value}
                    {unit ? ` ${unit}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
