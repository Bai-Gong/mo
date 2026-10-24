/**
 * 工程状态（M1 + M2）：打开的文档标签 + 每文档视口 + 图层/选区元信息
 * + 工具/光标/取色会话态。
 *
 * 写入纪律（参照 jian store）：
 * - 像素本体不进 store（pixelStore 驻留），这里只放元信息与视口；
 * - 视口未适配用 null 占位：文档打开时画布可能尚未布局（viewportSize 未知），
 *   CanvasView 首帧量到尺寸后 ensureView 落「适合窗口」；
 * - 缩放一律经 coords.ts 的数学（钳制/锚点不变式），store 不自算；
 * - M2 图层列表/活动层/选区回显/合成版本是「Rust 事实源的影子」，只由
 *   layerPipeline 在命令成功后写入；合成像素重拉后 bump compositeVersion，
 *   CanvasView 据版本号重建离屏源画布。
 */
import { create } from "zustand";
import type { HistoryMeta, ImageDocMeta, LayerMeta, Tool, Viewport } from "./types";
import {
  actualSizeViewport,
  fitViewport,
  panBy as panView,
  zoomAround,
  type Size,
} from "../canvas/coords";
import type { SelectionShape } from "../canvas/selection";
import { clampZoom } from "../canvas/fit";
import type { Rgba } from "../canvas/pixelPicker";

export interface StatusMessage {
  kind: "ok" | "error";
  text: string;
}

export interface DocsState {
  docs: ImageDocMeta[];
  activeId: number | null;
  /** docId → 视口；null = 尚未适配（待画布量到尺寸后 fit）。 */
  views: Record<number, Viewport | null>;
  /** docId → 图层列表（自底向上，Rust LayersSnapshot 的影子）。 */
  layers: Record<number, LayerMeta[]>;
  /** docId → 活动图层 id（填充落点）。 */
  activeLayerId: Record<number, number>;
  /** docId → 选区形状回显（画蚂蚁线用；蒙版事实在 Rust 侧，null = 无选区）。 */
  selection: Record<number, SelectionShape | null>;
  /** docId → 合成版本号（像素重拉后 +1，画布源缓存失效依据）。 */
  compositeVersion: Record<number, number>;
  /** docId → 历史快照（Rust HistoryInfo 的影子；null = 未拉取）。 */
  history: Record<number, HistoryMeta | null>;
  tool: Tool;
  /** 笔刷大小（直径 px，画笔/橡皮共用；半径 = size/2 下传 Rust）。 */
  brushSize: number;
  /** 文字工具：新文本的字体族（font_families 探测结果，默认微软雅黑）。 */
  textFamily: string;
  /** 文字工具：新文本的字号（px，钳 4–512，与 Rust 同口径）。 */
  textSize: number;
  /** 光标所在图像像素坐标（图像外/无文档为 null）。 */
  cursor: { x: number; y: number } | null;
  /** 光标下像素颜色（实时预览）。 */
  hoverColor: Rgba | null;
  /** 吸管点击取到的颜色。 */
  pickedColor: Rgba | null;
  /** 画布视口尺寸（CanvasView 的 ResizeObserver 回填）。 */
  viewportSize: Size | null;
  message: StatusMessage | null;

  openTab(meta: ImageDocMeta): void;
  /** 关闭标签：活动让位邻位（优先左邻，无则右邻）。 */
  closeTab(id: number): void;
  setActive(id: number): void;
  /** 未适配的视图按当前视口尺寸落「适合窗口」（幂等）。 */
  ensureView(id: number): void;
  setViewportSize(size: Size): void;
  setTool(tool: Tool): void;
  /** 以画布点 (cx, cy) 为锚缩放（滚轮）。 */
  zoomAt(cx: number, cy: number, factor: number): void;
  /** 以视口中心为锚设缩放（菜单/快捷键）。 */
  setZoom(zoom: number): void;
  fitActive(): void;
  actualSizeActive(): void;
  panBy(dx: number, dy: number): void;
  setCursor(point: { x: number; y: number } | null, hover: Rgba | null): void;
  pickColor(color: Rgba): void;
  setMessage(message: StatusMessage | null): void;
  /** 图层快照落位（layerPipeline 在命令成功后调用）。 */
  setLayers(docId: number, layers: LayerMeta[], activeLayerId: number): void;
  /** 历史快照落位（编辑命令/撤销重做/面板拉取后调用）。 */
  setHistory(docId: number, history: HistoryMeta): void;
  /** 文档尺寸变化（裁剪/撤销重做）：更新元信息并把视图标记待「适合窗口」。 */
  resizeDoc(docId: number, width: number, height: number): void;
  /** 笔刷大小（直径 px，钳到 1–512）。 */
  setBrushSize(size: number): void;
  /** 文字工具字体族（面板选择）。 */
  setTextFamily(family: string): void;
  /** 文字工具字号（钳 4–512，与 Rust 同口径）。 */
  setTextSize(size: number): void;
  /** 选区回显落位（null = 取消选择）。 */
  setSelectionEcho(docId: number, shape: SelectionShape | null): void;
  /** 合成像素已重拉，画布源缓存应失效。 */
  bumpComposite(docId: number): void;
}

/** 派生：活动文档元信息。 */
export function selectActiveDoc(s: DocsState): ImageDocMeta | undefined {
  return s.docs.find((d) => d.id === s.activeId);
}

/** 派生：活动视口（未适配/无文档为 undefined）。 */
export function selectActiveView(s: DocsState): Viewport | undefined {
  return s.activeId === null ? undefined : (s.views[s.activeId] ?? undefined);
}

/** 派生：活动文档的图层列表（自底向上）。 */
export function selectActiveLayers(s: DocsState): LayerMeta[] {
  return s.activeId === null ? [] : (s.layers[s.activeId] ?? []);
}

/** 派生：活动文档的选区回显。 */
export function selectActiveSelection(s: DocsState): SelectionShape | null {
  return s.activeId === null ? null : (s.selection[s.activeId] ?? null);
}

export const useDocsStore = create<DocsState>()((set, get) => ({
  docs: [],
  activeId: null,
  views: {},
  layers: {},
  activeLayerId: {},
  selection: {},
  compositeVersion: {},
  history: {},
  tool: "hand",
  brushSize: 8,
  textFamily: "微软雅黑",
  textSize: 32,
  cursor: null,
  hoverColor: null,
  pickedColor: null,
  viewportSize: null,
  message: null,

  openTab: (meta) =>
    set((s) => ({
      docs: [...s.docs, meta],
      activeId: meta.id,
      views: { ...s.views, [meta.id]: null },
      layers: { ...s.layers, [meta.id]: [] },
      activeLayerId: { ...s.activeLayerId, [meta.id]: 0 },
      selection: { ...s.selection, [meta.id]: null },
      compositeVersion: { ...s.compositeVersion, [meta.id]: 0 },
      history: { ...s.history, [meta.id]: null },
    })),

  closeTab: (id) => {
    const { docs, activeId, views, layers, activeLayerId, selection, compositeVersion, history } = get();
    const index = docs.findIndex((d) => d.id === id);
    if (index < 0) return;
    const rest = docs.filter((d) => d.id !== id);
    const nextViews = { ...views };
    delete nextViews[id];
    const nextLayers = { ...layers };
    delete nextLayers[id];
    const nextActiveLayer = { ...activeLayerId };
    delete nextActiveLayer[id];
    const nextSelection = { ...selection };
    delete nextSelection[id];
    const nextVersion = { ...compositeVersion };
    delete nextVersion[id];
    const nextHistory = { ...history };
    delete nextHistory[id];
    // 关的是活动标签 → 让位左邻，无左邻取右邻；全关 → null
    const nextActive =
      activeId === id ? (rest[Math.max(0, index - 1)]?.id ?? null) : activeId;
    set({
      docs: rest,
      views: nextViews,
      layers: nextLayers,
      activeLayerId: nextActiveLayer,
      selection: nextSelection,
      compositeVersion: nextVersion,
      history: nextHistory,
      activeId: nextActive,
      cursor: activeId === id ? null : get().cursor,
    });
  },

  setActive: (id) => {
    if (!get().docs.some((d) => d.id === id)) return;
    set({ activeId: id, cursor: null, hoverColor: null });
  },

  ensureView: (id) => {
    const { views, viewportSize, docs } = get();
    const doc = docs.find((d) => d.id === id);
    if (views[id] !== undefined && views[id] !== null) return; // 已适配，幂等
    if (!doc || !viewportSize) return; // 画布未量到尺寸，等下一拍
    set({ views: { ...views, [id]: fitViewport(viewportSize, doc) } });
  },

  setViewportSize: (size) => {
    const { views, viewportSize, docs } = get();
    if (
      viewportSize &&
      viewportSize.width === size.width &&
      viewportSize.height === size.height
    ) {
      return; // 尺寸未变（ResizeObserver 抖动）不重算
    }
    // 只补未适配的视图；已适配的保持用户当前视口（Photoshop 惯例：不自动重排）
    const nextViews = { ...views };
    for (const doc of docs) {
      if (nextViews[doc.id] == null) {
        nextViews[doc.id] = fitViewport(size, doc);
      }
    }
    set({ viewportSize: size, views: nextViews });
  },

  setTool: (tool) => set({ tool }),

  zoomAt: (cx, cy, factor) => {
    const view = selectActiveView(get());
    if (!view) return;
    set({ views: { ...get().views, [get().activeId as number]: zoomAround(view, factor, cx, cy) } });
  },

  setZoom: (zoom) => {
    const { activeId, viewportSize } = get();
    const view = selectActiveView(get());
    if (!view || !viewportSize || activeId === null) return;
    const cx = viewportSize.width / 2;
    const cy = viewportSize.height / 2;
    const next = zoomAround(view, clampZoom(zoom) / view.zoom, cx, cy);
    set({ views: { ...get().views, [activeId]: next } });
  },

  fitActive: () => {
    const { activeId, viewportSize } = get();
    const doc = selectActiveDoc(get());
    if (!doc || !viewportSize || activeId === null) return;
    set({ views: { ...get().views, [activeId]: fitViewport(viewportSize, doc) } });
  },

  actualSizeActive: () => {
    const { activeId, viewportSize } = get();
    const doc = selectActiveDoc(get());
    if (!doc || !viewportSize || activeId === null) return;
    set({ views: { ...get().views, [activeId]: actualSizeViewport(viewportSize, doc) } });
  },

  panBy: (dx, dy) => {
    const view = selectActiveView(get());
    const activeId = get().activeId;
    if (!view || activeId === null) return;
    set({ views: { ...get().views, [activeId]: panView(view, dx, dy) } });
  },

  setCursor: (point, hover) => set({ cursor: point, hoverColor: hover }),

  pickColor: (color) => set({ pickedColor: color }),

  setMessage: (message) => set({ message }),

  setLayers: (docId, layers, activeLayerId) =>
    set((s) => ({
      layers: { ...s.layers, [docId]: layers },
      activeLayerId: { ...s.activeLayerId, [docId]: activeLayerId },
    })),

  setHistory: (docId, history) =>
    set((s) => ({ history: { ...s.history, [docId]: history } })),

  resizeDoc: (docId, width, height) =>
    set((s) => {
      const doc = s.docs.find((d) => d.id === docId);
      if (!doc || (doc.width === width && doc.height === height)) return s;
      return {
        docs: s.docs.map((d) => (d.id === docId ? { ...d, width, height } : d)),
        // 尺寸变了，旧视图锚点失去意义：回到「适合窗口」（null = 待适配）
        views: { ...s.views, [docId]: null },
      };
    }),

  setBrushSize: (size) => set({ brushSize: Math.min(512, Math.max(1, Math.round(size))) }),

  setTextFamily: (family) => set({ textFamily: family }),

  setTextSize: (size) => set({ textSize: Math.min(512, Math.max(4, Math.round(size))) }),

  setSelectionEcho: (docId, shape) =>
    set((s) => ({ selection: { ...s.selection, [docId]: shape } })),

  bumpComposite: (docId) =>
    set((s) => ({
      compositeVersion: {
        ...s.compositeVersion,
        [docId]: (s.compositeVersion[docId] ?? 0) + 1,
      },
    })),
}));
