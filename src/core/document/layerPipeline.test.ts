/**
 * 图层/选区/绘制/历史编排层测试（M2 + M3 准入场景的前端状态层部分）：
 * 注入假 layerIo 走真实 layerPipeline/store/pixelStore 代码路径——EditResult
 * （图层+历史快照+尺寸）落位、合成像素重拉 + 版本 bump、选区回显、命令下传
 * 参数全链路；M3 起含画笔/裁剪/撤销重做跳转的编排与「绘制→撤销→重做→继续
 * 绘制」准入场景。像素与历史事实本身由 src-tauri 的 paint.rs / history.rs /
 * layers.rs / imageio.rs 真实测试兜住（含从零画图导出 PNG 的准入场景）。
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { EditResult, LayerIo, LayersSnapshot } from "./layerIo";
import type { HistoryMeta, LayerMeta, StrokeParams, TextSpec } from "./types";
import type { SelectionShape } from "../canvas/selection";
import {
  activateLayer,
  addAdjustmentLayer,
  addLayer,
  addTextLayer,
  commitSelection,
  cropDoc,
  deleteLayer,
  deselect,
  fillSelection,
  jumpHistory,
  moveLayer,
  paintStroke,
  redo,
  refreshHistory,
  selectAll,
  setAdjustmentParams,
  setLayerBlendMode,
  setLayerOpacity,
  setLayerVisible,
  setTextLayer,
  undo,
} from "./layerPipeline";
import { useDocsStore } from "./store";
import { clearPixelStore, getPixels, setPixels } from "./pixelStore";
import type { ImageDocMeta } from "./types";

function layer(id: number, name: string, over: Partial<LayerMeta> = {}): LayerMeta {
  return { id, name, visible: true, opacity: 1, blendMode: "normal", kind: { kind: "raster" }, ...over };
}

function snap(layers: LayerMeta[], activeLayerId: number): LayersSnapshot {
  return { layers, activeLayerId };
}

function edit(
  layers: LayersSnapshot,
  history: HistoryMeta,
  width = 8,
  height = 6,
): EditResult {
  return { layers, history, width, height };
}

interface Call {
  kind: string;
  arg: unknown;
}

/**
 * 假 layerIo：记录命令序列；EditResult 按脚本演化（mutating 命令依次弹一个）。
 */
function makeLayerIo(script: {
  results: EditResult[]; // 每次 mutating 命令弹一个；耗尽后重复最后一个
  pixelsFor: (docId: number) => Uint8ClampedArray;
  history?: HistoryMeta; // getHistory 返回（refreshHistory 用）
}) {
  const calls: Call[] = [];
  let cursor = 0;
  const next = () => {
    const r = script.results[Math.min(cursor, script.results.length - 1)]!;
    cursor += 1;
    return r;
  };
  const mutating = (kind: string, arg: unknown) => {
    calls.push({ kind, arg });
    return Promise.resolve(next());
  };
  const io: LayerIo = {
    async getLayers(docId) {
      calls.push({ kind: "get_layers", arg: docId });
      return script.results[Math.max(0, cursor - 1)]?.layers ?? snap([], 0);
    },
    addLayer: (docId) => mutating("add_layer", docId),
    deleteLayer: (docId, layerId) => mutating("delete_layer", { docId, layerId }),
    moveLayer: (docId, layerId, toIndex) => mutating("move_layer", { docId, layerId, toIndex }),
    setLayerVisible: (docId, layerId, visible) =>
      mutating("set_layer_visible", { docId, layerId, visible }),
    setLayerOpacity: (docId, layerId, opacity) =>
      mutating("set_layer_opacity", { docId, layerId, opacity }),
    setLayerBlendMode: (docId, layerId, mode) =>
      mutating("set_layer_blend_mode", { docId, layerId, mode }),
    async setActiveLayer(docId, layerId) {
      calls.push({ kind: "set_active_layer", arg: { docId, layerId } });
      return script.results[Math.max(0, cursor - 1)]?.layers ?? snap([], 0);
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
    fillActiveLayer: (docId, color) => mutating("fill_active_layer", { docId, color }),
    paintStroke: (docId, stroke) => mutating("paint_stroke", { docId, stroke }),
    cropDocument: (docId, rect) => mutating("crop_document", { docId, rect }),
    addAdjustmentLayer: (docId, adjustment) =>
      mutating("add_adjustment_layer", { docId, adjustment }),
    setAdjustmentParams: (docId, layerId, adjustment) =>
      mutating("set_adjustment_params", { docId, layerId, adjustment }),
    addTextLayer: (docId, spec) => mutating("add_text_layer", { docId, spec }),
    setTextLayer: (docId, layerId, spec) =>
      mutating("set_text_layer", { docId, layerId, spec }),
    async fontFamilies() {
      calls.push({ kind: "font_families", arg: null });
      return ["微软雅黑"];
    },
    undo: (docId) => mutating("undo", docId),
    redo: (docId) => mutating("redo", docId),
    historyJump: (docId, target) => mutating("history_jump", { docId, target }),
    async getHistory(docId) {
      calls.push({ kind: "get_history", arg: docId });
      return script.history ?? { entries: [], index: 0 };
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
  });
  clearPixelStore();
}

beforeEach(resetAll);

describe("图层命令编排", () => {
  it("加层：EditResult 落 store（图层 + 历史），不改合成（不重拉像素）", async () => {
    openDoc(1);
    const history: HistoryMeta = { entries: ["新建图层"], index: 1 };
    const { io, calls } = makeLayerIo({
      results: [edit(snap([layer(1, "背景"), layer(2, "图层 1")], 2), history)],
      pixelsFor: () => new Uint8ClampedArray(8 * 6 * 4),
    });
    await addLayer(1, io);

    const s = useDocsStore.getState();
    expect(s.layers[1]?.map((l) => l.name)).toEqual(["背景", "图层 1"]);
    expect(s.activeLayerId[1]).toBe(2);
    expect(s.compositeVersion[1]).toBe(0); // 空层不改合成
    expect(s.history[1]).toEqual(history); // 历史快照同帧落位
    expect(calls.map((c) => c.kind)).toEqual(["add_layer"]);
  });

  it("删层/排序/可见性/不透明度/混合模式：快照+历史落位，合成重拉（版本 bump）", async () => {
    openDoc(1);
    const history: HistoryMeta = { entries: ["删除图层", "排列图层", "隐藏图层", "不透明度", "混合模式"], index: 5 };
    const after = edit(snap([layer(1, "背景")], 1), history);
    const { io, calls } = makeLayerIo({
      results: [after, after, after, after, after],
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
    expect(s.history[1]).toEqual(history);
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

  it("设活动图层：只落图层快照，不重拉像素", async () => {
    openDoc(1);
    const { io, calls } = makeLayerIo({
      results: [edit(snap([layer(1, "背景"), layer(2, "图层 1")], 1), { entries: [], index: 0 })],
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
      results: [edit(snap([layer(1, "背景")], 1), { entries: [], index: 0 })],
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
      results: [edit(snap([layer(1, "背景")], 1), { entries: [], index: 0 })],
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
      results: [edit(snap([layer(1, "背景")], 1), { entries: [], index: 0 })],
      pixelsFor: () => new Uint8ClampedArray(4),
    });
    useDocsStore.getState().setSelectionEcho(1, { kind: "rect", x: 0, y: 0, w: 3, h: 3 });
    await deselect(1, io);
    expect(useDocsStore.getState().selection[1]).toBeNull();
    expect(calls).toContainEqual({ kind: "deselect", arg: 1 });
  });
});

describe("填充与绘制编排", () => {
  it("填充活动图层：颜色下传 + 历史/合成落位 + 驻留更新", async () => {
    openDoc(1);
    let fillCount = 0;
    const { io, calls } = makeLayerIo({
      results: [
        edit(snap([layer(1, "背景")], 1), { entries: ["填充"], index: 1 }),
        edit(snap([layer(1, "背景")], 1), { entries: ["填充", "填充"], index: 2 }),
      ],
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
    expect(useDocsStore.getState().history[1]?.index).toBe(2);
    expect(getPixels(1)?.[0]).toBe(20);
  });

  it("画笔一笔：笔画参数下传（半径 = 笔刷大小/2）+ 历史/合成落位", async () => {
    openDoc(1);
    useDocsStore.getState().setBrushSize(12);
    useDocsStore.getState().pickColor({ r: 10, g: 20, b: 30, a: 255 });
    const { io, calls } = makeLayerIo({
      results: [edit(snap([layer(1, "背景")], 1), { entries: ["画笔"], index: 1 })],
      pixelsFor: () => {
        const p = new Uint8ClampedArray(8 * 6 * 4);
        p.fill(9);
        return p;
      },
    });
    const stroke: StrokeParams = {
      points: [[1.5, 2.5], [5.5, 2.5]],
      radius: 6,
      color: [10, 20, 30, 255],
      erase: false,
    };
    await paintStroke(1, stroke, io);

    expect(calls).toContainEqual({ kind: "paint_stroke", arg: { docId: 1, stroke } });
    expect(useDocsStore.getState().history[1]).toEqual({ entries: ["画笔"], index: 1 });
    expect(useDocsStore.getState().compositeVersion[1]).toBe(1);
    expect(getPixels(1)?.[0]).toBe(9);
  });
});

describe("历史编排（撤销/重做/跳转/拉取）", () => {
  it("撤销重做：历史与图层快照落位 + 合成重拉", async () => {
    openDoc(1);
    const { io, calls } = makeLayerIo({
      results: [
        edit(snap([layer(1, "背景")], 1), { entries: ["画笔", "画笔"], index: 1 }),
        edit(snap([layer(1, "背景")], 1), { entries: ["画笔", "画笔"], index: 2 }),
      ],
      pixelsFor: () => new Uint8ClampedArray(8 * 6 * 4),
    });
    await undo(1, io);
    await redo(1, io);

    expect(calls.map((c) => c.kind)).toEqual(["undo", "get_pixels", "redo", "get_pixels"]);
    const s = useDocsStore.getState();
    expect(s.history[1]).toEqual({ entries: ["画笔", "画笔"], index: 2 });
    expect(s.compositeVersion[1]).toBe(2);
  });

  it("跳转：target 下传 + 状态落位（历史面板点条目的路径）", async () => {
    openDoc(1);
    const { io, calls } = makeLayerIo({
      results: [edit(snap([layer(1, "背景")], 1), { entries: ["画笔", "填充", "裁剪"], index: 1 })],
      pixelsFor: () => new Uint8ClampedArray(8 * 6 * 4),
    });
    await jumpHistory(1, 1, io);
    expect(calls).toContainEqual({ kind: "history_jump", arg: { docId: 1, target: 1 } });
    expect(useDocsStore.getState().history[1]?.index).toBe(1);
  });

  it("裁剪：尺寸变化同步文档元信息并回到「适合窗口」", async () => {
    openDoc(1, 8, 6);
    useDocsStore.getState().setViewportSize({ width: 400, height: 300 });
    useDocsStore.getState().ensureView(1);
    expect(useDocsStore.getState().views[1]).not.toBeNull();

    const { io, calls } = makeLayerIo({
      results: [edit(snap([layer(1, "背景")], 1), { entries: ["裁剪"], index: 1 }, 5, 4)],
      pixelsFor: () => new Uint8ClampedArray(5 * 4 * 4),
    });
    await cropDoc(1, { x: 1, y: 1, w: 5, h: 4 }, io);

    expect(calls).toContainEqual({
      kind: "crop_document",
      arg: { docId: 1, rect: { x: 1, y: 1, w: 5, h: 4 } },
    });
    const s = useDocsStore.getState();
    expect(s.docs.find((d) => d.id === 1)).toMatchObject({ width: 5, height: 4 });
    expect(s.views[1]).toBeNull(); // 尺寸变了 → 待「适合窗口」
    expect(s.compositeVersion[1]).toBe(1);
  });

  it("refreshHistory：面板拉取落位", async () => {
    openDoc(1);
    const { io, calls } = makeLayerIo({
      results: [edit(snap([layer(1, "背景")], 1), { entries: [], index: 0 })],
      pixelsFor: () => new Uint8ClampedArray(4),
      history: { entries: ["画笔", "填充"], index: 1 },
    });
    await refreshHistory(1, io);
    expect(calls).toContainEqual({ kind: "get_history", arg: 1 });
    expect(useDocsStore.getState().history[1]).toEqual({ entries: ["画笔", "填充"], index: 1 });
  });
});

describe("M3 准入场景（编排层）：从零画图 → 撤销 → 重做 → 继续绘制", () => {
  /**
   * 前端状态层走全编排路径（假 io 只替换 IPC 边界）：
   * 新建 → 画笔一笔 → 画错一笔 → 撤销 → 重做 → 继续画一笔 → 历史面板跳回再跳前。
   * 像素/历史语义的同一场景在 Rust 侧真实管线测试（imageio.rs
   * `m3_准入_从零画图_…`）兜底。
   */
  it("绘制 → 撤销 → 重做 → 继续绘制：历史/图层/合成全链路一致", async () => {
    openDoc(1, 96, 64);
    const base = snap([layer(1, "背景")], 1);

    // 脚本：每个 mutating 命令的返回按顺序弹（历史条目随之增长）
    const results: EditResult[] = [
      edit(base, { entries: ["画笔"], index: 1 }),              // 第一笔（正确）
      edit(base, { entries: ["画笔", "画笔"], index: 2 }),       // 第二笔（画错）
      edit(base, { entries: ["画笔", "画笔"], index: 1 }),       // undo
      edit(base, { entries: ["画笔", "画笔"], index: 2 }),       // redo
      edit(base, { entries: ["画笔", "画笔", "画笔"], index: 3 }), // 继续绘制
      edit(base, { entries: ["画笔", "画笔", "画笔"], index: 1 }), // history_jump 1
      edit(base, { entries: ["画笔", "画笔", "画笔"], index: 3 }), // history_jump 3
    ];
    const { io, calls } = makeLayerIo({
      results,
      pixelsFor: () => {
        const p = new Uint8ClampedArray(96 * 64 * 4);
        return p;
      },
    });

    const stroke1: StrokeParams = { points: [[8, 44], [88, 44]], radius: 2, color: [34, 139, 34, 255], erase: false };
    const stroke2: StrokeParams = { points: [[60, 8], [92, 2]], radius: 2.5, color: [255, 0, 0, 255], erase: false };
    const stroke3: StrokeParams = { points: [[8, 54], [88, 54]], radius: 1.5, color: [30, 90, 210, 255], erase: false };

    await paintStroke(1, stroke1, io); // 绘制（正确的一笔）
    await paintStroke(1, stroke2, io); // 绘制（画错的一笔）
    expect(useDocsStore.getState().history[1]).toEqual({ entries: ["画笔", "画笔"], index: 2 });

    await undo(1, io); // 撤销（回退错误的一笔）
    expect(useDocsStore.getState().history[1]?.index).toBe(1);

    await redo(1, io); // 重做（保留太阳）
    expect(useDocsStore.getState().history[1]?.index).toBe(2);

    await paintStroke(1, stroke3, io); // 继续绘制
    expect(useDocsStore.getState().history[1]).toEqual({
      entries: ["画笔", "画笔", "画笔"],
      index: 3,
    });

    await jumpHistory(1, 1, io); // 历史面板：跳回「只有第一笔」
    expect(useDocsStore.getState().history[1]?.index).toBe(1);
    await jumpHistory(1, 3, io); // 跳回最前
    expect(useDocsStore.getState().history[1]?.index).toBe(3);

    // 命令序列与下传参数（真实管线入口）
    expect(calls.map((c) => c.kind)).toEqual([
      "paint_stroke",
      "get_pixels",
      "paint_stroke",
      "get_pixels",
      "undo",
      "get_pixels",
      "redo",
      "get_pixels",
      "paint_stroke",
      "get_pixels",
      "history_jump",
      "get_pixels",
      "history_jump",
      "get_pixels",
    ]);
    expect(calls).toContainEqual({ kind: "paint_stroke", arg: { docId: 1, stroke: stroke1 } });
    expect(calls).toContainEqual({ kind: "undo", arg: 1 });
    expect(calls).toContainEqual({ kind: "redo", arg: 1 });
    expect(calls).toContainEqual({ kind: "history_jump", arg: { docId: 1, target: 1 } });

    // 每次内容变化都重拉合成（画布随之刷新）
    expect(useDocsStore.getState().compositeVersion[1]).toBe(7);
  });
});

describe("M4 调整与文字编排", () => {
  const adjustLayer = (
    id: number,
    name: string,
    adjustment: import("./types").AdjustmentSpec,
    over: Partial<LayerMeta> = {},
  ): LayerMeta => layer(id, name, { kind: { kind: "adjustment", adjustment }, ...over });

  it("新建调整图层：参数下传 + 快照/历史落位 + 合成重拉（调整改变合成）", async () => {
    openDoc(1);
    const adjustment = { type: "hue", degrees: 30 } as const;
    const { io, calls } = makeLayerIo({
      results: [
        edit(
          snap([layer(1, "背景"), adjustLayer(2, "色相调整", adjustment)], 2),
          { entries: ["新建调整图层"], index: 1 },
        ),
      ],
      pixelsFor: () => new Uint8ClampedArray(8 * 6 * 4),
    });
    await addAdjustmentLayer(1, adjustment, io);

    const s = useDocsStore.getState();
    expect(s.layers[1]).toHaveLength(2);
    expect(s.layers[1]?.[1]?.kind).toEqual({ kind: "adjustment", adjustment });
    expect(s.activeLayerId[1]).toBe(2);
    expect(s.history[1]?.index).toBe(1);
    expect(s.compositeVersion[1]).toBe(1); // 调整层改变合成 → 重拉
    expect(calls).toContainEqual({ kind: "add_adjustment_layer", arg: { docId: 1, adjustment } });
  });

  it("改调整参数：layerId + 参数下传，合成重拉", async () => {
    openDoc(1);
    const { io, calls } = makeLayerIo({
      results: [edit(snap([layer(1, "背景")], 1), { entries: ["亮度参数"], index: 1 })],
      pixelsFor: () => new Uint8ClampedArray(8 * 6 * 4),
    });
    await setAdjustmentParams(1, 3, { type: "brightness", amount: 0.2 }, io);
    expect(calls).toContainEqual({
      kind: "set_adjustment_params",
      arg: { docId: 1, layerId: 3, adjustment: { type: "brightness", amount: 0.2 } },
    });
    expect(useDocsStore.getState().compositeVersion[1]).toBe(1);
    expect(useDocsStore.getState().history[1]?.entries).toEqual(["亮度参数"]);
  });

  it("新建/编辑文字图层：spec 下传、激活返回、合成重拉", async () => {
    openDoc(1);
    const spec: TextSpec = {
      text: "百工·墨",
      family: "黑体",
      size: 32,
      color: [255, 255, 255, 255],
      x: 12,
      y: 40,
    };
    const edited: TextSpec = { ...spec, text: "墨" };
    const textLayer = (id: number, s: TextSpec): LayerMeta =>
      layer(id, `文字：${s.text}`, { kind: { kind: "text", spec: s } });
    const { io, calls } = makeLayerIo({
      results: [
        edit(snap([layer(1, "背景"), textLayer(2, spec)], 2), { entries: ["新建文字图层"], index: 1 }),
        edit(snap([layer(1, "背景"), textLayer(2, edited)], 2), { entries: ["新建文字图层", "编辑文字"], index: 2 }),
      ],
      pixelsFor: () => new Uint8ClampedArray(8 * 6 * 4),
    });

    const activeId = await addTextLayer(1, spec, io);
    expect(activeId).toBe(2);
    expect(useDocsStore.getState().layers[1]?.[1]?.kind).toEqual({ kind: "text", spec });

    await setTextLayer(1, 2, edited, io);
    expect(useDocsStore.getState().layers[1]?.[1]?.kind).toEqual({ kind: "text", spec: edited });
    expect(useDocsStore.getState().history[1]?.index).toBe(2);
    expect(calls).toContainEqual({ kind: "add_text_layer", arg: { docId: 1, spec } });
    expect(calls).toContainEqual({ kind: "set_text_layer", arg: { docId: 1, layerId: 2, spec: edited } });
    expect(useDocsStore.getState().compositeVersion[1]).toBe(2);
  });
});
