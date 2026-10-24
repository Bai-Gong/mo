/**
 * Rust 图层/选区命令的 IPC 绑定（src-tauri/src/layers.rs 的前端契约）。
 *
 * 所有图层命令返回 LayersSnapshot（列表 + 活动层），一次往返拿到一致状态；
 * fetchPixels 复用 imageio 的 get_pixels 原始字节通道拉合成像素——图层操作
 * 改变合成后由 layerPipeline 重拉。
 */
import { invoke } from "@tauri-apps/api/core";
import type { LayerMeta, BlendModeName } from "./types";
import type { SelectionShape } from "../canvas/selection";

/** Rust LayersSnapshot（serde camelCase）。 */
export interface LayersSnapshot {
  /** 自底向上。 */
  layers: LayerMeta[];
  activeLayerId: number;
}

/** 图层/选区命令面的前端抽象（测试注入假 io 走全编排逻辑）。 */
export interface LayerIo {
  getLayers(docId: number): Promise<LayersSnapshot>;
  addLayer(docId: number): Promise<LayersSnapshot>;
  deleteLayer(docId: number, layerId: number): Promise<LayersSnapshot>;
  moveLayer(docId: number, layerId: number, toIndex: number): Promise<LayersSnapshot>;
  setLayerVisible(docId: number, layerId: number, visible: boolean): Promise<LayersSnapshot>;
  setLayerOpacity(docId: number, layerId: number, opacity: number): Promise<LayersSnapshot>;
  setLayerBlendMode(
    docId: number,
    layerId: number,
    mode: BlendModeName,
  ): Promise<LayersSnapshot>;
  setActiveLayer(docId: number, layerId: number): Promise<LayersSnapshot>;
  /** 选区栅格化入 Rust 文档（蒙版事实源）。 */
  setSelection(docId: number, shape: SelectionShape): Promise<void>;
  selectAll(docId: number): Promise<void>;
  deselect(docId: number): Promise<void>;
  /** 填活动图层（无选区 = 整层）。color 为 RGBA。 */
  fillActiveLayer(docId: number, color: [number, number, number, number]): Promise<void>;
  /** 拉合成像素（RGBA8，w*h*4 字节，get_pixels 原始字节通道）。 */
  fetchPixels(docId: number): Promise<Uint8ClampedArray>;
}

export const tauriLayerIo: LayerIo = {
  async getLayers(docId) {
    return invoke<LayersSnapshot>("get_layers", { docId });
  },
  async addLayer(docId) {
    return invoke<LayersSnapshot>("add_layer", { docId });
  },
  async deleteLayer(docId, layerId) {
    return invoke<LayersSnapshot>("delete_layer", { docId, layerId });
  },
  async moveLayer(docId, layerId, toIndex) {
    return invoke<LayersSnapshot>("move_layer", { docId, layerId, toIndex });
  },
  async setLayerVisible(docId, layerId, visible) {
    return invoke<LayersSnapshot>("set_layer_visible", { docId, layerId, visible });
  },
  async setLayerOpacity(docId, layerId, opacity) {
    return invoke<LayersSnapshot>("set_layer_opacity", { docId, layerId, opacity });
  },
  async setLayerBlendMode(docId, layerId, mode) {
    return invoke<LayersSnapshot>("set_layer_blend_mode", { docId, layerId, mode });
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
    await invoke("fill_active_layer", { docId, color });
  },
  async fetchPixels(docId) {
    const buffer = await invoke<ArrayBuffer>("get_pixels", { docId });
    return new Uint8ClampedArray(buffer);
  },
};
