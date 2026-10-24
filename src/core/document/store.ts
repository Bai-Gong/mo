/**
 * 工程状态（M1）：打开的文档标签 + 每文档视口 + 工具/光标/取色会话态。
 *
 * 写入纪律（参照 jian store）：
 * - 像素本体不进 store（pixelStore 驻留），这里只放元信息与视口；
 * - 视口未适配用 null 占位：文档打开时画布可能尚未布局（viewportSize 未知），
 *   CanvasView 首帧量到尺寸后 ensureView 落「适合窗口」；
 * - 缩放一律经 coords.ts 的数学（钳制/锚点不变式），store 不自算。
 */
import { create } from "zustand";
import type { ImageDocMeta, Tool, Viewport } from "./types";
import {
  actualSizeViewport,
  fitViewport,
  panBy as panView,
  zoomAround,
  type Size,
} from "../canvas/coords";
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
  tool: Tool;
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
}

/** 派生：活动文档元信息。 */
export function selectActiveDoc(s: DocsState): ImageDocMeta | undefined {
  return s.docs.find((d) => d.id === s.activeId);
}

/** 派生：活动视口（未适配/无文档为 undefined）。 */
export function selectActiveView(s: DocsState): Viewport | undefined {
  return s.activeId === null ? undefined : (s.views[s.activeId] ?? undefined);
}

export const useDocsStore = create<DocsState>()((set, get) => ({
  docs: [],
  activeId: null,
  views: {},
  tool: "hand",
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
    })),

  closeTab: (id) => {
    const { docs, activeId, views } = get();
    const index = docs.findIndex((d) => d.id === id);
    if (index < 0) return;
    const rest = docs.filter((d) => d.id !== id);
    const nextViews = { ...views };
    delete nextViews[id];
    // 关的是活动标签 → 让位左邻，无左邻取右邻；全关 → null
    const nextActive =
      activeId === id ? (rest[Math.max(0, index - 1)]?.id ?? null) : activeId;
    set({
      docs: rest,
      views: nextViews,
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
}));
