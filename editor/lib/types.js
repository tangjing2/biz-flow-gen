export const SHAPE_LABEL = {
  start: '开始/结束',
  process: '处理步骤',
  decision: '判定',
  annotation: '批注',
  end: '结束',
};

export const SHAPE_DEFAULT_SIZE = {
  start: { w: 120, h: 48 },
  process: { w: 160, h: 64 },
  decision: { w: 140, h: 80 },
  annotation: { w: 180, h: 72 },
  end: { w: 120, h: 48 },
};

export const DEFAULT_COL_LANE_SIZE = 260;
export const DEFAULT_ROW_LANE_SIZE = 220;
export const MIN_COL_LANE_SIZE = 120;
export const MIN_ROW_LANE_SIZE = 100;

export function normalizeBizFlowDoc(doc) {
  const orient = doc.laneOrientation || 'column';
  const defaultAxis = orient === 'row' ? 'row' : 'col';
  const lanes = (doc.lanes || []).map((l) => {
    const axis = l.axis === 'col' || l.axis === 'row' ? l.axis : defaultAxis;
    const fallback = axis === 'row' ? DEFAULT_ROW_LANE_SIZE : DEFAULT_COL_LANE_SIZE;
    const size = typeof l.size === 'number' && l.size > 0 ? l.size : fallback;
    return { ...l, axis, size };
  });
  const nodes = (doc.nodes || []).map((n) => ({
    ...n,
    rowLaneId: n.rowLaneId || '',
  }));
  return { ...doc, lanes, nodes, laneOrientation: orient };
}

export function laneSizeOf(lane) {
  const axis = lane.axis === 'row' ? 'row' : 'col';
  const fallback = axis === 'row' ? DEFAULT_ROW_LANE_SIZE : DEFAULT_COL_LANE_SIZE;
  return typeof lane.size === 'number' && lane.size > 0 ? lane.size : fallback;
}

export function emptyDoc(title) {
  return normalizeBizFlowDoc({
    version: 1,
    title: title || '业务流程图',
    laneOrientation: 'column',
    lanes: [{ id: 'lane_main', label: '主流程', axis: 'col', size: DEFAULT_COL_LANE_SIZE }],
    nodes: [],
    edges: [],
  });
}
