/**
 * 图层/选区编排层测试（M2 准入场景的前端状态层部分）：
 * 注入假 layerIo 走真实 layerPipeline/store/pixelStore 代码路径——快照落位、
 * 合成像素重拉 + 版本 bump、选区回显、命令下传参数全链路。
 * Rust 侧图层栈/合成/栅格化本身由 src-tauri 的 layers.rs / selection.rs /
 * imageio.rs 真实测试兜住（含多图层海报导出 PNG 的准入场景）。
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { LayerIo, LayersSnapshot } from "./layerIo";
import type { LayerMeta } from "./types";
import type { SelectionShape } from "../canvas/selection";
import {
  activateLayer,
  addLayer,
  commitSelection,
  deleteLayer,
  deselect,
  fillSelection,
  moveLayer,
  selectAll,
  setLayerBlendMode,
  setLayerOpacity,
  setLayerVisible,
} from "./layerPipeline";
import { useDocsStore } from "./store";
import { clearPixelStore, getPixels, setPixels } from "./pixelStore";
import type { ImageDocMeta } from "./types";

function layer(id: number, name: string, over: Partial<LayerMeta> = {}): LayerMeta {
  return { id, name, visible: true, opacity: 1, blendMode: "normal", ...over };
}

function snap(layers: LayerMeta[], activeLayerId: number): LayersSnapshot {
  return { layers, activeLayerId };
}

interface Call {
  kind: string;
  arg: unknown;
}

/** 假 layerIo：记录命令序列；快照与像素按脚本演化。 */
function makeLayerIo(script: {
  snapshots: LayersSnapshot[]; // 每次 mutating 命令弹一个
  pixelsFor: (docId: number) => Uint8ClampedArray;
}) {
  const calls: Call[] = [];
  let cursor = 0;
  const nextSnap = () => {
    const s = script.snapshots[Math.min(cursor, script.snapshots.length - 1)]!;
    cursor += 1;
    return s;
  };
  const io: LayerIo = {
    async getLayers(docId) {
      calls.push({ kind: "get_layers", arg: docId });
      return script.snapshots[Math.max(0, cursor - 1)] ?? snap([], 0);
    },
    async addLayer(docId) {
      calls.push({ kind: "add_layer", arg: docId });
      return nextSnap();
    },
    async deleteLayer(docId, layerId) {
      calls.push({ kind: "delete_layer", arg: { docId, layerId } });
      return nextSnap();
    },
    async moveLayer(docId, layerId, toIndex) {
      calls.push({ kind: "move_layer", arg: { docId, layerId, toIndex } });
      return nextSnap();
    },
    async setLayerVisible(docId, layerId, visible) {
      calls.push({ kind: "set_layer_visible", arg: { docId, layerId, visible } });
      return nextSnap();
    },
    async setLayerOpacity(docId, layerId, opacity) {
      calls.push({ kind: "set_layer_opacity", arg: { docId, layerId, opacity } });
      return nextSnap();
    },
    async setLayerBlendMode(docId, layerId, mode) {
      calls.push({ kind: "set_layer_blend_mode", arg: { docId, layerId, mode } });
      return nextSnap();
    },
    async setActiveLayer(docId, layerId) {
      calls.push({ kind: "set_active_layer", arg: { docId, layerId } });
      return nextSnap();
    },
    async setSelection(docId, shape) {
      calls.push({ kind: "set_selection", arg: { docId, shape } });
    },
    async selectAll(docId) {
      calls.push({ kind: "select_all", arg: docId });
    },
    async deselect(docId) {
      calls.push({ kind: "deselect", arg: docId });
    },
    async fillActiveLayer(docId, color) {
      calls.push({ kind: "fill_active_layer", arg: { docId, color } });
    },
    async fetchPixels(docId) {
      calls.push({ kind: "get_pixels", arg: docId });
      return script.pixelsFor(docId);
    },
  };
  return { io, calls };
}

function openDoc(id: number, w = 8, h = 6): void {
  const meta: ImageDocMeta = {
    id,
    name: `文档-${id}.png`,
    width: w,
    height: h,
    format: "png",
    hasIcc: false,
    path: "",
  };
  setPixels(id, new Uint8ClampedArray(w * h * 4));
  useDocsStore.getState().openTab(meta);
}

function resetAll() {
  useDocsStore.setState({
    docs: [],
    activeId: null,
    views: {},
    layers: {},
    activeLayerId: {},
    selection: {},
    compositeVersion: {},
    tool: "hand",
    cursor: null,
    hoverColor: null,
    pickedColor: null,
    viewportSize: null,
    message: null,
  });
  clearPixelStore();
}

beforeEach(resetAll);

describe("图层命令编排", () => {
  it("加层：快照落 store（列表 + 活动层），不改合成（不重拉像素）", async () => {
    openDoc(1);
    const { io, calls } = makeLayerIo({
      snapshots: [snap([layer(1, "背景"), layer(2, "图层 1")], 2)],
      pixelsFor: () => new Uint8ClampedArray(8 * 6 * 4),
    });
    await addLayer(1, io);

    const s = useDocsStore.getState();
    expect(s.layers[1]?.map((l) => l.name)).toEqual(["背景", "图层 1"]);
    expect(s.activeLayerId[1]).toBe(2);
    expect(s.compositeVersion[1]).toBe(0); // 空层不改合成
    expect(calls.map((c) => c.kind)).toEqual(["add_layer"]);
  });

  it("删层/排序/可见性/不透明度/混合模式：快照落位 + 合成重拉（版本 bump）", async () => {
    openDoc(1);
    const after = snap([layer(1, "背景")], 1);
    const { io, calls } = makeLayerIo({
      snapshots: [after, after, after, after, after],
      pixelsFor: () => {
        const p = new Uint8ClampedArray(8 * 6 * 4);
        p.fill(7); // 每次重拉内容不同，验证驻留更新
        return p;
      },
    });

    await deleteLayer(1, 2, io);
    await moveLayer(1, 2, 0, io);
    await setLayerVisible(1, 1, false, io);
    await setLayerOpacity(1, 1, 0.5, io);
    await setLayerBlendMode(1, 1, "multiply", io);

    const s = useDocsStore.getState();
    expect(s.compositeVersion[1]).toBe(5);
    expect(getPixels(1)?.[0]).toBe(7);
    expect(calls.map((c) => c.kind)).toEqual([
      "delete_layer",
      "get_pixels",
      "move_layer",
      "get_pixels",
      "set_layer_visible",
      "get_pixels",
      "set_layer_opacity",
      "get_pixels",
      "set_layer_blend_mode",
      "get_pixels",
    ]);
    // 参数原样下传（Rust 契约）
    expect(calls).toContainEqual({ kind: "move_layer", arg: { docId: 1, layerId: 2, toIndex: 0 } });
    expect(calls).toContainEqual({ kind: "set_layer_visible", arg: { docId: 1, layerId: 1, visible: false } });
    expect(calls).toContainEqual({ kind: "set_layer_opacity", arg: { docId: 1, layerId: 1, opacity: 0.5 } });
    expect(calls).toContainEqual({ kind: "set_layer_blend_mode", arg: { docId: 1, layerId: 1, mode: "multiply" } });
  });

  it("设活动图层：只落快照，不重拉像素", async () => {
    openDoc(1);
    const { io, calls } = makeLayerIo({
      snapshots: [snap([layer(1, "背景"), layer(2, "图层 1")], 1)],
      pixelsFor: () => new Uint8ClampedArray(8 * 6 * 4),
    });
    await activateLayer(1, 1, io);
    expect(useDocsStore.getState().activeLayerId[1]).toBe(1);
    expect(calls.map((c) => c.kind)).toEqual(["set_active_layer"]);
  });
});

describe("选区编排", () => {
  it("提交选区：形状下传 Rust + 前端回显", async () => {
    openDoc(1);
    const { io, calls } = makeLayerIo({
      snapshots: [snap([layer(1, "背景")], 1)],
      pixelsFor: () => new Uint8ClampedArray(8 * 6 * 4),
    });
    const shape: SelectionShape = { kind: "rect", x: 1.5, y: 2, w: 4, h: 3 };
    await commitSelection(1, shape, io);

    expect(calls).toContainEqual({ kind: "set_selection", arg: { docId: 1, shape } });
    expect(useDocsStore.getState().selection[1]).toEqual(shape);
  });

  it("全选：回显为整画布矩形（尺寸取自文档元信息）", async () => {
    openDoc(1, 320, 240);
    const { io, calls } = makeLayerIo({
      snapshots: [snap([layer(1, "背景")], 1)],
      pixelsFor: () => new Uint8ClampedArray(4),
    });
    await selectAll(1, io);
    expect(calls).toContainEqual({ kind: "select_all", arg: 1 });
    expect(useDocsStore.getState().selection[1]).toEqual({
      kind: "rect",
      x: 0,
      y: 0,
      w: 320,
      h: 240,
    });
  });

  it("取消选择：命令下传 + 回显清空", async () => {
    openDoc(1);
    const { io, calls } = makeLayerIo({
      snapshots: [snap([layer(1, "背景")], 1)],
      pixelsFor: () => new Uint8ClampedArray(4),
    });
    useDocsStore.getState().setSelectionEcho(1, { kind: "rect", x: 0, y: 0, w: 3, h: 3 });
    await deselect(1, io);
    expect(useDocsStore.getState().selection[1]).toBeNull();
    expect(calls).toContainEqual({ kind: "deselect", arg: 1 });
  });
});

describe("填充编排", () => {
  it("填充活动图层：颜色下传 + 合成重拉 + 版本 bump + 驻留更新", async () => {
    openDoc(1);
    let fillCount = 0;
    const { io, calls } = makeLayerIo({
      snapshots: [snap([layer(1, "背景")], 1)],
      pixelsFor: () => {
        const p = new Uint8ClampedArray(8 * 6 * 4);
        p[0] = 10 * ++fillCount; // 每次重拉可区分
        return p;
      },
    });
    await fillSelection(1, [255, 0, 0, 255], io);
    await fillSelection(1, [0, 128, 0, 128], io);

    expect(calls).toContainEqual({ kind: "fill_active_layer", arg: { docId: 1, color: [255, 0, 0, 255] } });
    expect(calls).toContainEqual({ kind: "fill_active_layer", arg: { docId: 1, color: [0, 128, 0, 128] } });
    expect(useDocsStore.getState().compositeVersion[1]).toBe(2);
    expect(getPixels(1)?.[0]).toBe(20);
  });
});
