/**
 * 文档状态层测试：多标签、视口适配与缩放/平移语义（M1 准入的状态层部分）。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { selectActiveDoc, selectActiveView, useDocsStore } from "./store";
import { clearPixelStore, deletePixels, getPixels, setPixels } from "./pixelStore";
import type { ImageDocMeta } from "./types";
import { MAX_ZOOM, MIN_ZOOM } from "../canvas/fit";

function doc(id: number, w = 400, h = 300): ImageDocMeta {
  return {
    id,
    name: `图-${id}.png`,
    width: w,
    height: h,
    format: "png",
    hasIcc: false,
    path: `C:/pics/图-${id}.png`,
  };
}

/** 回到初始状态（zustand 单例 store，逐测试隔离）。 */
function resetStore() {
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
    cursor: null,
    hoverColor: null,
    pickedColor: null,
    viewportSize: null,
    message: null,
  });
}

beforeEach(() => {
  resetStore();
  clearPixelStore();
});

describe("多标签", () => {
  it("开两个文档：依次激活、id 互异", () => {
    const s = useDocsStore.getState();
    s.openTab(doc(1));
    s.openTab(doc(2));
    const state = useDocsStore.getState();
    expect(state.docs.map((d) => d.id)).toEqual([1, 2]);
    expect(state.activeId).toBe(2);
    s.setActive(1);
    expect(useDocsStore.getState().activeId).toBe(1);
  });

  it("关活动标签让位左邻；关非活动标签不动活动", () => {
    const s = useDocsStore.getState();
    s.openTab(doc(1));
    s.openTab(doc(2));
    s.openTab(doc(3));
    s.setActive(3);
    s.closeTab(3);
    expect(useDocsStore.getState().activeId).toBe(2); // 左邻

    s.closeTab(1); // 非活动
    expect(useDocsStore.getState().activeId).toBe(2);
    expect(useDocsStore.getState().docs.map((d) => d.id)).toEqual([2]);
  });

  it("关最后一个标签回到空态", () => {
    const s = useDocsStore.getState();
    s.openTab(doc(7));
    s.closeTab(7);
    const state = useDocsStore.getState();
    expect(state.docs).toEqual([]);
    expect(state.activeId).toBeNull();
    expect(state.views).toEqual({});
  });

  it("关活动标签清光标（悬停坐标不再指向已关文档）", () => {
    const s = useDocsStore.getState();
    s.openTab(doc(1));
    s.setCursor({ x: 3, y: 4 }, { r: 1, g: 2, b: 3, a: 255 });
    s.closeTab(1);
    expect(useDocsStore.getState().cursor).toBeNull();
  });
});

describe("视口适配（打开后自动适合窗口）", () => {
  it("视口尺寸未到时视图为 null，量到后 ensureView 落 fit 且居中", () => {
    const s = useDocsStore.getState();
    s.openTab(doc(1, 400, 300));
    expect(useDocsStore.getState().views[1]).toBeNull();

    s.setViewportSize({ width: 800, height: 600 }); // 未适配视图在此补齐
    const view = useDocsStore.getState().views[1];
    // contain: min(800/400, 600/300) = 2，恰满窗无留边
    expect(view).toEqual({ zoom: 2, panX: 0, panY: 0 });

    // ensureView 幂等：已适配的不再重算
    s.setViewportSize({ width: 400, height: 300 });
    expect(useDocsStore.getState().views[1]).toEqual({ zoom: 2, panX: 0, panY: 0 });
  });

  it("fitActive 重新适配当前文档（Ctrl+0）", () => {
    const s = useDocsStore.getState();
    s.openTab(doc(1, 400, 300));
    s.setViewportSize({ width: 800, height: 600 });
    s.setZoom(8); // 用户放大
    expect(useDocsStore.getState().views[1]?.zoom).toBe(8);
    s.fitActive();
    expect(useDocsStore.getState().views[1]?.zoom).toBe(2);
  });

  it("actualSizeActive 置 100% 并居中", () => {
    const s = useDocsStore.getState();
    s.openTab(doc(1, 400, 300));
    s.setViewportSize({ width: 800, height: 600 });
    s.actualSizeActive();
    expect(useDocsStore.getState().views[1]).toEqual({ zoom: 1, panX: 200, panY: 150 });
  });
});

describe("缩放/平移（像素级检视）", () => {
  function openedAndFitted() {
    const s = useDocsStore.getState();
    s.openTab(doc(1, 400, 300));
    s.setViewportSize({ width: 800, height: 600 });
    return useDocsStore.getState();
  }

  it("setZoom 以视口中心为锚，可放大到像素级（3200%）", () => {
    openedAndFitted();
    const s = useDocsStore.getState();
    s.setZoom(MAX_ZOOM);
    const view = selectActiveView(useDocsStore.getState());
    expect(view?.zoom).toBe(MAX_ZOOM);
    // 中心点（400,300）对应的图像内容在放大前后不变
    expect((400 - (view?.panX ?? 0)) / (view?.zoom ?? 1)).toBeCloseTo((400 - 0) / 2, 6);
  });

  it("zoomAt 锚点缩放：锚点图像内容不动", () => {
    openedAndFitted();
    const s = useDocsStore.getState();
    const before = selectActiveView(useDocsStore.getState())!;
    s.zoomAt(100, 80, 1.25);
    const after = selectActiveView(useDocsStore.getState())!;
    expect(after.zoom).toBeCloseTo(before.zoom * 1.25, 9);
    const ax = (100 - before.panX) / before.zoom;
    const bx = (100 - after.panX) / after.zoom;
    expect(bx).toBeCloseTo(ax, 9);
  });

  it("下限不低于 1%", () => {
    openedAndFitted();
    const s = useDocsStore.getState();
    s.setZoom(MIN_ZOOM / 10);
    expect(selectActiveView(useDocsStore.getState())?.zoom).toBe(MIN_ZOOM);
  });

  it("panBy 累加位移", () => {
    openedAndFitted();
    const s = useDocsStore.getState();
    s.panBy(10, -5);
    s.panBy(1, 1);
    const view = selectActiveView(useDocsStore.getState());
    expect(view).toEqual({ zoom: 2, panX: 11, panY: -4 });
  });
});

describe("工具与取色会话态", () => {
  it("切工具、取色、清空", () => {
    const s = useDocsStore.getState();
    s.setTool("eyedropper");
    expect(useDocsStore.getState().tool).toBe("eyedropper");
    s.pickColor({ r: 9, g: 8, b: 7, a: 255 });
    expect(useDocsStore.getState().pickedColor).toEqual({ r: 9, g: 8, b: 7, a: 255 });
  });

  it("setActive 清悬停（换标签后悬停坐标不跨文档）", () => {
    const s = useDocsStore.getState();
    s.openTab(doc(1));
    s.openTab(doc(2));
    s.setCursor({ x: 1, y: 1 }, null);
    s.setActive(1);
    const state = useDocsStore.getState();
    expect(state.cursor).toBeNull();
    expect(state.hoverColor).toBeNull();
  });
});

describe("selectActiveDoc / selectActiveView", () => {
  it("空态返回 undefined，不抛", () => {
    expect(selectActiveDoc(useDocsStore.getState())).toBeUndefined();
    expect(selectActiveView(useDocsStore.getState())).toBeUndefined();
  });
});

describe("像素驻留（pixelStore）", () => {
  it("set/get/delete 与标签生命周期一致", () => {
    setPixels(1, new Uint8ClampedArray(16));
    expect(getPixels(1)?.length).toBe(16);
    expect(getPixels(99)).toBeUndefined();
    expect(deletePixels(1)).toBe(true);
    expect(deletePixels(1)).toBe(false);
    expect(getPixels(1)).toBeUndefined();
  });
});
