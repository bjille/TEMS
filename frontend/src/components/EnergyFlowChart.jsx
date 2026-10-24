import { useEffect, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import * as echarts from 'echarts/core';
import { SankeyChart } from 'echarts/charts';
import { TooltipComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import ReactEChartsCore from 'echarts-for-react/esm/core';
import { selectParametersForWoning } from '../features/parameters/parametersSlice';
import { api } from '../services/api';
import { CATEGORICAL } from '../palette';
import EnergyDistributionChart, { liveTotals, splitEnergy } from './EnergyDistributionChart';

// Registers only the chart types actually used, instead of pulling in
// ECharts' full bundle (all chart types, both renderers) through the
// default `echarts-for-react` import — that alone added ~1.2MB to the
// production bundle. The chart's `circular` option ("Energiedistributie")
// doesn't use ECharts at all (see EnergyDistributionChart).
echarts.use([SankeyChart, TooltipComponent, SVGRenderer]);

const NODE_COLORS = {
  Thuis: CATEGORICAL.blue,
  Zonnepanelen: CATEGORICAL.aqua,
  Batterij: CATEGORICAL.violet,
  Net: CATEGORICAL.magenta,
  'Net (teruglevering)': CATEGORICAL.magenta,
  'Batterij (laden)': CATEGORICAL.violet,
  Overig: 'var(--text-muted)',
};

// A period's energy refreshes this often while the period is still running.
const PERIOD_REFRESH_MS = 5 * 60 * 1000;

// Sankey node names for a period, where the grid and the battery can both
// supply and take energy: the taking side gets its own node, as a sankey
// can't loop back.
const SOURCE_NODE = { pv: 'Zonnepanelen', grid: 'Net', battery: 'Batterij' };
const TARGET_NODE = { thuis: 'Thuis', grid: 'Net (teruglevering)', battery: 'Batterij (laden)' };

// The sankey of a period from its energy split (see splitEnergy), in Wh so
// the thresholds and rounding made for watts fit.
function buildPeriodFlows(split) {
  const nodes = new Map();
  const links = [];
  for (const l of split.links) {
    const value = round(l.value * 1000);
    if (value <= 0.5) continue;
    const source = SOURCE_NODE[l.from];
    const target = TARGET_NODE[l.to];
    for (const name of [source, target]) {
      if (!nodes.has(name)) nodes.set(name, { name, itemStyle: { color: NODE_COLORS[name] } });
    }
    links.push({ source, target, value });
  }
  return { nodes: [...nodes.values()], links };
}

const DEVICE_PALETTE = [CATEGORICAL.yellow, CATEGORICAL.green, CATEGORICAL.red, CATEGORICAL.orange];

function round(n) {
  return Math.round(n * 10) / 10;
}

function lookupValue(byId, ref) {
  const p = ref && byId.get(ref._id || ref);
  const v = p?.latest?.value;
  return typeof v === 'number' ? v : undefined;
}

// Builds the flow diagram from three signed power sensors (W): PV is always
// >= 0; grid > 0 means importing, < 0 exporting; battery > 0 means
// discharging (to the house), < 0 means charging. "Thuis" (actual home
// consumption) is taken from a directly-measured sensor when `thuisDirect`
// is given; otherwise it falls back to whatever supply is left after the
// directly-measured export/charging draws are subtracted. That fallback
// assumes pv/battery/grid were all read at the same instant, which they
// aren't — each sensor updates on its own schedule, so the subtraction can
// dip below zero and silently drop the whole "Thuis" flow even while the
// house is clearly consuming power. A direct sensor sidesteps that entirely.
//
// We can't know which physical source fed which sink (only the aggregate
// totals), so supply is allocated across demands greedily in a fixed
// priority order — Thuis first (the real-time household load), then
// whatever's left goes to export/charging. This keeps every negative value
// as its own separate, correctly-sized link instead of folding them all
// into one combined flow.
//
// Battery is listed before PV in the supply queue on purpose: since Thuis
// is always the first demand filled, putting battery first caps its
// contribution at min(battery, thuis) — it can never be left with leftover
// once Thuis is satisfied, so it can never appear feeding Net (export) or a
// charging demand. Almost every home battery only discharges to cover load
// (self-consumption / "eigen verbruik" mode, by far the most common setup)
// and never exports to the grid on its own, so any supply left over after
// Thuis is satisfied should read as solar surplus, not battery — which is
// exactly what PV being queued second (and therefore the one left holding
// the leftover) produces. A system genuinely configured to discharge the
// battery to the grid still shows that correctly: it only happens once the
// battery's own reading exceeds what Thuis needed, i.e. there's a real
// leftover in its queue slot by the time Net is reached.
function buildFlows({ pv, battery, grid, thuisDirect }) {
  const supplies = [];
  const otherDemands = [];

  if (typeof battery === 'number' && battery > 0.5) supplies.push({ name: 'Batterij', amount: battery });
  if (typeof pv === 'number' && pv > 0.5) supplies.push({ name: 'Zonnepanelen', amount: pv });
  if (typeof grid === 'number') {
    if (grid > 0.5) supplies.push({ name: 'Net', amount: grid });
    else if (grid < -0.5) otherDemands.push({ name: 'Net', amount: -grid });
  }
  if (typeof battery === 'number' && battery < -0.5) otherDemands.push({ name: 'Batterij', amount: -battery });

  const totalSupply = supplies.reduce((s, x) => s + x.amount, 0);
  const totalOtherDemand = otherDemands.reduce((s, x) => s + x.amount, 0);
  const thuis = round(typeof thuisDirect === 'number' ? thuisDirect : totalSupply - totalOtherDemand);
  const demands = thuis > 0.5 ? [{ name: 'Thuis', amount: thuis }, ...otherDemands] : otherDemands;

  const nodes = new Map();
  function addNode(name) {
    if (!nodes.has(name)) nodes.set(name, { name, itemStyle: { color: NODE_COLORS[name] } });
  }

  const links = [];
  const supplyQueue = supplies.map((s) => ({ ...s }));
  const demandQueue = demands.map((d) => ({ ...d }));
  let si = 0;
  let di = 0;
  while (si < supplyQueue.length && di < demandQueue.length) {
    const s = supplyQueue[si];
    const d = demandQueue[di];
    const amount = Math.min(s.amount, d.amount);
    if (amount > 0.05) {
      addNode(s.name);
      addNode(d.name);
      links.push({ source: s.name, target: d.name, value: round(amount) });
    }
    s.amount -= amount;
    d.amount -= amount;
    if (s.amount <= 0.05) si += 1;
    if (d.amount <= 0.05) di += 1;
  }

  return { nodes: [...nodes.values()], links };
}

const MAX_DEVICE_DEPTH = 8;

// Further splits "Thuis" into individually metered appliances, arranged as
// a tree — a device can itself be the parent of other devices (e.g.
// "Frigo" and "Oven" both under "Stroomkring A"), each level getting its
// own "Overig" link for whatever its own children don't cover. A device's
// children are split relative to *its own* reading (not the amount it was
// actually allocated from its parent), since its sensor is an independent
// measurement of its own total.
//
// `devicesByParent` maps a parent key (a parameter id, or null for
// top-level devices sitting directly under "Thuis") to that parent's
// children: [{ id, name, value }].
function applyDeviceTree(nodes, links, devicesByParent) {
  const thuisTotal = links.filter((l) => l.target === 'Thuis').reduce((s, l) => s + l.value, 0);
  if (thuisTotal <= 0.5 || devicesByParent.size === 0) return { nodes, links };

  const nodeMap = new Map(nodes.map((n) => [n.name, n]));
  const nextLinks = [...links];
  let colorIndex = 0;

  function addDeviceNode(name) {
    if (!nodeMap.has(name)) {
      nodeMap.set(name, { name, itemStyle: { color: DEVICE_PALETTE[colorIndex % DEVICE_PALETTE.length] } });
      colorIndex += 1;
    }
  }

  function distribute(nodeName, nodeId, total, depth) {
    if (depth > MAX_DEVICE_DEPTH) return;
    const children = devicesByParent.get(nodeId) || [];
    if (children.length === 0) return;

    let remaining = total;
    children.forEach((child) => {
      if (typeof child.value !== 'number' || child.value <= 0.5 || remaining <= 0.05) return;
      const amount = round(Math.min(child.value, remaining));
      if (amount <= 0.05) return;
      addDeviceNode(child.name);
      nextLinks.push({ source: nodeName, target: child.name, value: amount });
      remaining -= amount;
      distribute(child.name, child.id, child.value, depth + 1);
    });

    const overig = round(remaining);
    if (overig > 0.5) {
      const overigName = `${nodeName} · Overig`;
      if (!nodeMap.has(overigName)) {
        nodeMap.set(overigName, { name: overigName, itemStyle: { color: NODE_COLORS.Overig } });
      }
      nextLinks.push({ source: nodeName, target: overigName, value: overig });
    }
  }

  distribute('Thuis', null, thuisTotal, 0);

  return { nodes: [...nodeMap.values()], links: nextLinks };
}

/**
 * A saved DashboardChart of type 'energyflow': without `chart.window` the
 * live power flows (W), with one the energy over that period (kWh, from
 * GET /charts/:id/energy) — as a sankey, or as Home Assistant's energy
 * distribution with the chart's `circular` option.
 */
export default function EnergyFlowChart({ chart, woningId, height = 300 }) {
  const parameters = useSelector(selectParametersForWoning(woningId));
  const byId = useMemo(() => new Map(parameters.map((p) => [p._id, p])), [parameters]);
  const fromMs = chart.window ? new Date(chart.window.from).getTime() : null;
  const toMs = chart.window ? new Date(chart.window.to).getTime() : null;
  const isPeriod = fromMs !== null;
  const [energy, setEnergy] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (fromMs === null) return undefined;
    let cancelled = false;
    setEnergy(null);
    async function load() {
      try {
        const { data } = await api.get(`/woningen/${woningId}/charts/${chart._id}/energy`, {
          params: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
        });
        if (!cancelled) {
          setEnergy(data);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err.response?.data?.error?.message || 'Kon energiedata niet laden');
      }
    }
    load();
    const timer = toMs > Date.now() ? setInterval(load, PERIOD_REFRESH_MS) : null;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [woningId, chart._id, fromMs, toMs]);

  const latestByRole = useMemo(
    () => ({
      pv: lookupValue(byId, chart.flowRoles?.pv),
      battery: lookupValue(byId, chart.flowRoles?.battery),
      grid: lookupValue(byId, chart.flowRoles?.grid),
      thuisDirect: lookupValue(byId, chart.flowRoles?.thuis),
    }),
    [byId, chart.flowRoles]
  );

  // For the distribution diagram's battery: the woning's charge level.
  const soc = useMemo(() => {
    const v = parameters.find((p) => p.type === 'battery_soc')?.latest?.value;
    return typeof v === 'number' ? v : undefined;
  }, [parameters]);

  const devicesByParent = useMemo(() => {
    const map = new Map();
    (chart.devices || []).forEach((d) => {
      const id = String(d.parameter?._id || d.parameter);
      const parentId = d.parent ? String(d.parent?._id || d.parent) : null;
      const value = isPeriod
        ? typeof energy?.devices?.[id] === 'number'
          ? energy.devices[id] * 1000
          : undefined
        : lookupValue(byId, d.parameter);
      const entry = { id, name: d.parameter?.label || id, value };
      if (!map.has(parentId)) map.set(parentId, []);
      map.get(parentId).push(entry);
    });
    return map;
  }, [byId, chart.devices, isPeriod, energy]);

  const { nodes, links } = useMemo(() => {
    if (isPeriod && !energy) return { nodes: [], links: [] };
    const flows = isPeriod ? buildPeriodFlows(splitEnergy(energy)) : buildFlows(latestByRole);
    return applyDeviceTree(flows.nodes, flows.links, devicesByParent);
  }, [isPeriod, energy, latestByRole, devicesByParent]);

  const option = useMemo(() => {
    // A period's flows are in Wh (see buildPeriodFlows), shown as kWh.
    const format = (v) =>
      isPeriod ? `${(v / 1000).toLocaleString('nl-BE', { maximumFractionDigits: 2 })} kWh` : `${round(v)} W`;
    const base = {
      textStyle: { color: 'var(--text-secondary)' },
      tooltip: {
        trigger: 'item',
        formatter: (p) =>
          p.dataType === 'edge'
            ? `${p.data.source} → ${p.data.target}: ${format(p.data.value)}`
            : `${p.name}: ${format(p.value ?? p.data.value ?? 0)}`,
      },
    };

    return {
      ...base,
      series: [
        {
          type: 'sankey',
          data: nodes,
          links,
          emphasis: { focus: 'adjacency' },
          lineStyle: { color: 'gradient', curveness: 0.5, opacity: 0.4 },
          label: { color: 'var(--text-secondary)' },
          nodeAlign: 'justify',
        },
      ],
    };
  }, [nodes, links, isPeriod]);

  const totals = useMemo(() => (isPeriod ? energy : liveTotals(latestByRole)), [isPeriod, energy, latestByRole]);

  if (error) return <p className="error-text">{error}</p>;
  if (isPeriod && !energy) return <p className="muted">Laden...</p>;

  // "Energiedistributie" (the chart's `circular` option): fixed icons
  // instead of a sankey. The charge level only means something live.
  if (chart.circular) {
    return (
      <EnergyDistributionChart
        totals={totals}
        unit={isPeriod ? 'kWh' : 'W'}
        soc={isPeriod ? undefined : soc}
        height={height}
      />
    );
  }

  if (links.length === 0) {
    return (
      <p className="muted">{isPeriod ? 'Geen energiedata voor deze periode.' : 'Geen live vermogensdata beschikbaar.'}</p>
    );
  }

  return (
    <ReactEChartsCore echarts={echarts} option={option} style={{ height }} opts={{ renderer: 'svg' }} />
  );
}
