import { createApp, computed, nextTick, onMounted, onUnmounted, ref } from './vendor/vue.esm-browser.js';
import { mermaidToDoc, docToMermaid } from './lib/mermaid-parse.js';
import {
  DEFAULT_COL_LANE_SIZE,
  DEFAULT_ROW_LANE_SIZE,
  MIN_COL_LANE_SIZE,
  MIN_ROW_LANE_SIZE,
  SHAPE_DEFAULT_SIZE,
  SHAPE_LABEL,
  emptyDoc,
  laneSizeOf,
  normalizeBizFlowDoc,
} from './lib/types.js';

createApp({
  setup() {
    const targetDir = ref(new URLSearchParams(location.search).get('dir') || '');
    const doc = ref(null);
    const loadError = ref('');
    const saving = ref(false);
    const saveMsg = ref('');
    const dirty = ref(false);
    const selectedId = ref('');
    const selectedKind = ref('');
    const laneOrientation = ref('column');
    const canvasEl = ref(null);
    const pan = ref({ x: 0, y: 0 });
    const zoom = ref(1);
    const panning = ref(false);
    const panStart = ref({ x: 0, y: 0, px: 0, py: 0 });
    const draggingNode = ref(null);
    const dragLastPos = ref(null);
    const multiNodeIds = ref([]);
    const connecting = ref(null);
    const draggingEdgeEnd = ref(null);
    const draggingEdgeBend = ref(null);
    const pendingEdgeBend = ref(null);
    const nodeDragPushed = ref(false);
    const resizingLane = ref(null);
    const editingNode = ref('');
    const editingEdge = ref('');
    const editingLane = ref('');
    const editText = ref('');
    const undoStack = ref([]);
    const redoStack = ref([]);
    const clipboard = ref(null);
    const ports = ['top', 'right', 'bottom', 'left'];

    const LANE_HEADER_H = 32;
    const ROW_HEADER_W = 40;
    const GRID = 20;
    const COLLINEAR_GAP = 48;

    const colLanes = computed(() => (doc.value?.lanes || []).filter((l) => (l.axis || 'col') === 'col'));
    const rowLanes = computed(() => (doc.value?.lanes || []).filter((l) => l.axis === 'row'));
    const hasMatrix = computed(() => colLanes.value.length > 0 && rowLanes.value.length > 0);

    function sumLaneSizes(lanes) {
      return lanes.reduce((s, l) => s + laneSizeOf(l), 0);
    }

    function colMetrics() {
      const cols = colLanes.value;
      const rows = rowLanes.value;
      const originX = rows.length ? ROW_HEADER_W : 0;
      let x = originX;
      return cols.map((lane) => {
        const w = laneSizeOf(lane);
        const item = { id: lane.id, x, w, right: x + w };
        x += w;
        return item;
      });
    }

    function rowMetrics() {
      const cols = colLanes.value;
      const rows = rowLanes.value;
      const originY = cols.length ? LANE_HEADER_H : 0;
      let y = originY;
      return rows.map((lane) => {
        const h = laneSizeOf(lane);
        const item = { id: lane.id, y, h, bottom: y + h };
        y += h;
        return item;
      });
    }

    const shapePalette = [
      { kind: 'start', label: SHAPE_LABEL.start },
      { kind: 'process', label: SHAPE_LABEL.process },
      { kind: 'decision', label: SHAPE_LABEL.decision },
      { kind: 'annotation', label: SHAPE_LABEL.annotation },
      { kind: 'end', label: SHAPE_LABEL.end },
    ];

    const selectedNode = computed(() =>
      selectedKind.value === 'node' ? doc.value?.nodes.find((n) => n.id === selectedId.value) || null : null);
    const selectedEdge = computed(() =>
      selectedKind.value === 'edge' ? doc.value?.edges.find((e) => e.id === selectedId.value) || null : null);
    const nodeById = computed(() => {
      const m = new Map();
      doc.value?.nodes.forEach((n) => m.set(n.id, n));
      return m;
    });

    function genId(prefix) {
      return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    }
    function snapshotDoc() { return JSON.stringify(doc.value); }
    function pushHistory() {
      if (!doc.value) return;
      undoStack.value.push(snapshotDoc());
      if (undoStack.value.length > 80) undoStack.value.shift();
      redoStack.value = [];
    }
    function restoreSnapshot(raw) {
      try {
        const parsed = normalizeBizFlowDoc(JSON.parse(raw));
        doc.value = parsed;
        laneOrientation.value = parsed.laneOrientation || 'column';
        dirty.value = true;
      } catch { /* ignore */ }
    }
    function undo() {
      if (!undoStack.value.length || !doc.value) return;
      redoStack.value.push(snapshotDoc());
      restoreSnapshot(undoStack.value.pop());
      clearSelection();
    }
    function redo() {
      if (!redoStack.value.length || !doc.value) return;
      undoStack.value.push(snapshotDoc());
      restoreSnapshot(redoStack.value.pop());
      clearSelection();
    }
    function markDirty() { dirty.value = true; }

    async function loadDoc() {
      loadError.value = '';
      if (!targetDir.value) { loadError.value = '缺少 dir 参数，请用 ?dir=落盘目录'; return; }
      try {
        const res = await fetch(`/api/doc?dir=${encodeURIComponent(targetDir.value)}`);
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || '加载失败');
        if (data.source === 'json' && data.doc) {
          doc.value = normalizeBizFlowDoc(data.doc);
          laneOrientation.value = doc.value.laneOrientation || 'column';
          dirty.value = false;
        } else if (data.source === 'mermaid' && data.mermaidSrc) {
          doc.value = normalizeBizFlowDoc(mermaidToDoc(data.mermaidSrc, data.title || '业务流程图'));
          laneOrientation.value = doc.value.laneOrientation;
          dirty.value = true;
        } else {
          doc.value = emptyDoc(data.title || '业务流程图');
          laneOrientation.value = 'column';
          dirty.value = true;
        }
        undoStack.value = [];
        redoStack.value = [];
      } catch (err) {
        loadError.value = err instanceof Error ? err.message : String(err);
      }
    }

    async function saveDoc() {
      if (!doc.value || saving.value) return;
      saving.value = true; saveMsg.value = '';
      try {
        const body = normalizeBizFlowDoc({ ...doc.value, laneOrientation: laneOrientation.value });
        const mermaid = docToMermaid(body);
        const res = await fetch('/api/doc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dir: targetDir.value, doc: body, mermaid }),
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || '保存失败');
        dirty.value = false;
        saveMsg.value = data.mermaidSynced ? '已保存（含 mermaid 同步）' : '已保存';
        setTimeout(() => { if (saveMsg.value.startsWith('已保存')) saveMsg.value = ''; }, 2800);
      } catch (err) {
        saveMsg.value = `保存失败：${err instanceof Error ? err.message : String(err)}`;
      } finally { saving.value = false; }
    }

    function addShape(kind) {
      if (!doc.value) return;
      pushHistory();
      const size = SHAPE_DEFAULT_SIZE[kind];
      const cx = (pan.value.x * -1 + 400) / zoom.value;
      const cy = (pan.value.y * -1 + 300) / zoom.value;
      const id = genId('n');
      const laneId = kind === 'annotation' ? '' : (colLanes.value[0]?.id || rowLanes.value[0]?.id || '');
      const rowLaneId = kind === 'annotation' ? '' : (rowLanes.value[0]?.id || '');
      doc.value.nodes.push({
        id, kind, text: SHAPE_LABEL[kind],
        x: cx - size.w / 2, y: cy - size.h / 2, w: size.w, h: size.h,
        laneId, rowLaneId,
      });
      selectedId.value = id; selectedKind.value = 'node'; multiNodeIds.value = [id];
      markDirty();
    }

    function addLane(axis = 'col') {
      if (!doc.value) return;
      pushHistory();
      const id = genId('lane');
      const label = axis === 'col' ? '新角色列' : '新系统行';
      const size = axis === 'col' ? DEFAULT_COL_LANE_SIZE : DEFAULT_ROW_LANE_SIZE;
      doc.value.lanes.push({ id, label, axis, size });
      const hasCol = axis === 'col' || doc.value.lanes.some((l) => (l.axis || 'col') === 'col');
      laneOrientation.value = hasCol ? 'column' : 'row';
      doc.value.laneOrientation = laneOrientation.value;
      markDirty();
      nextTick(() => {
        const cols = colLanes.value;
        const rows = rowLanes.value;
        if (axis === 'col' && cols.length) {
          const metrics = colMetrics();
          const last = metrics[metrics.length - 1];
          pan.value = { x: Math.min(0, 120 - (last?.x || 0) * zoom.value), y: pan.value.y };
        } else if (axis === 'row' && rows.length) {
          const metrics = rowMetrics();
          const last = metrics[metrics.length - 1];
          pan.value = { x: pan.value.x, y: Math.min(0, 80 - (last?.y || 0) * zoom.value) };
        }
        startEditLane(id);
      });
    }
    function addColLane() { addLane('col'); }
    function addRowLane() { addLane('row'); }

    function selectLane(id) {
      selectedId.value = id;
      selectedKind.value = 'lane';
      multiNodeIds.value = [];
    }
    function startEditLane(laneId) {
      if (!doc.value) return;
      const lane = doc.value.lanes.find((l) => l.id === laneId);
      if (!lane) return;
      selectLane(laneId);
      editingLane.value = laneId;
      editText.value = lane.label;
      nextTick(() => {
        const el = canvasEl.value?.querySelector('.bf__edit-input');
        el?.focus();
        el?.select();
      });
    }
    function commitEditLane() {
      if (!doc.value || !editingLane.value) return;
      const lane = doc.value.lanes.find((l) => l.id === editingLane.value);
      if (lane && lane.label !== editText.value.trim()) {
        pushHistory();
        lane.label = editText.value.trim() || lane.label;
        markDirty();
      }
      editingLane.value = '';
    }
    function selectNode(id) { selectedId.value = id; selectedKind.value = 'node'; }
    function selectEdge(id) { selectedId.value = id; selectedKind.value = 'edge'; multiNodeIds.value = []; }
    function clearSelection() {
      selectedId.value = '';
      selectedKind.value = '';
      editingNode.value = '';
      editingEdge.value = '';
      editingLane.value = '';
      multiNodeIds.value = [];
    }
    function selectedNodeIds() {
      if (selectedKind.value !== 'node') return [];
      if (multiNodeIds.value.length) return [...multiNodeIds.value];
      return selectedId.value ? [selectedId.value] : [];
    }
    function deleteSelected() {
      if (!doc.value) return;
      const ids = selectedKind.value === 'node' ? selectedNodeIds() : [];
      if (ids.length) {
        pushHistory();
        const set = new Set(ids);
        doc.value.nodes = doc.value.nodes.filter((n) => !set.has(n.id));
        doc.value.edges = doc.value.edges.filter((e) => !set.has(e.from) && !set.has(e.to));
        markDirty(); clearSelection();
      } else if (selectedKind.value === 'edge' && selectedId.value) {
        pushHistory();
        doc.value.edges = doc.value.edges.filter((e) => e.id !== selectedId.value);
        markDirty(); clearSelection();
      } else if (selectedKind.value === 'lane' && selectedId.value) {
        pushHistory();
        const lid = selectedId.value;
        doc.value.lanes = doc.value.lanes.filter((l) => l.id !== lid);
        for (const n of doc.value.nodes) {
          if (n.laneId === lid) n.laneId = '';
          if (n.rowLaneId === lid) n.rowLaneId = '';
        }
        markDirty(); clearSelection();
      }
    }
    function nudgeSelected(dx, dy) {
      if (!doc.value || selectedKind.value !== 'node') return;
      const ids = selectedNodeIds();
      if (!ids.length) return;
      pushHistory();
      for (const id of ids) {
        const n = doc.value.nodes.find((x) => x.id === id);
        if (n) { n.x += dx; n.y += dy; }
      }
      markDirty();
    }
    function copySelected() {
      if (!doc.value || selectedKind.value !== 'node') return;
      const ids = new Set(selectedNodeIds());
      if (!ids.size) return;
      clipboard.value = {
        nodes: doc.value.nodes.filter((n) => ids.has(n.id)).map((n) => ({ ...n })),
        edges: doc.value.edges.filter((e) => ids.has(e.from) && ids.has(e.to)).map((e) => ({ ...e })),
      };
    }
    function cutSelected() {
      copySelected();
      if (clipboard.value?.nodes.length) deleteSelected();
    }
    function pasteClipboard() {
      if (!doc.value || !clipboard.value?.nodes.length) return;
      pushHistory();
      const idMap = new Map();
      const offset = GRID * 2;
      const newIds = [];
      for (const n of clipboard.value.nodes) {
        const nid = genId('n');
        idMap.set(n.id, nid);
        newIds.push(nid);
        doc.value.nodes.push({ ...n, id: nid, x: n.x + offset, y: n.y + offset });
      }
      for (const e of clipboard.value.edges) {
        const from = idMap.get(e.from);
        const to = idMap.get(e.to);
        if (!from || !to) continue;
        doc.value.edges.push({ ...e, id: genId('e'), from, to });
      }
      multiNodeIds.value = newIds;
      selectedId.value = newIds[0] || '';
      selectedKind.value = 'node';
      markDirty();
    }
    function isTypingTarget(el) {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
    }
    function onKeyDown(e) {
      if (editingNode.value || editingEdge.value || editingLane.value) {
        if (e.key === 'Escape') {
          editingNode.value = '';
          editingEdge.value = '';
          editingLane.value = '';
        }
        return;
      }
      if (isTypingTarget(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
      if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }
      if (mod && e.key.toLowerCase() === 'c') { e.preventDefault(); copySelected(); return; }
      if (mod && e.key.toLowerCase() === 'x') { e.preventDefault(); cutSelected(); return; }
      if (mod && e.key.toLowerCase() === 'v') { e.preventDefault(); pasteClipboard(); return; }
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveDoc(); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedId.value || multiNodeIds.value.length) { e.preventDefault(); deleteSelected(); }
        return;
      }
      if (e.key === 'ArrowLeft') { e.preventDefault(); nudgeSelected(-GRID, 0); return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); nudgeSelected(GRID, 0); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); nudgeSelected(0, -GRID); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); nudgeSelected(0, GRID); }
    }
    function toCanvasCoords(clientX, clientY) {
      const svg = canvasEl.value; if (!svg) return { x: 0, y: 0 };
      const rect = svg.getBoundingClientRect();
      return { x: (clientX - rect.left - pan.value.x) / zoom.value, y: (clientY - rect.top - pan.value.y) / zoom.value };
    }
    function onCanvasMouseDown(e) {
      if (e.target === canvasEl.value || e.target?.classList?.contains('bf-bg')) {
        panning.value = true;
        panStart.value = { x: e.clientX, y: e.clientY, px: pan.value.x, py: pan.value.y };
        if (!e.shiftKey) clearSelection();
      }
    }
    function onMouseMove(e) {
      if (panning.value) {
        pan.value = { x: panStart.value.px + (e.clientX - panStart.value.x), y: panStart.value.py + (e.clientY - panStart.value.y) };
        return;
      }
      if (draggingNode.value && doc.value) {
        const pt = toCanvasCoords(e.clientX, e.clientY);
        if (!nodeDragPushed.value) { pushHistory(); nodeDragPushed.value = true; }
        if (multiNodeIds.value.length > 1 && dragLastPos.value) {
          const dx = pt.x - dragLastPos.value.x;
          const dy = pt.y - dragLastPos.value.y;
          for (const id of multiNodeIds.value) {
            const n = doc.value.nodes.find((x) => x.id === id);
            if (n) { n.x += dx; n.y += dy; }
          }
        } else {
          const n = doc.value.nodes.find((x) => x.id === draggingNode.value.id);
          if (n) { n.x = pt.x - draggingNode.value.offsetX; n.y = pt.y - draggingNode.value.offsetY; }
        }
        dragLastPos.value = pt;
        markDirty();
        return;
      }
      if (pendingEdgeBend.value && !draggingEdgeBend.value) {
        const dx = e.clientX - pendingEdgeBend.value.sx;
        const dy = e.clientY - pendingEdgeBend.value.sy;
        if (Math.hypot(dx, dy) >= 4) {
          pushHistory();
          draggingEdgeBend.value = { edgeId: pendingEdgeBend.value.edgeId, axis: pendingEdgeBend.value.axis };
          pendingEdgeBend.value = null;
        } else return;
      }
      if (connecting.value) {
        const pt = toCanvasCoords(e.clientX, e.clientY);
        connecting.value.x = pt.x; connecting.value.y = pt.y;
        return;
      }
      if (draggingEdgeEnd.value) {
        const pt = toCanvasCoords(e.clientX, e.clientY);
        draggingEdgeEnd.value.x = pt.x; draggingEdgeEnd.value.y = pt.y;
        return;
      }
      if (draggingEdgeBend.value && doc.value) {
        const pt = toCanvasCoords(e.clientX, e.clientY);
        const edge = doc.value.edges.find((x) => x.id === draggingEdgeBend.value.edgeId);
        if (edge) { edge.bend = draggingEdgeBend.value.axis === 'x' ? pt.x : pt.y; markDirty(); }
        return;
      }
      if (resizingLane.value && doc.value) {
        const rs = resizingLane.value;
        const lane = doc.value.lanes.find((l) => l.id === rs.laneId);
        if (!lane) return;
        const client = rs.axis === 'col' ? e.clientX : e.clientY;
        const delta = (client - rs.startClient) / zoom.value;
        const min = rs.axis === 'col' ? MIN_COL_LANE_SIZE : MIN_ROW_LANE_SIZE;
        const next = Math.max(min, rs.startSize + delta);
        const applied = next - laneSizeOf(lane);
        if (Math.abs(applied) < 0.5) return;
        if (!rs.historyPushed) { pushHistory(); rs.historyPushed = true; }
        lane.size = next;
        if (rs.axis === 'col') {
          for (const n of doc.value.nodes) {
            if (n.x + n.w / 2 >= rs.boundary - 0.5) n.x += applied;
          }
          rs.boundary += applied;
        } else {
          for (const n of doc.value.nodes) {
            if (n.y + n.h / 2 >= rs.boundary - 0.5) n.y += applied;
          }
          rs.boundary += applied;
        }
        rs.startSize = next;
        rs.startClient = client;
        markDirty();
      }
    }
    function onMouseUp(e) {
      if (panning.value) { panning.value = false; return; }
      if (draggingNode.value) {
        assignLanesByPosition();
        draggingNode.value = null;
        nodeDragPushed.value = false;
        return;
      }
      if (pendingEdgeBend.value) pendingEdgeBend.value = null;
      if (connecting.value) {
        const target = e.target?.closest?.('[data-node-id]');
        const targetId = target?.getAttribute('data-node-id') || '';
        const targetPort = e.target?.getAttribute?.('data-port');
        if (targetId && targetId !== connecting.value.fromId && doc.value) {
          pushHistory();
          const fromNode = nodeById.value.get(connecting.value.fromId);
          const toNode = nodeById.value.get(targetId);
          const isAnno = fromNode?.kind === 'annotation' || toNode?.kind === 'annotation';
          doc.value.edges.push({
            id: genId('e'),
            from: connecting.value.fromId,
            to: targetId,
            fromPort: connecting.value.fromPort,
            toPort: targetPort || 'left',
            label: '',
            dashed: isAnno,
            bend: null,
          });
          markDirty();
        }
        connecting.value = null;
      }
      if (draggingEdgeEnd.value && doc.value) {
        const target = e.target?.closest?.('[data-node-id]');
        const targetId = target?.getAttribute('data-node-id') || '';
        if (targetId) {
          const edge = doc.value.edges.find((x) => x.id === draggingEdgeEnd.value.edgeId);
          if (edge) {
            pushHistory();
            if (draggingEdgeEnd.value.end === 'from') edge.from = targetId;
            else edge.to = targetId;
            edge.bend = null;
            markDirty();
          }
        }
        draggingEdgeEnd.value = null;
      }
      if (draggingEdgeBend.value) draggingEdgeBend.value = null;
      if (resizingLane.value) resizingLane.value = null;
    }
    function assignLanesByPosition() {
      if (!doc.value) return;
      const cols = colMetrics();
      const rows = rowMetrics();
      for (const n of doc.value.nodes) {
        if (n.kind === 'annotation') continue;
        const cx = n.x + n.w / 2;
        const cy = n.y + n.h / 2;
        if (cols.length) {
          const hit = cols.find((c) => cx >= c.x && cx < c.right) || cols[cols.length - 1];
          if (hit) n.laneId = hit.id;
        }
        if (rows.length) {
          const hit = rows.find((r) => cy >= r.y && cy < r.bottom) || rows[rows.length - 1];
          if (hit) n.rowLaneId = hit.id;
        }
      }
    }
    function onLaneResizeMouseDown(e, laneId, axis, boundary) {
      e.stopPropagation();
      if (!doc.value) return;
      const lane = doc.value.lanes.find((l) => l.id === laneId);
      if (!lane) return;
      selectLane(laneId);
      resizingLane.value = {
        laneId, axis, startSize: laneSizeOf(lane),
        startClient: axis === 'col' ? e.clientX : e.clientY,
        boundary, historyPushed: false,
      };
    }
    function onNodeMouseDown(e, node) {
      e.stopPropagation();
      if (e.shiftKey) {
        const idx = multiNodeIds.value.indexOf(node.id);
        if (idx >= 0) multiNodeIds.value.splice(idx, 1);
        else multiNodeIds.value.push(node.id);
        selectedId.value = node.id; selectedKind.value = 'node';
      } else {
        if (!multiNodeIds.value.includes(node.id)) multiNodeIds.value = [node.id];
        selectNode(node.id);
      }
      if (editingNode.value === node.id) return;
      nodeDragPushed.value = false;
      const pt = toCanvasCoords(e.clientX, e.clientY);
      dragLastPos.value = pt;
      draggingNode.value = { id: node.id, offsetX: pt.x - node.x, offsetY: pt.y - node.y };
    }
    function onPortMouseDown(e, node, port) {
      e.stopPropagation();
      const pt = toCanvasCoords(e.clientX, e.clientY);
      connecting.value = { fromId: node.id, fromPort: port, x: pt.x, y: pt.y };
    }
    function onEdgeEndMouseDown(e, edge, end) {
      e.stopPropagation();
      selectEdge(edge.id);
      pushHistory();
      const pt = toCanvasCoords(e.clientX, e.clientY);
      draggingEdgeEnd.value = { edgeId: edge.id, end, x: pt.x, y: pt.y };
    }
    function edgeBendAxis(edge) {
      const fromH = edge.fromPort === 'left' || edge.fromPort === 'right';
      const toH = edge.toPort === 'left' || edge.toPort === 'right';
      if (fromH && toH) return 'x';
      if (!fromH && !toH) return 'y';
      return fromH ? 'x' : 'y';
    }
    function onEdgeBendMouseDown(e, edge) {
      e.stopPropagation();
      selectEdge(edge.id);
      pendingEdgeBend.value = { edgeId: edge.id, axis: edgeBendAxis(edge), sx: e.clientX, sy: e.clientY };
    }
    function onEdgeHitMouseDown(e, edge) {
      e.stopPropagation();
      selectEdge(edge.id);
      pendingEdgeBend.value = { edgeId: edge.id, axis: edgeBendAxis(edge), sx: e.clientX, sy: e.clientY };
    }
    function onWheel(e) {
      e.preventDefault();
      if (e.ctrlKey) {
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        const newZoom = Math.min(2.5, Math.max(0.3, zoom.value * delta));
        const svg = canvasEl.value; if (!svg) return;
        const rect = svg.getBoundingClientRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        pan.value = { x: mx - ((mx - pan.value.x) / zoom.value) * newZoom, y: my - ((my - pan.value.y) / zoom.value) * newZoom };
        zoom.value = newZoom;
      } else {
        pan.value = { x: pan.value.x - e.deltaX, y: pan.value.y - e.deltaY };
      }
    }
    function startEditNode(node) {
      editingNode.value = node.id;
      editText.value = node.text;
      nextTick(() => {
        const el = canvasEl.value?.querySelector('.bf__edit-input');
        el?.focus(); el?.select();
      });
    }
    function commitEditNode() {
      if (!doc.value || !editingNode.value) return;
      const n = doc.value.nodes.find((x) => x.id === editingNode.value);
      if (n && n.text !== editText.value) { pushHistory(); n.text = editText.value; markDirty(); }
      editingNode.value = '';
    }
    function startEditEdge(edge) {
      pendingEdgeBend.value = null;
      draggingEdgeBend.value = null;
      selectEdge(edge.id);
      editingEdge.value = edge.id;
      editText.value = edge.label || '';
      nextTick(() => {
        const el = canvasEl.value?.querySelector('.bf__edit-input');
        el?.focus(); el?.select();
      });
    }
    function commitEditEdge() {
      if (!doc.value || !editingEdge.value) return;
      const eg = doc.value.edges.find((x) => x.id === editingEdge.value);
      if (eg && eg.label !== editText.value) { pushHistory(); eg.label = editText.value; markDirty(); }
      editingEdge.value = '';
    }
    function zoomIn() { zoom.value = Math.min(2.5, zoom.value * 1.2); }
    function zoomOut() { zoom.value = Math.max(0.3, zoom.value / 1.2); }
    function resetView() { pan.value = { x: 0, y: 0 }; zoom.value = 1; }

    const addColBtnPos = computed(() => ({
      x: (rowLanes.value.length ? ROW_HEADER_W : 0) + sumLaneSizes(colLanes.value) + 8,
      y: 4,
    }));
    const addRowBtnPos = computed(() => ({
      x: 4,
      y: (colLanes.value.length ? LANE_HEADER_H : 0) + sumLaneSizes(rowLanes.value) + 8,
    }));

    function portPos(node, port) {
      switch (port) {
        case 'top': return { x: node.x + node.w / 2, y: node.y };
        case 'right': return { x: node.x + node.w, y: node.y + node.h / 2 };
        case 'bottom': return { x: node.x + node.w / 2, y: node.y + node.h };
        case 'left': return { x: node.x, y: node.y + node.h / 2 };
      }
    }
    function resolveBend(p1, p2, fromPort, toPort, bend) {
      const fromH = fromPort === 'left' || fromPort === 'right';
      const toH = toPort === 'left' || toPort === 'right';
      if (fromH && toH) {
        let midX = bend ?? (p1.x + p2.x) / 2;
        if (bend == null && Math.abs(p2.x - p1.x) < 16) midX = Math.max(p1.x, p2.x) + COLLINEAR_GAP;
        return { midX, midY: (p1.y + p2.y) / 2, mode: 'hh' };
      }
      if (!fromH && !toH) {
        let midY = bend ?? (p1.y + p2.y) / 2;
        if (bend == null && Math.abs(p2.y - p1.y) < 16) midY = Math.max(p1.y, p2.y) + COLLINEAR_GAP;
        return { midX: (p1.x + p2.x) / 2, midY, mode: 'vv' };
      }
      if (fromH && !toH) return { midX: bend ?? p2.x, midY: p1.y, mode: 'hv' };
      return { midX: p1.x, midY: bend ?? p2.y, mode: 'vh' };
    }
    function edgePath(edge) {
      const from = nodeById.value.get(edge.from), to = nodeById.value.get(edge.to);
      if (!from || !to) return '';
      const p1 = portPos(from, edge.fromPort), p2 = portPos(to, edge.toPort);
      const { midX, midY, mode } = resolveBend(p1, p2, edge.fromPort, edge.toPort, edge.bend);
      if (mode === 'hh') return `M ${p1.x} ${p1.y} L ${midX} ${p1.y} L ${midX} ${p2.y} L ${p2.x} ${p2.y}`;
      if (mode === 'vv') return `M ${p1.x} ${p1.y} L ${p1.x} ${midY} L ${p2.x} ${midY} L ${p2.x} ${p2.y}`;
      if (mode === 'hv') return `M ${p1.x} ${p1.y} L ${midX} ${p1.y} L ${midX} ${p2.y} L ${p2.x} ${p2.y}`;
      return `M ${p1.x} ${p1.y} L ${p1.x} ${midY} L ${p2.x} ${midY} L ${p2.x} ${p2.y}`;
    }
    function edgeLabelPos(edge) {
      const from = nodeById.value.get(edge.from), to = nodeById.value.get(edge.to);
      if (!from || !to) return { x: 0, y: 0 };
      const p1 = portPos(from, edge.fromPort), p2 = portPos(to, edge.toPort);
      const { midX, midY, mode } = resolveBend(p1, p2, edge.fromPort, edge.toPort, edge.bend);
      if (mode === 'hh') return { x: midX, y: (p1.y + p2.y) / 2 };
      if (mode === 'vv') return { x: (p1.x + p2.x) / 2, y: midY };
      if (mode === 'hv') return { x: midX, y: (p1.y + p2.y) / 2 };
      return { x: (p1.x + p2.x) / 2, y: midY };
    }
    function edgeBendHandlePos(edge) { return edgeLabelPos(edge); }

    const canvasSize = computed(() => {
      if (!doc.value) return { w: 1200, h: 800 };
      const cols = colLanes.value;
      const rows = rowLanes.value;
      const originX = rows.length ? ROW_HEADER_W : 0;
      const originY = cols.length ? LANE_HEADER_H : (rows.length ? LANE_HEADER_H : 0);
      const colW = sumLaneSizes(cols);
      const rowH = sumLaneSizes(rows);
      let gridW = 1200;
      let gridH = 800;
      if (cols.length && rows.length) { gridW = originX + colW; gridH = originY + rowH; }
      else if (cols.length) { gridW = originX + colW; gridH = Math.max(800, ...doc.value.nodes.map((n) => n.y + n.h + 100)); }
      else if (rows.length) { gridW = Math.max(1200, ...doc.value.nodes.map((n) => n.x + n.w + 100)); gridH = originY + rowH; }
      return {
        w: Math.max(gridW, ...doc.value.nodes.map((n) => n.x + n.w + 100)),
        h: Math.max(gridH, ...doc.value.nodes.map((n) => n.y + n.h + 100)),
      };
    });

    const laneLayout = computed(() => {
      if (!doc.value) return [];
      const cols = colLanes.value;
      const rows = rowLanes.value;
      const items = [];
      const originX = rows.length ? ROW_HEADER_W : 0;
      const originY = cols.length ? LANE_HEADER_H : 0;
      const totalH = canvasSize.value.h;
      const totalW = canvasSize.value.w;
      if (cols.length && rows.length) {
        let x = originX;
        for (const lane of cols) {
          const w = laneSizeOf(lane);
          items.push({ id: lane.id, label: lane.label, x, y: 0, w, h: totalH, headerX: x, headerY: 0, headerW: w, headerH: LANE_HEADER_H, isRow: false, resizeAt: x + w });
          x += w;
        }
        let y = originY;
        for (const lane of rows) {
          const h = laneSizeOf(lane);
          items.push({ id: lane.id, label: lane.label, x: 0, y, w: totalW, h, headerX: 0, headerY: y, headerW: ROW_HEADER_W, headerH: h, isRow: true, resizeAt: y + h });
          y += h;
        }
        return items;
      }
      if (rows.length) {
        let y = 0;
        for (const lane of rows) {
          const h = laneSizeOf(lane);
          items.push({ id: lane.id, label: lane.label, x: 0, y, w: totalW, h, headerX: 0, headerY: y, headerW: ROW_HEADER_W, headerH: h, isRow: true, resizeAt: y + h });
          y += h;
        }
        return items;
      }
      let x = 0;
      for (const lane of cols) {
        const w = laneSizeOf(lane);
        items.push({ id: lane.id, label: lane.label, x, y: 0, w, h: totalH, headerX: x, headerY: 0, headerW: w, headerH: LANE_HEADER_H, isRow: false, resizeAt: x + w });
        x += w;
      }
      return items;
    });
    const laneResizeGuides = computed(() =>
      laneLayout.value.map((ll) => ({
        id: ll.id, isRow: ll.isRow,
        x1: ll.isRow ? 0 : ll.resizeAt, y1: ll.isRow ? ll.resizeAt : 0,
        x2: ll.isRow ? canvasSize.value.w : ll.resizeAt, y2: ll.isRow ? ll.resizeAt : canvasSize.value.h,
      })),
    );
    function diamondPoints(node) {
      const cx = node.x + node.w / 2, cy = node.y + node.h / 2;
      return `${cx},${node.y} ${node.x + node.w},${cy} ${cx},${node.y + node.h} ${node.x},${cy}`;
    }
    const transformStr = computed(() => `translate(${pan.value.x},${pan.value.y}) scale(${zoom.value})`);
    const connectPreview = computed(() => {
      if (!connecting.value) return null;
      const n = nodeById.value.get(connecting.value.fromId);
      if (!n) return null;
      const p = portPos(n, connecting.value.fromPort);
      return { x1: p.x, y1: p.y, x2: connecting.value.x, y2: connecting.value.y };
    });
    const edgeEndPreview = computed(() => {
      if (!draggingEdgeEnd.value || !doc.value) return null;
      const edge = doc.value.edges.find((e) => e.id === draggingEdgeEnd.value.edgeId);
      if (!edge) return null;
      const fromN = nodeById.value.get(edge.from);
      const toN = nodeById.value.get(edge.to);
      if (!fromN || !toN) return null;
      const fromP = portPos(fromN, edge.fromPort);
      const toP = portPos(toN, edge.toPort);
      if (draggingEdgeEnd.value.end === 'from') {
        return { x1: draggingEdgeEnd.value.x, y1: draggingEdgeEnd.value.y, x2: toP.x, y2: toP.y };
      }
      return { x1: fromP.x, y1: fromP.y, x2: draggingEdgeEnd.value.x, y2: draggingEdgeEnd.value.y };
    });
    const normalNodes = computed(() => (doc.value?.nodes || []).filter((n) => n.kind !== 'annotation'));
    const annoNodes = computed(() => (doc.value?.nodes || []).filter((n) => n.kind === 'annotation'));
    const zoomPct = computed(() => Math.round(zoom.value * 100));
    function nodeByIdSafe(id) {
      return nodeById.value.get(id) || { x: 0, y: 0, w: 0, h: 0 };
    }

    onMounted(() => {
      loadDoc();
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    });
    onUnmounted(() => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    });

    return {
      targetDir, doc, loadError, saving, saveMsg, dirty, selectedId, selectedKind,
      canvasEl, zoom, editingNode, editingEdge, editingLane, editText,
      multiNodeIds, connecting, draggingEdgeEnd, resizingLane,
      shapePalette, selectedEdge, hasMatrix, ports,
      addShape, addColLane, addRowLane, saveDoc, zoomIn, zoomOut, resetView,
      onCanvasMouseDown, onWheel, selectLane, startEditLane, commitEditLane,
      selectEdge, startEditEdge, commitEditEdge, startEditNode, commitEditNode,
      onLaneResizeMouseDown, onNodeMouseDown, onPortMouseDown,
      onEdgeHitMouseDown, onEdgeEndMouseDown, onEdgeBendMouseDown,
      edgePath, edgeLabelPos, edgeBendHandlePos, portPos, diamondPoints,
      addColBtnPos, addRowBtnPos, laneLayout, laneResizeGuides, canvasSize,
      transformStr, connectPreview, edgeEndPreview, normalNodes, annoNodes, zoomPct,
      nodeByIdSafe, ROW_HEADER_W, LANE_HEADER_H,
    };
  },
  template: `
  <div class="bf">
    <aside class="bf__side">
      <div class="bf__side-title">图形库</div>
      <div class="bf__shapes">
        <button v-for="s in shapePalette" :key="s.kind" class="bf__shape-btn" @click="addShape(s.kind)">
          <svg class="bf__shape-icon" viewBox="0 0 60 36">
            <rect v-if="s.kind === 'process'" x="6" y="8" width="48" height="20" rx="3" fill="#e8f0fe" stroke="#555" stroke-width="1.5" />
            <rect v-else-if="s.kind === 'start' || s.kind === 'end'" x="6" y="10" width="48" height="16" rx="8" fill="#fef9e7" stroke="#555" stroke-width="1.5" />
            <polygon v-else-if="s.kind === 'decision'" points="30,4 56,18 30,32 4,18" fill="#e8f5e9" stroke="#555" stroke-width="1.5" />
            <rect v-else-if="s.kind === 'annotation'" x="6" y="8" width="48" height="20" rx="2" fill="#fffbe6" stroke="#e6b800" stroke-width="1.5" stroke-dasharray="4 3" />
          </svg>
          <span>{{ s.label }}</span>
        </button>
        <div class="bf__shape-divider"></div>
        <button class="bf__shape-btn" @click="addColLane" title="在右侧新增一列竖向泳道（角色）">
          <svg class="bf__shape-icon" viewBox="0 0 60 36">
            <rect x="4" y="2" width="52" height="32" rx="3" fill="#f0f4ff" stroke="#a5b4fc" stroke-width="1.5" />
            <line x1="22" y1="2" x2="22" y2="34" stroke="#a5b4fc" stroke-width="1.5" />
            <line x1="40" y1="2" x2="40" y2="34" stroke="#a5b4fc" stroke-width="1.5" />
            <rect x="4" y="2" width="52" height="6" fill="#c7d2fe" rx="3" />
          </svg>
          <span>+ 新增竖列</span>
        </button>
        <button class="bf__shape-btn" @click="addRowLane" title="在下方新增一行横向泳道（系统）">
          <svg class="bf__shape-icon" viewBox="0 0 60 36">
            <rect x="4" y="2" width="52" height="32" rx="3" fill="#f0f4ff" stroke="#a5b4fc" stroke-width="1.5" />
            <line x1="4" y1="13" x2="56" y2="13" stroke="#a5b4fc" stroke-width="1.5" />
            <line x1="4" y1="24" x2="56" y2="24" stroke="#a5b4fc" stroke-width="1.5" />
            <rect x="4" y="2" width="10" height="32" fill="#c7d2fe" rx="3" />
          </svg>
          <span>+ 新增横行</span>
        </button>
      </div>
      <div class="bf__side-hint">
        左侧、顶栏或画布「+」均可新增泳道列/行。<br/>
        竖列≈角色、横行≈系统；可只做一维。<br/>
        双击泳道标题改名；Delete 删选中泳道。<br/>
        「复位视图」只重置平移/缩放，不改图。<br/>
        拖泳道分割线可调列宽/行高。<br/>
        Ctrl+S 保存（同步 mermaid 供开发阅读）。
      </div>
    </aside>
    <div class="bf__main">
      <header class="bf__bar">
        <div class="bf__bar-left">
          <strong>{{ doc?.title || '业务流程图' }}</strong>
          <code v-if="targetDir" :title="targetDir">{{ targetDir }}</code>
          <span v-if="dirty" class="bf__dirty">未保存</span>
        </div>
        <div class="bf__bar-right">
          <span v-if="saveMsg" class="bf__msg">{{ saveMsg }}</span>
          <span v-if="hasMatrix" class="bf__matrix-tag">交叉泳道</span>
          <button class="bf__btn" title="在右侧新增一列竖向泳道" @click="addColLane">+ 竖列</button>
          <button class="bf__btn" title="在下方新增一行横向泳道" @click="addRowLane">+ 横行</button>
          <button class="bf__btn" @click="zoomOut">−</button>
          <span class="bf__zoom">{{ zoomPct }}%</span>
          <button class="bf__btn" @click="zoomIn">+</button>
          <button class="bf__btn" title="仅重置画布平移与缩放，不改变节点/连线/泳道" @click="resetView">复位视图</button>
          <button class="bf__btn bf__btn--primary" :disabled="saving || !dirty" @click="saveDoc">
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </div>
      </header>
      <div v-if="loadError" class="bf__error">{{ loadError }}</div>
      <svg v-else ref="canvasEl" class="bf__canvas" @mousedown="onCanvasMouseDown" @wheel="onWheel">
        <rect class="bf-bg" :width="canvasSize.w" :height="canvasSize.h" fill="none" pointer-events="none" />
        <g :transform="transformStr">
          <g class="bf__lanes">
            <rect v-if="hasMatrix" x="0" y="0" :width="ROW_HEADER_W" :height="LANE_HEADER_H" fill="#c7d2fe" stroke="#a5b4fc" />
            <g v-for="ll in laneLayout" :key="ll.id" class="bf__lane">
              <rect :x="ll.x" :y="ll.y" :width="ll.w" :height="ll.h"
                :fill="ll.isRow ? 'rgba(248,249,251,0.35)' : 'rgba(248,249,251,0.55)'"
                stroke="#d0d5dd" stroke-width="1" pointer-events="none" />
              <g class="bf__lane-head" :class="{ 'bf__lane-head--sel': selectedKind === 'lane' && selectedId === ll.id }"
                @click.stop="selectLane(ll.id)" @dblclick.stop="startEditLane(ll.id)">
                <rect :x="ll.headerX" :y="ll.headerY" :width="ll.headerW" :height="ll.headerH"
                  :fill="selectedKind === 'lane' && selectedId === ll.id ? '#bfdbfe' : '#e0e7ff'" stroke="#a5b4fc" />
                <text v-if="editingLane !== ll.id && !ll.isRow" :x="ll.headerX + ll.headerW / 2" :y="ll.headerY + 21"
                  text-anchor="middle" class="bf__lane-label">{{ ll.label }}</text>
                <text v-else-if="editingLane !== ll.id && ll.isRow" :x="ll.headerX + ll.headerW / 2"
                  :y="ll.headerY + ll.headerH / 2" text-anchor="middle" class="bf__lane-label"
                  :transform="'rotate(-90, ' + (ll.headerX + ll.headerW / 2) + ', ' + (ll.headerY + ll.headerH / 2) + ')'">{{ ll.label }}</text>
                <foreignObject v-if="editingLane === ll.id"
                  :x="ll.isRow ? ll.headerX : ll.headerX + 4"
                  :y="ll.isRow ? ll.headerY + ll.headerH / 2 - 12 : ll.headerY + 4"
                  :width="ll.isRow ? ll.headerW : ll.headerW - 8" :height="24">
                  <input v-model="editText" class="bf__edit-input" @blur="commitEditLane"
                    @keydown.enter.prevent="commitEditLane" @keydown.escape.prevent="editingLane = ''" @mousedown.stop />
                </foreignObject>
              </g>
            </g>
            <g v-for="g in laneResizeGuides" :key="'rz-' + g.id" class="bf__lane-resize"
              :class="{ 'bf__lane-resize--row': g.isRow, 'is-active': resizingLane && resizingLane.laneId === g.id }"
              @mousedown.stop="onLaneResizeMouseDown($event, g.id, g.isRow ? 'row' : 'col', g.isRow ? g.y1 : g.x1)">
              <line :x1="g.x1" :y1="g.y1" :x2="g.x2" :y2="g.y2" stroke="transparent" stroke-width="10" />
              <line :x1="g.x1" :y1="g.y1" :x2="g.x2" :y2="g.y2" class="bf__lane-resize-line"
                :stroke="(resizingLane && resizingLane.laneId === g.id) || (selectedKind === 'lane' && selectedId === g.id) ? '#2563eb' : '#94a3b8'"
                stroke-width="2" pointer-events="none" />
            </g>
            <g class="bf__lane-add" @click.stop="addColLane" @mousedown.stop>
              <rect :x="addColBtnPos.x" :y="addColBtnPos.y" width="28" height="24" rx="4" fill="#eef2ff" stroke="#6366f1" stroke-width="1.5" />
              <text :x="addColBtnPos.x + 14" :y="addColBtnPos.y + 16" text-anchor="middle" class="bf__lane-add-text">+</text>
            </g>
            <g class="bf__lane-add" @click.stop="addRowLane" @mousedown.stop>
              <rect :x="addRowBtnPos.x" :y="addRowBtnPos.y" width="28" height="24" rx="4" fill="#eef2ff" stroke="#6366f1" stroke-width="1.5" />
              <text :x="addRowBtnPos.x + 14" :y="addRowBtnPos.y + 16" text-anchor="middle" class="bf__lane-add-text">+</text>
            </g>
          </g>
          <g v-for="edge in (doc && doc.edges) || []" :key="edge.id" class="bf__edge"
            @click.stop="selectEdge(edge.id)" @dblclick.stop="startEditEdge(edge)">
            <path :d="edgePath(edge)" stroke="transparent" stroke-width="16" fill="none" pointer-events="stroke"
              @mousedown.stop="onEdgeHitMouseDown($event, edge)" />
            <path :d="edgePath(edge)"
              :stroke="selectedKind === 'edge' && selectedId === edge.id ? '#2563eb' : (edge.dashed ? '#e6b800' : '#666')"
              :stroke-width="selectedKind === 'edge' && selectedId === edge.id ? 2.5 : 1.8"
              :stroke-dasharray="edge.dashed ? '6 4' : 'none'" fill="none" pointer-events="none"
              :marker-end="edge.dashed ? 'url(#bf-arrow-dashed)' : 'url(#bf-arrow)'" />
            <rect v-if="edge.label && editingEdge !== edge.id"
              :x="edgeLabelPos(edge).x - Math.max(24, edge.label.length * 7) - 4"
              :y="edgeLabelPos(edge).y - 10"
              :width="Math.max(48, edge.label.length * 14 + 8)" :height="20" rx="3" fill="#fff" stroke="#ddd" pointer-events="none" />
            <text v-if="edge.label && editingEdge !== edge.id" :x="edgeLabelPos(edge).x" :y="edgeLabelPos(edge).y + 4"
              text-anchor="middle" class="bf__edge-label" pointer-events="none">{{ edge.label }}</text>
            <foreignObject v-if="editingEdge === edge.id" :x="edgeLabelPos(edge).x - 80" :y="edgeLabelPos(edge).y - 12" width="160" height="28">
              <input v-model="editText" class="bf__edit-input" placeholder="连线文字" @blur="commitEditEdge"
                @keydown.enter.prevent="commitEditEdge" @keydown.escape.prevent="editingEdge = ''" @mousedown.stop />
            </foreignObject>
          </g>
          <line v-if="connectPreview" :x1="connectPreview.x1" :y1="connectPreview.y1" :x2="connectPreview.x2" :y2="connectPreview.y2"
            stroke="#2563eb" stroke-width="2" stroke-dasharray="5 3" />
          <line v-if="edgeEndPreview" :x1="edgeEndPreview.x1" :y1="edgeEndPreview.y1" :x2="edgeEndPreview.x2" :y2="edgeEndPreview.y2"
            stroke="#2563eb" stroke-width="2" stroke-dasharray="5 3" />
          <g v-for="node in normalNodes" :key="node.id" :data-node-id="node.id" class="bf__node"
            :class="{ 'bf__node--sel': selectedKind === 'node' && multiNodeIds.includes(node.id) }"
            @mousedown="onNodeMouseDown($event, node)" @dblclick.stop="startEditNode(node)">
            <rect v-if="node.kind === 'process'" :x="node.x" :y="node.y" :width="node.w" :height="node.h" rx="6" fill="#e8f0fe"
              :stroke="selectedKind === 'node' && multiNodeIds.includes(node.id) ? '#2563eb' : '#555'"
              :stroke-width="selectedKind === 'node' && multiNodeIds.includes(node.id) ? 2.5 : 1.5" />
            <rect v-else-if="node.kind === 'start' || node.kind === 'end'" :x="node.x" :y="node.y" :width="node.w" :height="node.h"
              :rx="node.h / 2" fill="#fef9e7"
              :stroke="selectedKind === 'node' && multiNodeIds.includes(node.id) ? '#2563eb' : '#555'"
              :stroke-width="selectedKind === 'node' && multiNodeIds.includes(node.id) ? 2.5 : 1.5" />
            <polygon v-else-if="node.kind === 'decision'" :points="diamondPoints(node)" fill="#e8f5e9"
              :stroke="selectedKind === 'node' && multiNodeIds.includes(node.id) ? '#2563eb' : '#555'"
              :stroke-width="selectedKind === 'node' && multiNodeIds.includes(node.id) ? 2.5 : 1.5" />
            <foreignObject v-if="editingNode !== node.id" :x="node.x" :y="node.y" :width="node.w" :height="node.h" class="bf__node-text-wrap">
              <div class="bf__node-text">{{ node.text }}</div>
            </foreignObject>
            <foreignObject v-else :x="node.x" :y="node.y" :width="node.w" :height="node.h">
              <input v-model="editText" class="bf__edit-input bf__edit-input--node" @blur="commitEditNode" @keydown.enter="commitEditNode" />
            </foreignObject>
            <circle v-for="p in ports" :key="p" :data-port="p" :cx="portPos(node, p).x" :cy="portPos(node, p).y" r="5"
              class="bf__port" @mousedown.stop="onPortMouseDown($event, node, p)" />
          </g>
          <g v-for="node in annoNodes" :key="node.id" :data-node-id="node.id" class="bf__node bf__node--anno"
            :class="{ 'bf__node--sel': selectedKind === 'node' && multiNodeIds.includes(node.id) }"
            @mousedown="onNodeMouseDown($event, node)" @dblclick.stop="startEditNode(node)">
            <rect :x="node.x" :y="node.y" :width="node.w" :height="node.h" rx="3" fill="#fffbe6"
              :stroke="selectedKind === 'node' && multiNodeIds.includes(node.id) ? '#2563eb' : '#e6b800'"
              :stroke-width="selectedKind === 'node' && multiNodeIds.includes(node.id) ? 2.5 : 1.5" stroke-dasharray="4 3" />
            <foreignObject v-if="editingNode !== node.id" :x="node.x" :y="node.y" :width="node.w" :height="node.h" class="bf__node-text-wrap">
              <div class="bf__node-text bf__anno-text">{{ node.text }}</div>
            </foreignObject>
            <foreignObject v-else :x="node.x" :y="node.y" :width="node.w" :height="node.h">
              <input v-model="editText" class="bf__edit-input bf__edit-input--node" @blur="commitEditNode" @keydown.enter="commitEditNode" />
            </foreignObject>
            <circle v-for="p in ports" :key="p" :data-port="p" :cx="portPos(node, p).x" :cy="portPos(node, p).y" r="5"
              class="bf__port" @mousedown.stop="onPortMouseDown($event, node, p)" />
          </g>
          <g v-if="selectedKind === 'edge' && selectedEdge" class="bf__edge-handles">
            <circle :cx="portPos(nodeByIdSafe(selectedEdge.from), selectedEdge.fromPort).x"
              :cy="portPos(nodeByIdSafe(selectedEdge.from), selectedEdge.fromPort).y"
              r="6" class="bf__edge-handle" @mousedown.stop="onEdgeEndMouseDown($event, selectedEdge, 'from')" />
            <circle :cx="portPos(nodeByIdSafe(selectedEdge.to), selectedEdge.toPort).x"
              :cy="portPos(nodeByIdSafe(selectedEdge.to), selectedEdge.toPort).y"
              r="6" class="bf__edge-handle" @mousedown.stop="onEdgeEndMouseDown($event, selectedEdge, 'to')" />
            <circle :cx="edgeBendHandlePos(selectedEdge).x" :cy="edgeBendHandlePos(selectedEdge).y"
              r="7" class="bf__edge-handle bf__edge-handle--bend" @mousedown.stop="onEdgeBendMouseDown($event, selectedEdge)" />
          </g>
        </g>
        <defs>
          <marker id="bf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#666" />
          </marker>
          <marker id="bf-arrow-dashed" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#e6b800" />
          </marker>
        </defs>
      </svg>
    </div>
  </div>
  `,
}).mount('#app');
