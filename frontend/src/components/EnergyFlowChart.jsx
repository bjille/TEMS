import { useMemo } from 'react';
import { useSelector } from 'react-redux';
import * as echarts from 'echarts/core';
import { SankeyChart, GraphChart } from 'echarts/charts';
import { TooltipComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import ReactEChartsCore from 'echarts-for-react/esm/core';
import { selectParametersForWoning } from '../features/parameters/parametersSlice';
import { CATEGORICAL } from '../palette';

// Registers only the chart types actually used, instead of pulling in
// ECharts' full bundle (all chart types, both renderers) through the
// default `echarts-for-react` import — that alone added ~1.2MB to the
// production bundle. Note: ECharts' sankey series has no circular layout —
// that's a `graph`-series-only feature — so the "circulaire lay-out" option
// renders as a graph diagram instead of a sankey when enabled.
echarts.use([SankeyChart, GraphChart, TooltipComponent, SVGRenderer]);

const NODE_COLORS = {
  Thuis: CATEGORICAL.blue,
  Zonnepanelen: CATEGORICAL.aqua,
  Batterij: CATEGORICAL.violet,
  Net: CATEGORICAL.magenta,
  Overig: 'var(--text-muted)',
};

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
// consumption) isn't measured directly — it's whatever supply is left after
// the directly-measured export/charging draws are subtracted, i.e. supply
// minus those other sinks, not the raw pass-through total.
//
// We can't know which physical source fed which sink (only the aggregate
// totals), so supply is allocated across demands greedily in a fixed
// priority order — Thuis first (the real-time household load), then
// whatever's left goes to export/charging. This keeps every negative value
// as its own separate, correctly-sized link instead of folding them all
// into one combined flow.
function buildFlows({ pv, battery, grid }) {
  const supplies = [];
  const otherDemands = [];

  if (typeof pv === 'number' && pv > 0.5) supplies.push({ name: 'Zonnepanelen', amount: pv });
  if (typeof grid === 'number') {
    if (grid > 0.5) supplies.push({ name: 'Net', amount: grid });
    else if (grid < -0.5) otherDemands.push({ name: 'Net', amount: -grid });
  }
  if (typeof battery === 'number') {
    if (battery > 0.5) supplies.push({ name: 'Batterij', amount: battery });
    else if (battery < -0.5) otherDemands.push({ name: 'Batterij', amount: -battery });
  }

  const totalSupply = supplies.reduce((s, x) => s + x.amount, 0);
  const totalOtherDemand = otherDemands.reduce((s, x) => s + x.amount, 0);
  const thuis = round(totalSupply - totalOtherDemand);
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

export default function EnergyFlowChart({ chart, woningId, height = 300 }) {
  const parameters = useSelector(selectParametersForWoning(woningId));
  const byId = useMemo(() => new Map(parameters.map((p) => [p._id, p])), [parameters]);

  const latestByRole = useMemo(
    () => ({
      pv: lookupValue(byId, chart.flowRoles?.pv),
      battery: lookupValue(byId, chart.flowRoles?.battery),
      grid: lookupValue(byId, chart.flowRoles?.grid),
    }),
    [byId, chart.flowRoles]
  );

  const devicesByParent = useMemo(() => {
    const map = new Map();
    (chart.devices || []).forEach((d) => {
      const id = String(d.parameter?._id || d.parameter);
      const parentId = d.parent ? String(d.parent?._id || d.parent) : null;
      const entry = { id, name: d.parameter?.label || id, value: lookupValue(byId, d.parameter) };
      if (!map.has(parentId)) map.set(parentId, []);
      map.get(parentId).push(entry);
    });
    return map;
  }, [byId, chart.devices]);

  const { nodes, links } = useMemo(() => {
    const flows = buildFlows(latestByRole);
    return applyDeviceTree(flows.nodes, flows.links, devicesByParent);
  }, [latestByRole, devicesByParent]);

  const option = useMemo(() => {
    const base = {
      textStyle: { color: 'var(--text-secondary)' },
      tooltip: {
        trigger: 'item',
        formatter: (p) =>
          p.dataType === 'edge'
            ? `${p.data.source} → ${p.data.target}: ${p.data.value} W`
            : `${p.name}: ${round(p.value ?? p.data.value ?? 0)} W`,
      },
    };

    if (!chart.circular) {
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
    }

    // ECharts' sankey series has no circular layout, so "circulaire
    // lay-out" instead renders the same nodes/links as a `graph` series
    // (which does support layout: 'circular'), with arrowheads on the
    // edges to keep the flow direction readable. A node's "value" is
    // max(inflow, outflow) rather than their sum — most nodes are pure
    // sources or pure sinks anyway, but a pass-through node like "Thuis"
    // (or "Stroomkring A" with its own children) has both, and since they
    // balance by construction, summing them would silently double it.
    const inflowByNode = new Map();
    const outflowByNode = new Map();
    links.forEach((l) => {
      outflowByNode.set(l.source, (outflowByNode.get(l.source) || 0) + l.value);
      inflowByNode.set(l.target, (inflowByNode.get(l.target) || 0) + l.value);
    });
    function nodeValue(name) {
      return Math.max(inflowByNode.get(name) || 0, outflowByNode.get(name) || 0);
    }
    const maxFlow = Math.max(...nodes.map((n) => nodeValue(n.name)), 1);
    const graphNodes = nodes.map((n) => ({
      ...n,
      value: round(nodeValue(n.name)),
      symbolSize: 16 + (34 * nodeValue(n.name)) / maxFlow,
    }));

    return {
      ...base,
      series: [
        {
          type: 'graph',
          layout: 'circular',
          circular: { rotateLabel: true },
          data: graphNodes,
          links,
          roam: false,
          label: {
            show: true,
            position: 'right',
            color: 'var(--text-secondary)',
            formatter: (p) => `${p.name}\n${p.value} W`,
          },
          edgeSymbol: ['none', 'arrow'],
          edgeSymbolSize: 8,
          lineStyle: { color: 'var(--baseline)', curveness: 0.2, opacity: 0.6 },
          emphasis: { focus: 'adjacency' },
        },
      ],
    };
  }, [nodes, links, chart.circular]);

  if (links.length === 0) {
    return <p className="muted">Geen live vermogensdata beschikbaar.</p>;
  }

  return (
    <ReactEChartsCore echarts={echarts} option={option} style={{ height }} opts={{ renderer: 'svg' }} />
  );
}
