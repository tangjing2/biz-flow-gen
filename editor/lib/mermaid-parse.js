/**
 * 解析 业务流程.md 里的 mermaid 子集 → BizFlowDoc。
 * 支持：flowchart LR|TD、subgraph 泳道、开始/处理/判定/批注、实线/虚线/链式边。
 */

function cleanLabel(raw) {
  let s = String(raw ?? '').trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  return s.replace(/<br\s*\/?>/gi, '\n').trim();
}

function shapeKindFromDef(def) {
  const stadium = def.match(/^\(\[(.+)\]\)$/);
  if (stadium) {
    const t = cleanLabel(stadium[1]);
    return { kind: /结束|done|end/i.test(t) ? 'end' : 'start', text: t };
  }
  const diamond = def.match(/^\{(.+)\}$/);
  if (diamond) return { kind: 'decision', text: cleanLabel(diamond[1]) };
  const circle = def.match(/^\(\((.+)\)\)$/);
  if (circle) return { kind: 'start', text: cleanLabel(circle[1]) };
  const rect = def.match(/^\[(.+)\]$/);
  if (rect) return { kind: 'process', text: cleanLabel(rect[1]) };
  return { kind: 'process', text: cleanLabel(def) };
}

function parseEdgeSegment(seg) {
  const dashedMatch = seg.match(/^([A-Za-z_][\w-]*)\s*(?:-\.\s*(.*?)\s*\.-\>|-\.\.-\>)\s*([A-Za-z_][\w-]*)$/);
  if (dashedMatch) {
    return { from: dashedMatch[1], to: dashedMatch[3], label: cleanLabel(dashedMatch[2] || ''), dashed: true };
  }
  const dashedSimple = seg.match(/^([A-Za-z_][\w-]*)\s*-\.-\>\s*([A-Za-z_][\w-]*)$/);
  if (dashedSimple) {
    return { from: dashedSimple[1], to: dashedSimple[2], label: '', dashed: true };
  }
  const solidLabel = seg.match(/^([A-Za-z_][\w-]*)\s*--\>\s*\|([^|]*)\|\s*([A-Za-z_][\w-]*)$/);
  if (solidLabel) {
    return { from: solidLabel[1], to: solidLabel[3], label: cleanLabel(solidLabel[2]), dashed: false };
  }
  const solid = seg.match(/^([A-Za-z_][\w-]*)\s*--\>\s*([A-Za-z_][\w-]*)$/);
  if (solid) {
    return { from: solid[1], to: solid[2], label: '', dashed: false };
  }
  return null;
}

export function parseMermaid(src) {
  const lines = String(src ?? '').replace(/\r\n/g, '\n').split('\n');
  let orientation = 'column';
  const lanes = [];
  const nodes = [];
  const edges = [];
  const annoIds = new Set();

  let currentLane = '';
  let orderInLane = 0;
  let inCode = false;
  let sawFence = /```mermaid/.test(String(src ?? ''));
  if (!sawFence) inCode = true;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('```mermaid')) {
      inCode = true;
      continue;
    }
    if (inCode && trimmed.startsWith('```')) {
      inCode = false;
      continue;
    }
    if (!inCode) continue;

    const flowMatch = trimmed.match(/^flowchart\s+(LR|RL|TD|TB)\b/i);
    if (flowMatch) {
      const dir = flowMatch[1].toUpperCase();
      orientation = dir === 'LR' || dir === 'RL' ? 'column' : 'row';
      continue;
    }

    if (/^classDef\s+anno\b/.test(trimmed)) continue;

    const subMatch = trimmed.match(/^subgraph\s+(\w+)\s*\[["']?(.+?)["']?\]\s*$/);
    if (subMatch) {
      currentLane = subMatch[1];
      lanes.push({ id: currentLane, label: cleanLabel(subMatch[2]), axis: orientation === 'row' ? 'row' : 'col' });
      orderInLane = 0;
      continue;
    }
    if (trimmed === 'end') {
      currentLane = '';
      continue;
    }
    if (/^direction\s+/i.test(trimmed)) continue;
    if (/^%%/.test(trimmed)) continue;

    if (/&/.test(trimmed) && !/--/.test(trimmed) && !/\.-\>/.test(trimmed)) {
      continue;
    }

    const annoAssign = trimmed.match(/^([A-Za-z_][\w-]*)\s*:::\s*anno\b/);
    if (annoAssign) {
      annoIds.add(annoAssign[1]);
      const existing = nodes.find((n) => n.id === annoAssign[1]);
      if (existing) existing.kind = 'annotation';
      continue;
    }

    if (/-->|-\.->/.test(trimmed)) {
      const chain = splitEdgeChain(trimmed);
      for (const seg of chain) {
        const e = parseEdgeSegment(seg);
        if (e) {
          edges.push({ from: e.from, to: e.to, label: e.label, dashed: e.dashed });
        }
      }
      continue;
    }

    const nodeMatch = trimmed.match(/^([A-Za-z_][\w-]*)\s*(\(.*\)|\[.*\]|\{.*\})?\s*(?:::anno\b)?/);
    if (nodeMatch) {
      const id = nodeMatch[1];
      const defPart = nodeMatch[2] || '';
      const isAnno = /::anno\b/.test(trimmed) || annoIds.has(id);
      if (defPart) {
        const { kind, text } = shapeKindFromDef(defPart);
        nodes.push({
          id,
          text,
          kind: isAnno ? 'annotation' : kind,
          laneId: isAnno ? '' : (currentLane || ''),
          order: orderInLane++,
        });
      } else if (!nodes.find((n) => n.id === id)) {
        nodes.push({
          id,
          text: id,
          kind: isAnno ? 'annotation' : 'process',
          laneId: isAnno ? '' : (currentLane || ''),
          order: orderInLane++,
        });
      }
    }
  }

  for (const id of annoIds) {
    if (!nodes.find((n) => n.id === id)) {
      nodes.push({ id, text: id, kind: 'annotation', laneId: '', order: 0 });
    }
  }

  return { orientation, lanes, nodes, edges };
}

function splitEdgeChain(line) {
  const segs = [];
  const labels = [];
  let work = line.replace(/\|([^|]*)\|/g, (_m, lbl) => {
    labels.push(cleanLabel(lbl));
    return '\u0000';
  });
  work = work.replace(/-\.\s.*?\s\.-\>/g, '-\u0001>');
  const parts = work.split(/\s*(?:-->|-\u0001>|-\.->)\s*/).map((p) => p.replace(/\u0000/g, '').trim());
  const allOps = [];
  const opRe = /(-->)|(-\.->|-\.\s.*?\s\.-\>)/g;
  let am;
  while ((am = opRe.exec(line.replace(/\|[^|]*\|/g, '\u0000')))) {
    allOps.push({ dashed: Boolean(am[2]), pos: am.index });
  }
  let labelIdx = 0;
  for (let i = 0; i < parts.length - 1 && i < allOps.length; i++) {
    const from = parts[i]?.trim();
    const to = parts[i + 1]?.trim();
    if (!from || !to) continue;
    const op = allOps[i];
    const label = labels[labelIdx] || '';
    if (label) labelIdx++;
    if (op.dashed) {
      segs.push(`${from} -. ${label} .-> ${to}`);
    } else if (label) {
      segs.push(`${from} -->|${label}| ${to}`);
    } else {
      segs.push(`${from} --> ${to}`);
    }
  }
  return segs;
}

export function mermaidToDoc(src, title) {
  const { orientation, lanes, nodes, edges } = parseMermaid(src);

  const LANE_HEADER = 40;
  const LANE_GAP = 4;
  const NODE_W = 160;
  const NODE_H = 60;
  const RANK_GAP = 80;
  const ORIGIN_Y = 24;
  const LANE_W = NODE_W + 48;

  const allLanes = [...lanes];
  const laneIndex = new Map();
  for (let i = 0; i < allLanes.length; i++) laneIndex.set(allLanes[i].id, i);

  const nonAnnoNodes = nodes.filter((n) => n.kind !== 'annotation');
  for (const n of nonAnnoNodes) {
    if (!laneIndex.has(n.laneId)) {
      laneIndex.set(n.laneId, allLanes.length);
      allLanes.push({ id: n.laneId, label: n.laneId, axis: orientation === 'row' ? 'row' : 'col' });
    }
  }

  const nodeIds = new Set(nonAnnoNodes.map((n) => n.id));
  const incoming = new Map();
  const outgoing = new Map();
  for (const id of nodeIds) { incoming.set(id, []); outgoing.set(id, []); }
  for (const e of edges) {
    if (!nodeIds.has(e.from) || !nodeIds.has(e.to)) continue;
    if (e.dashed) continue;
    outgoing.get(e.from).push(e.to);
    incoming.get(e.to).push(e.from);
  }

  const rank = new Map();
  const startNodes = nonAnnoNodes.filter((n) => n.kind === 'start');
  const queue = [];
  if (startNodes.length) {
    for (const n of startNodes) { rank.set(n.id, 0); queue.push(n.id); }
  } else {
    for (const id of nodeIds) {
      if (incoming.get(id).length === 0) { rank.set(id, 0); queue.push(id); }
    }
  }
  if (!queue.length && nonAnnoNodes.length) {
    rank.set(nonAnnoNodes[0].id, 0);
    queue.push(nonAnnoNodes[0].id);
  }
  while (queue.length) {
    const id = queue.shift();
    const r = rank.get(id);
    for (const next of outgoing.get(id) || []) {
      const nr = rank.get(next);
      if (nr === undefined || nr < r + 1) {
        rank.set(next, r + 1);
        queue.push(next);
      }
    }
  }
  let maxRank = 0;
  for (const r of rank.values()) maxRank = Math.max(maxRank, r);
  for (const n of nonAnnoNodes) {
    if (!rank.has(n.id)) rank.set(n.id, maxRank + 1);
  }

  const rankLaneCount = new Map();
  const rankLaneIdx = new Map();
  for (const n of nonAnnoNodes) {
    const key = `${rank.get(n.id)}_${n.laneId}`;
    const cnt = rankLaneCount.get(key) || 0;
    rankLaneIdx.set(n.id, cnt);
    rankLaneCount.set(key, cnt + 1);
  }

  const canvasNodes = [];
  for (const n of nonAnnoNodes) {
    const li = laneIndex.get(n.laneId) || 0;
    const r = rank.get(n.id) || 0;
    const subIdx = rankLaneIdx.get(n.id) || 0;
    const h = n.kind === 'decision' ? 80 : NODE_H;
    canvasNodes.push({
      id: n.id,
      kind: n.kind,
      text: n.text,
      x: li * (LANE_W + LANE_GAP) + 24,
      y: ORIGIN_Y + LANE_HEADER + r * RANK_GAP + subIdx * (h + 12),
      w: NODE_W,
      h,
      laneId: n.laneId,
    });
  }

  const annoX = allLanes.length * (LANE_W + LANE_GAP) + 20;
  let annoY = ORIGIN_Y + LANE_HEADER;
  for (const n of nodes) {
    if (n.kind !== 'annotation') continue;
    canvasNodes.push({
      id: n.id, kind: 'annotation', text: n.text,
      x: annoX, y: annoY, w: 180, h: 72, laneId: '',
    });
    annoY += 100;
  }

  const idSet = new Set(canvasNodes.map((n) => n.id));
  const canvasEdges = edges
    .filter((e) => idSet.has(e.from) && idSet.has(e.to))
    .map((e, i) => {
      const fromNode = nonAnnoNodes.find((n) => n.id === e.from);
      const toNode = nonAnnoNodes.find((n) => n.id === e.to);
      const sameLane = fromNode && toNode && fromNode.laneId === toNode.laneId;
      return {
        id: `e_${i}`,
        from: e.from,
        to: e.to,
        fromPort: sameLane ? 'bottom' : 'right',
        toPort: sameLane ? 'top' : 'left',
        label: e.label,
        dashed: e.dashed,
      };
    });

  return {
    version: 1,
    title,
    laneOrientation: orientation,
    lanes: allLanes,
    nodes: canvasNodes,
    edges: canvasEdges,
  };
}

export function docToMermaid(doc, initLine = '') {
  const lines = [];
  if (initLine) lines.push(initLine);

  const colLanes = (doc.lanes || []).filter((l) => (l.axis || 'col') === 'col');
  const rowLanes = (doc.lanes || []).filter((l) => l.axis === 'row');
  const primary = colLanes.length ? colLanes : rowLanes;
  const useLR = colLanes.length > 0 || doc.laneOrientation !== 'row';
  lines.push(useLR ? 'flowchart LR' : 'flowchart TD');
  lines.push('  classDef anno fill:#fffbe6,stroke:#e6b800,stroke-dasharray:4 3,color:#5c4a00,font-size:12px');
  lines.push('');

  const esc = (t) =>
    String(t || '')
      .replace(/\n/g, '<br/>')
      .replace(/"/g, "'");

  const shapeToken = (n) => {
    const t = esc(n.text);
    if (n.kind === 'start' || n.kind === 'end') return `${n.id}([${t}])`;
    if (n.kind === 'decision') return `${n.id}{${t}}`;
    if (n.kind === 'annotation') return `${n.id}["${t}"]:::anno`;
    return `${n.id}["${t}"]`;
  };

  const nodes = doc.nodes || [];
  const byLane = new Map();
  for (const lane of primary) byLane.set(lane.id, []);
  const orphans = [];
  const annos = [];

  for (const n of nodes) {
    if (n.kind === 'annotation') {
      annos.push(n);
      continue;
    }
    const lid = colLanes.length ? n.laneId : n.rowLaneId || n.laneId;
    if (lid && byLane.has(lid)) byLane.get(lid).push(n);
    else orphans.push(n);
  }

  for (const lane of primary) {
    const list = byLane.get(lane.id) || [];
    lines.push(`  subgraph ${lane.id}["${esc(lane.label)}"]`);
    lines.push(useLR ? '    direction TB' : '    direction LR');
    for (const n of list) lines.push(`    ${shapeToken(n)}`);
    lines.push('  end');
    lines.push('');
  }

  for (const n of orphans) lines.push(`  ${shapeToken(n)}`);
  for (const n of annos) lines.push(`  ${shapeToken(n)}`);
  if (orphans.length || annos.length) lines.push('');

  if (colLanes.length && rowLanes.length) {
    lines.push('  %% 交叉横向泳道（画布矩阵，mermaid 仅保留竖向角色泳道）：');
    for (const rl of rowLanes) {
      const members = nodes.filter((n) => n.rowLaneId === rl.id).map((n) => n.id);
      lines.push(`  %% row ${rl.id}["${esc(rl.label)}"]: ${members.join(', ') || '(空)'}`);
    }
    lines.push('');
  }

  for (const e of doc.edges || []) {
    if (e.dashed) {
      if (e.label) lines.push(`  ${e.from} -. ${esc(e.label)} .-> ${e.to}`);
      else lines.push(`  ${e.from} -.-> ${e.to}`);
    } else if (e.label) {
      lines.push(`  ${e.from} -->|${esc(e.label)}| ${e.to}`);
    } else {
      lines.push(`  ${e.from} --> ${e.to}`);
    }
  }

  return lines.join('\n').trimEnd() + '\n';
}
