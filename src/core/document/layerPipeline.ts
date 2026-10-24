/**
 * 图层/选区/绘制/历史编排层（M2 起，M3 扩展）：
 * Rust 命令（layerIo）↔ 像素驻留（pixelStore）↔ 状态（store）。
 *
 * 规则：
 * - 每个编辑命令成功后把返回的 EditResult 落进 store（图层快照 + 历史快照；
 *   Rust 是事实源）；尺寸变化（裁剪/撤销重做）同步校正文档元信息并回到
 *   「适合窗口」；
 * - 改变合成结果的命令（绘制/填充/删层/排序/可见性/不透明度/混合模式/裁剪/
 *   撤销/重做/跳转）随后重拉合成像素并 bump compositeVersion，CanvasView
 *   据此重建源画布；新建空层与设活动层不改合成，不重拉；
 * - 选区形状回显只服务画布轮廓绘制，蒙版事实在 Rust 侧；选区是会话态，
 *   不进历史。
 */
import {
  tauriLayerIo,
  type EditResult,
  type LayerIo,
} from "./layerIo";
import { setPixels } from "./pixelStore";
import { selectActiveDoc, useDocsStore } from "./store";
import type { BlendModeName, StrokeParams } from "./types";
import type { SelectionShape } from "../canvas/selection";

/** 编辑结果落位：图层快照 + 历史快照 + 尺寸校正。 */
function applyEdit(docId: number, result: EditResult): void {
  const store = useDocsStore.getState();
  store.setLayers(docId, result.layers.layers, result.layers.activeLayerId);
  store.setHistory(docId, result.history);
  const doc = selectActiveDoc(store) ?? store.docs.find((d) => d.id === docId);
  if (doc && (doc.width !== result.width || doc.height !== result.height)) {
    store.resizeDoc(docId, result.width, result.height);
  }
}

/** 合成像素重拉（改变合成的命令后调用）。 */
async function refreshComposite(docId: number, io: LayerIo): Promise<void> {
  const pixels = await io.fetchPixels(docId);
  setPixels(docId, pixels);
  useDocsStore.getState().bumpComposite(docId);
}

/** 拉一次面板快照（文档打开/标签切换时）。 */
export async function refreshLayers(docId: number, io: LayerIo = tauriLayerIo): Promise<void> {
  const layers = await io.getLayers(docId);
  useDocsStore.getState().setLayers(docId, layers.layers, layers.activeLayerId);
}

/** 拉一次历史快照（历史面板自愈：null 即拉）。 */
export async function refreshHistory(docId: number, io: LayerIo = tauriLayerIo): Promise<void> {
  useDocsStore.getState().setHistory(docId, await io.getHistory(docId));
}

/** 新建空图层（置顶并激活；空层不改合成，不重拉像素）。 */
export async function addLayer(docId: number, io: LayerIo = tauriLayerIo): Promise<void> {
  applyEdit(docId, await io.addLayer(docId));
}

/** 删除图层（改变合成）。 */
export async function deleteLayer(
  docId: number,
  layerId: number,
  io: LayerIo = tauriLayerIo,
): Promise<void> {
  applyEdit(docId, await io.deleteLayer(docId, layerId));
  await refreshComposite(docId, io);
}

/** 排序（改变合成）。toIndex 为栈索引（0 = 最底）。 */
export async function moveLayer(
  docId: number,
  layerId: number,
  toIndex: number,
  io: LayerIo = tauriLayerIo,
): Promise<void> {
  applyEdit(docId, await io.moveLayer(docId, layerId, toIndex));
  await refreshComposite(docId, io);
}

/** 可见性开关（改变合成）。 */
export async function setLayerVisible(
  docId: number,
  layerId: number,
  visible: boolean,
  io: LayerIo = tauriLayerIo,
): Promise<void> {
  applyEdit(docId, await io.setLayerVisible(docId, layerId, visible));
  await refreshComposite(docId, io);
}

/** 不透明度 0–1（改变合成）。 */
export async function setLayerOpacity(
  docId: number,
  layerId: number,
  opacity: number,
  io: LayerIo = tauriLayerIo,
): Promise<void> {
  applyEdit(docId, await io.setLayerOpacity(docId, layerId, opacity));
  await refreshComposite(docId, io);
}

/** 混合模式（改变合成）。 */
export async function setLayerBlendMode(
  docId: number,
  layerId: number,
  mode: BlendModeName,
  io: LayerIo = tauriLayerIo,
): Promise<void> {
  applyEdit(docId, await io.setLayerBlendMode(docId, layerId, mode));
  await refreshComposite(docId, io);
}

/** 设活动图层（笔画/填充落点，不改合成）。 */
export async function activateLayer(
  docId: number,
  layerId: number,
  io: LayerIo = tauriLayerIo,
): Promise<void> {
  const snap = await io.setActiveLayer(docId, layerId);
  useDocsStore.getState().setLayers(docId, snap.layers, snap.activeLayerId);
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
  applyEdit(docId, await io.fillActiveLayer(docId, color));
  await refreshComposite(docId, io);
}

/** 画笔/橡皮：一笔折线落到活动图层（一笔 = 一条历史），随后重拉合成。 */
export async function paintStroke(
  docId: number,
  stroke: StrokeParams,
  io: LayerIo = tauriLayerIo,
): Promise<void> {
  applyEdit(docId, await io.paintStroke(docId, stroke));
  await refreshComposite(docId, io);
}

/** 裁剪整栈（改变尺寸与合成）。rect 为图像坐标浮点矩形。 */
export async function cropDoc(
  docId: number,
  rect: { x: number; y: number; w: number; h: number },
  io: LayerIo = tauriLayerIo,
): Promise<void> {
  applyEdit(docId, await io.cropDocument(docId, rect));
  await refreshComposite(docId, io);
}

/** 撤销一步（图像内容与图层结构同栈回退）。 */
export async function undo(docId: number, io: LayerIo = tauriLayerIo): Promise<void> {
  applyEdit(docId, await io.undo(docId));
  await refreshComposite(docId, io);
}

/** 重做一步。 */
export async function redo(docId: number, io: LayerIo = tauriLayerIo): Promise<void> {
  applyEdit(docId, await io.redo(docId));
  await refreshComposite(docId, io);
}

/** 历史面板跳转：退/进到「第 target 条已应用」（0 = 初始状态）。 */
export async function jumpHistory(
  docId: number,
  target: number,
  io: LayerIo = tauriLayerIo,
): Promise<void> {
  applyEdit(docId, await io.historyJump(docId, target));
  await refreshComposite(docId, io);
}
