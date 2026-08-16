import { useNavigate } from 'react-router-dom';
import { colorForType } from '../palette';
import './Tile.css';

function formatValue(value, optionLabels) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value.toString() : value.toFixed(2);
  }
  return optionLabels?.[value] || String(value);
}

export default function Tile({ parameter, woningId, children }) {
  const navigate = useNavigate();
  const color = colorForType(parameter.type);
  const value = parameter.latest?.value;

  return (
    <div
      className="tile card"
      style={{ '--tile-accent': color }}
      onClick={() => navigate(`/woningen/${woningId}/parameters/${parameter._id}/history`)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && navigate(`/woningen/${woningId}/parameters/${parameter._id}/history`)}
    >
      <div className="tile-accent" />
      <div className="tile-label">{parameter.label}</div>
      <div className="tile-value">
        {formatValue(value, parameter.optionLabels)}
        {parameter.unit && <span className="tile-unit">{parameter.unit}</span>}
      </div>
      <div className="tile-meta muted">
        {parameter.latest?.timestamp
          ? new Date(parameter.latest.timestamp).toLocaleTimeString('nl-BE')
          : 'Geen data'}
      </div>
      {children && (
        <div className="tile-controls" onClick={(e) => e.stopPropagation()}>
          {children}
        </div>
      )}
    </div>
  );
}
