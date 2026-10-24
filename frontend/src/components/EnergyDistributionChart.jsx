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
 * Splits the four live power readings (W; grid > 0 = import, battery > 0 =
 * discharging) into who feeds whom. Only the totals are measured, so — like
 * Home Assistant's energy distribution — solar goes to the house first,
 * then into the battery, then to the grid; the battery covers the house
 * before it feeds the grid; and the grid charges the battery only for what
 * the sun didn't.
 */
function splitFlows({ pv, grid, battery, thuisDirect }) {
  const sun = pos(pv);
  const imported = pos(grid);
  const exported = pos(-grid);
  const discharging = pos(battery);
  const charging = pos(-battery);

  const pvToGrid = Math.min(sun, exported);
  const pvToBattery = Math.min(sun - pvToGrid, charging);
  const pvToThuis = Math.max(0, sun - pvToGrid - pvToBattery);
  const batteryToGrid = Math.min(discharging, exported - pvToGrid);
  const gridToBattery = Math.min(imported, charging - pvToBattery);
  const batteryToThuis = Math.max(0, discharging - batteryToGrid);
  const gridToThuis = Math.max(0, imported - gridToBattery);
  const thuis = typeof thuisDirect === 'number' ? thuisDirect : pvToThuis + batteryToThuis + gridToThuis;

  return {
    thuis,
    toThuis: { pv: pvToThuis, battery: batteryToThuis, grid: gridToThuis },
    links: [
      { path: 'pvThuis', from: 'pv', value: pvToThuis },
      { path: 'pvGrid', from: 'pv', value: pvToGrid },
      { path: 'pvBattery', from: 'pv', value: pvToBattery },
      { path: 'gridThuis', from: 'grid', value: gridToThuis },
      { path: 'gridBattery', from: 'grid', value: gridToBattery },
      { path: 'gridBattery', from: 'battery', value: batteryToGrid, reverse: true },
      { path: 'batteryThuis', from: 'battery', value: batteryToThuis },
    ],
  };
}

function formatPower(w) {
  const abs = Math.abs(w);
  if (abs >= 1000) return `${(w / 1000).toLocaleString('nl-BE', { maximumFractionDigits: 1, minimumFractionDigits: 1 })} kW`;
  return `${Math.round(w).toLocaleString('nl-BE')} W`;
}

// More power, faster dots: from 6 s per run at a trickle to 1 s at 5 kW+.
const durationFor = (w) => `${(6 - 5 * Math.min(1, Math.sqrt(w / 5000))).toFixed(2)}s`;

function Flow({ id, link }) {
  const active = link.value > 1;
  return (
    <g>
      <path id={id} d={PATHS[link.path]} className="edc-line" />
      {active && (
        <>
          <path d={PATHS[link.path]} className="edc-line edc-line-active" style={{ stroke: COLORS[link.from] }} />
          <circle r="4" style={{ fill: COLORS[link.from] }}>
            <animateMotion
              dur={durationFor(link.value)}
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
function SourceRing({ x, y, toThuis }) {
  const total = toThuis.pv + toThuis.battery + toThuis.grid;
  const circumference = 2 * Math.PI * R;
  if (total <= 1) return <circle cx={x} cy={y} r={R} className="edc-ring" style={{ stroke: COLORS.thuis }} />;
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
 * batterij and thuis, with dots running along the lines between them for
 * the live power flows. `latest` holds the readings (W) per role, as in
 * EnergyFlowChart; `soc` (%) is optional.
 */
export default function EnergyDistributionChart({ latest, soc, height = 320 }) {
  const idPrefix = useId().replace(/:/g, '');
  const flows = useMemo(() => splitFlows(latest), [latest]);
  const has = (role) => typeof latest[role] === 'number';
  const hasPv = has('pv');
  const hasGrid = has('grid');
  const hasBattery = has('battery');
  if (!hasPv && !hasGrid && !hasBattery) return <p className="muted">Geen live vermogensdata beschikbaar.</p>;

  return (
    <svg viewBox="0 0 420 384" className="edc" style={{ height }} role="img" aria-label="Energiedistributie">
      {flows.links
        .filter((link) => PATH_NODES[link.path].every(has))
        .map((link) => (
          <Flow key={`${link.path}-${link.from}`} id={`${idPrefix}-${link.path}-${link.from}`} link={link} />
        ))}
      {hasPv && <Node role="pv" lines={[{ text: formatPower(pos(latest.pv)) }]} />}
      {hasGrid && (
        <Node
          role="grid"
          lines={[
            { text: `← ${formatPower(pos(-latest.grid))}`, color: COLORS.pv },
            { text: `→ ${formatPower(pos(latest.grid))}`, color: COLORS.grid },
          ]}
        />
      )}
      {hasBattery && (
        <Node
          role="battery"
          lines={[
            ...(typeof soc === 'number' ? [{ text: `${Math.round(soc)} %` }] : []),
            { text: `↓ ${formatPower(pos(-latest.battery))}` },
            { text: `↑ ${formatPower(pos(latest.battery))}` },
          ]}
        />
      )}
      <Node role="thuis" lines={[{ text: formatPower(Math.max(0, flows.thuis)) }]}>
        <SourceRing x={NODES.thuis.x} y={NODES.thuis.y} toThuis={flows.toThuis} />
      </Node>
    </svg>
  );
}
