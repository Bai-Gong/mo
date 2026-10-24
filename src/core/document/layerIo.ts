/**
 * Rust 图层/选区/绘制/历史命令的 IPC 绑定
 * （src-tauri/src/layers.rs · paint.rs · imageio.rs 的前端契约）。
 *
 * M3 起所有**改文档**的命令统一返回 EditResult（图层快照 + 历史快照 + 文档
 * 尺寸）：一次往返拿到一致状态，前端据此刷新图层面板、历史面板与文档元信息；
 * 改变合成的命令随后由 layerPipeline 重拉像素（fetchPixels 走 get_pixels
 * 原始字节通道）。选区命令与会话态（设活动图层）不进历史，契约不变。
 */
import { invoke } from "@tauri-apps/api/core";
import type { HistoryMeta, LayerMeta, BlendModeName, StrokeParams } from "./types";
import type { SelectionShape } from "../canvas/selection";

/** Rust LayersSnapshot（serde camelCase）。 */
export interface LayersSnapshot {
  /** 自底向上。 */
  layers: LayerMeta[];
  activeLayerId: number;
}

/** Rust EditResult（serde camelCase）：编辑命令的统一返回。 */
export interface EditResult {
  layers: LayersSnapshot;
  history: HistoryMeta;
  /** 文档当前尺寸（裁剪/撤销重做可能改变）。 */
  width: number;
  height: number;
}

/** 图层/选区/绘制/历史命令面的前端抽象（测试注入假 io 走全编排逻辑）。 */
export interface LayerIo {
  getLayers(docId: number): Promise<LayersSnapshot>;
  addLayer(docId: number): Promise<EditResult>;
  deleteLayer(docId: number, layerId: number): Promise<EditResult>;
  moveLayer(docId: number, layerId: number, toIndex: number): Promise<EditResult>;
  setLayerVisible(docId: number, layerId: number, visible: boolean): Promise<EditResult>;
  setLayerOpacity(docId: number, layerId: number, opacity: number): Promise<EditResult>;
  setLayerBlendMode(
    docId: number,
    layerId: number,
    mode: BlendModeName,
  ): Promise<EditResult>;
  setActiveLayer(docId: number, layerId: number): Promise<LayersSnapshot>;
  /** 选区栅格化入 Rust 文档（蒙版事实源；会话态不进历史）。 */
  setSelection(docId: number, shape: SelectionShape): Promise<void>;
  selectAll(docId: number): Promise<void>;
  deselect(docId: number): Promise<void>;
  /** 填活动图层（无选区 = 整层）。color 为 RGBA。 */
  fillActiveLayer(docId: number, color: [number, number, number, number]): Promise<EditResult>;
  /** 画笔/橡皮：一笔折线落到活动图层（一笔 = 一条历史）。 */
  paintStroke(docId: number, stroke: StrokeParams): Promise<EditResult>;
  /** 裁剪整栈（浮点矩形，Rust 取整到像素边界）。 */
  cropDocument(docId: number, rect: { x: number; y: number; w: number; h: number }): Promise<EditResult>;
  /** 撤销一步（无可撤销时安静返回当前状态）。 */
  undo(docId: number): Promise<EditResult>;
  /** 重做一步。 */
  redo(docId: number): Promise<EditResult>;
  /** 历史跳转：退/进到「第 target 条已应用」（0 = 初始状态）。 */
  historyJump(docId: number, target: number): Promise<EditResult>;
  /** 历史面板一次拉取（标签打开/切换时）。 */
  getHistory(docId: number): Promise<HistoryMeta>;
  /** 拉合成像素（RGBA8，w*h*4 字节，get_pixels 原始字节通道）。 */
  fetchPixels(docId: number): Promise<Uint8ClampedArray>;
}

export const tauriLayerIo: LayerIo = {
  async getLayers(docId) {
    return invoke<LayersSnapshot>("get_layers", { docId });
  },
  async addLayer(docId) {
    return invoke<EditResult>("add_layer", { docId });
  },
  async deleteLayer(docId, layerId) {
    return invoke<EditResult>("delete_layer", { docId, layerId });
  },
  async moveLayer(docId, layerId, toIndex) {
    return invoke<EditResult>("move_layer", { docId, layerId, toIndex });
  },
  async setLayerVisible(docId, layerId, visible) {
    return invoke<EditResult>("set_layer_visible", { docId, layerId, visible });
  },
  async setLayerOpacity(docId, layerId, opacity) {
    return invoke<EditResult>("set_layer_opacity", { docId, layerId, opacity });
  },
  async setLayerBlendMode(docId, layerId, mode) {
    return invoke<EditResult>("set_layer_blend_mode", { docId, layerId, mode });
  },
  async setActiveLayer(docId, layerId) {
    return invoke<LayersSnapshot>("set_active_layer", { docId, layerId });
  },
  async setSelection(docId, shape) {
    await invoke("set_selection", { docId, shape });
  },
  async selectAll(docId) {
    await invoke("select_all", { docId });
  },
  async deselect(docId) {
    await invoke("deselect", { docId });
  },
  async fillActiveLayer(docId, color) {
    return invoke<EditResult>("fill_active_layer", { docId, color });
  },
  async paintStroke(docId, stroke) {
    const { points, radius, color, erase } = stroke;
    return invoke<EditResult>("paint_stroke", { docId, points, radius, color, erase });
  },
  async cropDocument(docId, rect) {
    return invoke<EditResult>("crop_document", { docId, ...rect });
  },
  async undo(docId) {
    return invoke<EditResult>("undo", { docId });
  },
  async redo(docId) {
    return invoke<EditResult>("redo", { docId });
  },
  async historyJump(docId, target) {
    return invoke<EditResult>("history_jump", { docId, target });
  },
  async getHistory(docId) {
    return invoke<HistoryMeta>("get_history", { docId });
  },
  async fetchPixels(docId) {
    const buffer = await invoke<ArrayBuffer>("get_pixels", { docId });
    return new Uint8ClampedArray(buffer);
  },
};
