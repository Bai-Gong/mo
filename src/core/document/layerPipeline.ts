/**
 * 图层/选区编排层（M2）：Rust 命令（layerIo）↔ 像素驻留（pixelStore）↔ 状态（store）。
 *
 * 规则：
 * - 每个图层命令成功后把返回的 LayersSnapshot 落进 store（Rust 是事实源）；
 * - 改变合成结果的命令（填充/删层/排序/可见性/不透明度/混合模式）随后重拉
 *   合成像素并 bump compositeVersion，CanvasView 据此重建源画布；
 * - 选区形状回显只服务画布轮廓绘制，蒙版事实在 Rust 侧。
 */
import { tauriLayerIo, type LayerIo, type LayersSnapshot } from "./layerIo";
import { setPixels } from "./pixelStore";
import { selectActiveDoc, useDocsStore } from "./store";
import type { BlendModeName } from "./types";
import type { SelectionShape } from "../canvas/selection";

function applySnapshot(docId: number, snap: LayersSnapshot): void {
  useDocsStore.getState().setLayers(docId, snap.layers, snap.activeLayerId);
}

/** 合成像素重拉（填充/图层状态变化后调用）。 */
async function refreshComposite(docId: number, io: LayerIo): Promise<void> {
  const pixels = await io.fetchPixels(docId);
  setPixels(docId, pixels);
  useDocsStore.getState().bumpComposite(docId);
}

/** 拉一次面板快照（文档打开/标签切换时）。 */
export async function refreshLayers(docId: number, io: LayerIo = tauriLayerIo): Promise<void> {
  applySnapshot(docId, await io.getLayers(docId));
}

/** 新建空图层（置顶并激活；空层不改合成，不重拉像素）。 */
export async function addLayer(docId: number, io: LayerIo = tauriLayerIo): Promise<void> {
  applySnapshot(docId, await io.addLayer(docId));
}

/** 删除图层（改变合成）。 */
export async function deleteLayer(
  docId: number,
  layerId: number,
  io: LayerIo = tauriLayerIo,
): Promise<void> {
  applySnapshot(docId, await io.deleteLayer(docId, layerId));
  await refreshComposite(docId, io);
}

/** 排序（改变合成）。toIndex 为栈索引（0 = 最底）。 */
export async function moveLayer(
  docId: number,
  layerId: number,
  toIndex: number,
  io: LayerIo = tauriLayerIo,
): Promise<void> {
  applySnapshot(docId, await io.moveLayer(docId, layerId, toIndex));
  await refreshComposite(docId, io);
}

/** 可见性开关（改变合成）。 */
export async function setLayerVisible(
  docId: number,
  layerId: number,
  visible: boolean,
  io: LayerIo = tauriLayerIo,
): Promise<void> {
  applySnapshot(docId, await io.setLayerVisible(docId, layerId, visible));
  await refreshComposite(docId, io);
}

/** 不透明度 0–1（改变合成）。 */
export async function setLayerOpacity(
  docId: number,
  layerId: number,
  opacity: number,
  io: LayerIo = tauriLayerIo,
): Promise<void> {
  applySnapshot(docId, await io.setLayerOpacity(docId, layerId, opacity));
  await refreshComposite(docId, io);
}

/** 混合模式（改变合成）。 */
export async function setLayerBlendMode(
  docId: number,
  layerId: number,
  mode: BlendModeName,
  io: LayerIo = tauriLayerIo,
): Promise<void> {
  applySnapshot(docId, await io.setLayerBlendMode(docId, layerId, mode));
  await refreshComposite(docId, io);
}

/** 设活动图层（填充落点，不改合成）。 */
export async function activateLayer(
  docId: number,
  layerId: number,
  io: LayerIo = tauriLayerIo,
): Promise<void> {
  applySnapshot(docId, await io.setActiveLayer(docId, layerId));
}

/** 提交选区形状：Rust 栅格化入文档 + 前端回显（画轮廓）。 */
export async function commitSelection(
  docId: number,
  shape: SelectionShape,
  io: LayerIo = tauriLayerIo,
): Promise<void> {
  await io.setSelection(docId, shape);
  useDocsStore.getState().setSelectionEcho(docId, shape);
}

/** 全选（回显为整画布矩形）。 */
export async function selectAll(docId: number, io: LayerIo = tauriLayerIo): Promise<void> {
  await io.selectAll(docId);
  const doc = selectActiveDoc(useDocsStore.getState());
  useDocsStore.getState().setSelectionEcho(
    docId,
    doc ? { kind: "rect", x: 0, y: 0, w: doc.width, h: doc.height } : null,
  );
}

/** 取消选择。 */
export async function deselect(docId: number, io: LayerIo = tauriLayerIo): Promise<void> {
  await io.deselect(docId);
  useDocsStore.getState().setSelectionEcho(docId, null);
}

/** 用颜色填充活动图层的选区（无选区 = 整层），随后重拉合成。 */
export async function fillSelection(
  docId: number,
  color: [number, number, number, number],
  io: LayerIo = tauriLayerIo,
): Promise<void> {
  await io.fillActiveLayer(docId, color);
  await refreshComposite(docId, io);
}
