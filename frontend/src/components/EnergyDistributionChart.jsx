import { useId, useMemo } from 'react';
import { CATEGORICAL } from '../palette';
import { ICONS } from './BadgeBar';
import './EnergyDistributionChart.css';

// Same identity colors as the sankey's nodes (see EnergyFlowChart.jsx).
const COLORS = {
  pv: CATEGORICAL.aqua,
  grid: CATEGORICAL.magenta,
  battery: CATEGORICAL.violet,
  thuis: CATEGORICAL.blue,
};

// Fixed layout (viewBox 420 × 384): zon on top, net left, thuis right,
// batterij below — the lines between them meet in the middle.
const R = 44;
const NODES = {
  pv: { x: 210, y: 64, label: 'Zonne-energie', icon: 'solar', labelAbove: true },
  grid: { x: 56, y: 195, label: 'Net', icon: 'tower' },
  thuis: { x: 364, y: 195, label: 'Thuis', icon: 'home' },
  battery: { x: 210, y: 318, label: 'Batterij', icon: 'battery' },
};

// One path per pair of nodes, always drawn from the first to the second;
// a flow the other way runs the dots backwards.
const PATHS = {
  pvThuis: 'M 228,105 V 158 Q 228 183 253 183 H 320',
  pvGrid: 'M 192,105 V 158 Q 192 183 167 183 H 100',
  pvBattery: 'M 210,108 V 274',
  gridThuis: 'M 100,195 H 320',
  gridBattery: 'M 100,207 H 167 Q 192 207 192 232 V 277',
  batteryThuis: 'M 228,277 V 232 Q 228 207 253 207 H 320',
};

// The nodes besides "Thuis" each path connects: it's only drawn when
// those have a sensor.
const PATH_NODES = {
  pvThuis: ['pv'],
  pvGrid: ['pv', 'grid'],
  pvBattery: ['pv', 'battery'],
  gridThuis: ['grid'],
  gridBattery: ['grid', 'battery'],
  batteryThuis: ['battery'],
};

const pos = (v) => (typeof v === 'number' && v > 0 ? v : 0);

/**
 * The live power readings (W; grid > 0 = import, battery > 0 = discharging)
 * in the shape of period totals, both directions apart — so one split
 * serves the live view and a period alike.
 */
export function liveTotals({ pv, grid, battery, thuisDirect }) {
  const totals = {};
  if (typeof pv === 'number') totals.pv = pos(pv);
  if (typeof grid === 'number') Object.assign(totals, { gridImport: pos(grid), gridExport: pos(-grid) });
  if (typeof battery === 'number') Object.assign(totals, { discharge: pos(battery), charge: pos(-battery) });
  if (typeof thuisDirect === 'number') totals.thuis = thuisDirect;
  return totals;
}

/**
 * Splits what was produced, imported, exported, charged and discharged
 * (W live, kWh over a period) into who fed whom. Only those totals are
 * measured, so it's allocated like Home Assistant's energy distribution:
 * what went to the grid and into the battery came from the sun as far as
 * it reached, and the rest of the sun went to the house; the battery fed
 * the grid only for what the sun didn't, and the grid charged the battery
 * only for what the sun didn't.
 */
export function splitEnergy(totals) {
  const sun = pos(totals.pv);
  const imported = pos(totals.gridImport);
  const exported = pos(totals.gridExport);
  const discharging = pos(totals.discharge);
  const charging = pos(totals.charge);

  const pvToGrid = Math.min(sun, exported);
  const pvToBattery = Math.min(sun - pvToGrid, charging);
  const pvToThuis = Math.max(0, sun - pvToGrid - pvToBattery);
  const batteryToGrid = Math.max(0, Math.min(discharging, exported - pvToGrid));
  const gridToBattery = Math.max(0, Math.min(imported, charging - pvToBattery));
  const batteryToThuis = Math.max(0, discharging - batteryToGrid);
  const gridToThuis = Math.max(0, imported - gridToBattery);
  const thuis = typeof totals.thuis === 'number' ? totals.thuis : pvToThuis + batteryToThuis + gridToThuis;

  return {
    thuis,
    toThuis: { pv: pvToThuis, battery: batteryToThuis, grid: gridToThuis },
    links: [
      { path: 'pvThuis', from: 'pv', to: 'thuis', value: pvToThuis },
      { path: 'pvGrid', from: 'pv', to: 'grid', value: pvToGrid },
      { path: 'pvBattery', from: 'pv', to: 'battery', value: pvToBattery },
      { path: 'gridThuis', from: 'grid', to: 'thuis', value: gridToThuis },
      { path: 'gridBattery', from: 'grid', to: 'battery', value: gridToBattery },
      { path: 'gridBattery', from: 'battery', to: 'grid', value: batteryToGrid, reverse: true },
      { path: 'batteryThuis', from: 'battery', to: 'thuis', value: batteryToThuis },
    ],
  };
}

function formatPower(w) {
  const abs = Math.abs(w);
  if (abs >= 1000) return `${(w / 1000).toLocaleString('nl-BE', { maximumFractionDigits: 1, minimumFractionDigits: 1 })} kW`;
  return `${Math.round(w).toLocaleString('nl-BE')} W`;
}

function formatEnergy(kwh) {
  return `${kwh.toLocaleString('nl-BE', { maximumFractionDigits: kwh >= 100 ? 0 : kwh >= 10 ? 1 : 2 })} kWh`;
}

// What counts as a flow at all, and the size at which dots run fastest.
const SCALES = {
  W: { min: 1, full: 5000, format: formatPower },
  kWh: { min: 0.005, format: formatEnergy },
};

// More flow, faster dots: from 6 s per run at a trickle to 1 s at `full`.
const durationFor = (value, full) => `${(6 - 5 * Math.min(1, Math.sqrt(value / full))).toFixed(2)}s`;

function Flow({ id, link, scale }) {
  const active = link.value > scale.min;
  return (
    <g>
      <path id={id} d={PATHS[link.path]} className="edc-line" />
      {active && (
        <>
          <path d={PATHS[link.path]} className="edc-line edc-line-active" style={{ stroke: COLORS[link.from] }} />
          <circle r="4" style={{ fill: COLORS[link.from] }}>
            <animateMotion
              dur={durationFor(link.value, scale.full)}
              repeatCount="indefinite"
              calcMode="linear"
              keyPoints={link.reverse ? '1;0' : '0;1'}
              keyTimes="0;1"
            >
              <mpath href={`#${id}`} />
            </animateMotion>
          </circle>
        </>
      )}
    </g>
  );
}

// "Thuis"'s ring, split into what share each source covers right now.
function SourceRing({ x, y, toThuis, min }) {
  const total = toThuis.pv + toThuis.battery + toThuis.grid;
  const circumference = 2 * Math.PI * R;
  if (total <= min) return <circle cx={x} cy={y} r={R} className="edc-ring" style={{ stroke: COLORS.thuis }} />;
  let offset = 0;
  return (
    <g transform={`rotate(-90 ${x} ${y})`}>
      {['pv', 'battery', 'grid'].map((source) => {
        const length = (toThuis[source] / total) * circumference;
        const segment = (
          <circle
            key={source}
            cx={x}
            cy={y}
            r={R}
            className="edc-ring"
            style={{ stroke: COLORS[source] }}
            strokeDasharray={`${length} ${circumference - length}`}
            strokeDashoffset={-offset}
          />
        );
        offset += length;
        return length > 0 ? segment : null;
      })}
    </g>
  );
}

function Node({ role, lines, children }) {
  const { x, y, label, icon, labelAbove } = NODES[role];
  // Icon on top, then one or two lines of values, centered in the circle.
  const top = y - 4 - (lines.length - 1) * 7;
  return (
    <g>
      {children || <circle cx={x} cy={y} r={R} className="edc-ring" style={{ stroke: COLORS[role] }} />}
      <svg x={x - 11} y={top - 25} width="22" height="22" viewBox="0 0 24 24">
        <path d={ICONS[icon]} className="edc-icon" />
      </svg>
      {lines.map((line, i) => (
        <text key={i} x={x} y={top + 11 + i * 14} className="edc-value" style={line.color ? { fill: line.color } : null}>
          {line.text}
        </text>
      ))}
      <text x={x} y={labelAbove ? y - R - 8 : y + R + 16} className="edc-label">
        {label}
      </text>
    </g>
  );
}

/**
 * Home Assistant-style energy distribution: fixed icons for zon, net,
 * batterij and thuis, with dots running along the lines between them.
 * `totals` is what splitEnergy takes — the live power (W, see liveTotals)
 * or a period's energy (kWh) — and `unit` says which; `soc` (%) is
 * optional.
 */
export default function EnergyDistributionChart({ totals, unit = 'W', soc, height = 320 }) {
  const idPrefix = useId().replace(/:/g, '');
  const flows = useMemo(() => splitEnergy(totals), [totals]);
  const scale = useMemo(() => {
    const base = SCALES[unit] || SCALES.W;
    // A period's totals have no natural top speed: the biggest flow runs fastest.
    return base.full ? base : { ...base, full: Math.max(...flows.links.map((l) => l.value), base.min) };
  }, [unit, flows]);
  const has = (role) =>
    role === 'pv'
      ? typeof totals.pv === 'number'
      : role === 'grid'
      ? typeof totals.gridImport === 'number'
      : typeof totals.discharge === 'number';
  const hasPv = has('pv');
  const hasGrid = has('grid');
  const hasBattery = has('battery');
  if (!hasPv && !hasGrid && !hasBattery) {
    return <p className="muted">{unit === 'W' ? 'Geen live vermogensdata beschikbaar.' : 'Geen energiedata voor deze periode.'}</p>;
  }
  const format = scale.format;

  return (
    <svg viewBox="0 0 420 384" className="edc" style={{ height }} role="img" aria-label="Energiedistributie">
      {flows.links
        .filter((link) => PATH_NODES[link.path].every(has))
        .map((link) => (
          <Flow key={`${link.path}-${link.from}`} id={`${idPrefix}-${link.path}-${link.from}`} link={link} scale={scale} />
        ))}
      {hasPv && <Node role="pv" lines={[{ text: format(pos(totals.pv)) }]} />}
      {hasGrid && (
        <Node
          role="grid"
          lines={[
            { text: `← ${format(pos(totals.gridExport))}`, color: COLORS.pv },
            { text: `→ ${format(pos(totals.gridImport))}`, color: COLORS.grid },
          ]}
        />
      )}
      {hasBattery && (
        <Node
          role="battery"
          lines={[
            ...(typeof soc === 'number' ? [{ text: `${Math.round(soc)} %` }] : []),
            { text: `↓ ${format(pos(totals.charge))}` },
            { text: `↑ ${format(pos(totals.discharge))}` },
          ]}
        />
      )}
      <Node role="thuis" lines={[{ text: format(Math.max(0, flows.thuis)) }]}>
        <SourceRing x={NODES.thuis.x} y={NODES.thuis.y} toThuis={flows.toThuis} min={scale.min} />
      </Node>
    </svg>
  );
}
