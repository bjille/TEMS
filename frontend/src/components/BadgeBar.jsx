import { useNavigate } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { selectParametersForWoning } from '../features/parameters/parametersSlice';
import { colorForType } from '../palette';
import './BadgeBar.css';

// Material Design Icons paths (24x24), one per parameter type.
const ICONS = {
  home: 'M10,20V14H14V20H19V12H22L12,3L2,12H5V20H10Z',
  flash: 'M7,2V13H10V22L17,10H13L17,2H7Z',
  battery:
    'M16.67,4H15V2H9V4H7.33A1.33,1.33 0 0,0 6,5.33V20.67C6,21.4 6.6,22 7.33,22H16.67A1.33,1.33 0 0,0 18,20.67V5.33C18,4.6 17.4,4 16.67,4Z',
  solar:
    'M4,2H20A2,2 0 0,1 22,4V14A2,2 0 0,1 20,16H15V20H18V22H13V16H11V22H6V20H9V16H4A2,2 0 0,1 2,14V4A2,2 0 0,1 4,2M4,4V8H11V4H4M4,14H11V10H4V14M20,14V10H13V14H20M20,4H13V8H20V4Z',
  tower:
    'M8.28,5.45L6.5,4.55L7.76,2H16.23L17.5,4.55L15.72,5.44L15,4H9L8.28,5.45M18.62,8H14.09L13.3,5H10.7L9.91,8H5.38L4.1,10.55L5.89,11.44L6.62,10H17.38L18.1,11.45L19.89,10.56L18.62,8M17.77,22H15.7L15.46,21.1L12,15.9L8.53,21.1L8.3,22H6.23L9.12,11H11.19L10.83,12.35L12,14.1L13.16,12.35L12.81,11H14.88L17.77,22M11.4,15L10.5,13.65L9.32,18.13L11.4,15M14.68,18.12L13.5,13.64L12.6,15L14.68,18.12Z',
  car: 'M5,11L6.5,6.5H17.5L19,11M17.5,16A1.5,1.5 0 0,1 16,14.5A1.5,1.5 0 0,1 17.5,13A1.5,1.5 0 0,1 19,14.5A1.5,1.5 0 0,1 17.5,16M6.5,16A1.5,1.5 0 0,1 5,14.5A1.5,1.5 0 0,1 6.5,13A1.5,1.5 0 0,1 8,14.5A1.5,1.5 0 0,1 6.5,16M18.92,6C18.72,5.42 18.16,5 17.5,5H6.5C5.84,5 5.28,5.42 5.08,6L3,12V20A1,1 0 0,0 4,21H5A1,1 0 0,0 6,20V19H18V20A1,1 0 0,0 19,21H20A1,1 0 0,0 21,20V12L18.92,6Z',
  euro: 'M15,18.5C12.49,18.5 10.32,17.08 9.24,15H15L16,13H8.58C8.53,12.67 8.5,12.34 8.5,12C8.5,11.66 8.53,11.33 8.58,11H15L16,9H9.24C10.32,6.92 12.5,5.5 15,5.5C16.61,5.5 18.09,6.09 19.23,7.07L21,5.3C19.41,3.87 17.3,3 15,3C11.08,3 7.76,5.51 6.52,9H3L2,11H6.06C6.02,11.33 6,11.66 6,12C6,12.34 6.02,12.67 6.06,13H3L2,15H6.52C7.76,18.49 11.08,21 15,21C17.31,21 19.41,20.13 21,18.7L19.22,16.93C18.09,17.91 16.62,18.5 15,18.5Z',
  toggle:
    'M17,7H7A5,5 0 0,0 2,12A5,5 0 0,0 7,17H17A5,5 0 0,0 22,12A5,5 0 0,0 17,7M17,15A3,3 0 0,1 14,12A3,3 0 0,1 17,9A3,3 0 0,1 20,12A3,3 0 0,1 17,15Z',
};

const ICON_FOR_TYPE = {
  battery_soc: 'battery',
  battery_power: 'flash',
  solar_power: 'solar',
  grid_power: 'tower',
  energy_consumption: 'home',
  electricity_price: 'euro',
  gas_price: 'euro',
  energy_meter: 'flash',
  ev_charger_power: 'car',
  ev_status: 'car',
  switch_consumer: 'toggle',
  switch_controllable: 'toggle',
  select_mode: 'toggle',
  number_controllable: 'toggle',
};

// Belgian notation ("1.345 W", "48,0%"): large values without decimals,
// small ones with a single decimal so e.g. a SOC still moves visibly.
function formatBadgeValue(parameter) {
  const value = parameter.latest?.value;
  if (value === null || value === undefined) return '—';
  if (typeof value !== 'number') return parameter.optionLabels?.[value] || String(value);
  const decimals = parameter.type === 'electricity_price' || parameter.type === 'gas_price' ? 3 : Math.abs(value) >= 100 ? 0 : 1;
  const text = value.toLocaleString('nl-BE', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  const unit = parameter.unit || '';
  if (!unit) return text;
  return unit === '%' ? `${text}%` : `${text} ${unit}`;
}

// Compact live-value chips for every parameter flagged `badge`, shown at the
// top of the dashboard, chart detail and history pages. The page itself is
// responsible for fetching the parameters and subscribing to live readings.
// `sticky` keeps the bar pinned under the header while scrolling — meant for
// pages about a single woning, not the multi-woning overview.
export default function BadgeBar({ woningId, sticky = false }) {
  const navigate = useNavigate();
  const parameters = useSelector(selectParametersForWoning(woningId));
  const badges = parameters.filter((p) => p.badge);

  if (badges.length === 0) return null;

  return (
    <div className={`badge-bar${sticky ? ' badge-bar-sticky' : ''}`}>
      {badges.map((p) => {
        const open = () => navigate(`/woningen/${woningId}/parameters/${p._id}/history`);
        return (
          <div
            key={p._id}
            className="badge-chip"
            role="button"
            tabIndex={0}
            title={p.latest?.timestamp ? new Date(p.latest.timestamp).toLocaleTimeString('nl-BE') : 'Geen data'}
            onClick={open}
            onKeyDown={(e) => e.key === 'Enter' && open()}
          >
            <svg className="badge-icon" viewBox="0 0 24 24" style={{ color: colorForType(p.type) }} aria-hidden="true">
              <path d={ICONS[ICON_FOR_TYPE[p.type]] || ICONS.flash} fill="currentColor" />
            </svg>
            <div className="badge-text">
              <span className="badge-label">{p.label}</span>
              <span className="badge-value">{formatBadgeValue(p)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
