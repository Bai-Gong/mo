/**
 * 打开→查看→另存 编排层测试（M1 准入场景的状态层部分）：
 * 注入假 io 走真实 openPipeline/store/pixelStore 代码路径——标签、像素驻留、
 * 放大到像素级取色、另存参数、关闭释放全链路。
 * Rust 侧编解码本身由 src-tauri/src/imageio.rs 的真实文件 roundtrip 测试兜住。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeDoc,
  fileNameOf,
  openImagePath,
  saveDocAs,
  type ImageIo,
  type OpenedImagePayload,
} from "./openPipeline";
import { useDocsStore } from "./store";
import { clearPixelStore, getPixels } from "./pixelStore";
import { pickPixel } from "../canvas/pixelPicker";
import { screenToImage } from "../canvas/coords";
import { MAX_ZOOM } from "../canvas/fit";

/** 2×2 真实尺寸的假负载：与 Rust 侧 RGBA8 布局一致（w*h*4）。 */
function payloadOf(docId: number, w: number, h: number): OpenedImagePayload {
  const pixels = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = (i / 4) % w; // r = x
    pixels[i + 1] = Math.floor(i / 4 / w); // g = y
    pixels[i + 2] = 128;
    pixels[i + 3] = 255;
  }
  return { docId, width: w, height: h, hasIcc: true, format: "png", pixels };
}

interface Call {
  kind: "open" | "save" | "close";
  arg: unknown;
}

function makeIo(): { io: ImageIo; calls: Call[] } {
  const calls: Call[] = [];
  const io: ImageIo = {
    async openImageFile(path) {
      calls.push({ kind: "open", arg: path });
      if (path.includes("坏文件")) throw new Error("解码失败：无法识别图像格式");
      // 每个路径给一个稳定 docId（按调用序 1 起，模拟 Rust 注册表）
      const docId = calls.filter((c) => c.kind === "open").length;
      return payloadOf(docId, 4, 3);
    },
    async saveImageFile(input) {
      calls.push({ kind: "save", arg: input });
    },
    async closeImageFile(docId) {
      calls.push({ kind: "close", arg: docId });
    },
  };
  return { io, calls };
}

function resetAll() {
  useDocsStore.setState({
    docs: [],
    activeId: null,
    views: {},
    tool: "eyedropper",
    cursor: null,
    hoverColor: null,
    pickedColor: null,
    viewportSize: null,
    message: null,
  });
  clearPixelStore();
}

beforeEach(resetAll);

describe("fileNameOf", () => {
  it("Windows 反斜杠与正斜杠都取基名", () => {
    expect(fileNameOf("C:\\Users\\图\\照片.jpg")).toBe("照片.jpg");
    expect(fileNameOf("/home/u/a.png")).toBe("a.png");
    expect(fileNameOf("b.jpeg")).toBe("b.jpeg");
  });
});

describe("打开 → 查看（放大到像素级）→ 取色", () => {
  it("全链路：标签、像素驻留、fit、像素级缩放、吸管取色", async () => {
    const { io } = makeIo();
    const meta = await openImagePath("C:\\pics\\渐变.png", io);

    // 标签与元信息
    expect(meta.name).toBe("渐变.png");
    const s1 = useDocsStore.getState();
    expect(s1.docs).toHaveLength(1);
    expect(s1.activeId).toBe(1);
    expect(s1.docs[0]).toMatchObject({ width: 4, height: 3, hasIcc: true, format: "png" });

    // 像素驻留（RGBA8，w*h*4）
    const pixels = getPixels(1);
    expect(pixels).toBeDefined();
    expect(pixels?.length).toBe(4 * 3 * 4);

    // 画布局后自动 fit：min(400/4, 300/3)=100 触顶钳到 MAX_ZOOM(32)——小图进大窗
    useDocsStore.getState().setViewportSize({ width: 400, height: 300 });
    expect(useDocsStore.getState().views[1]?.zoom).toBe(MAX_ZOOM);

    // 放大到像素级（3200%）后取屏幕点换算图像格点
    const view = useDocsStore.getState().views[1];
    expect(view?.zoom).toBe(MAX_ZOOM);

    // 图像在视口中的范围：panX=(400-4*32)/2=136 起、panY=(300-3*32)/2=102 起；
    // 屏幕点 (200,150) → 图像 (2, 1.5) → 格点 (2,1)
    const pt = screenToImage(200, 150, view!);
    const x = Math.floor(pt.x);
    const y = Math.floor(pt.y);
    expect({ x, y }).toEqual({ x: 2, y: 1 });
    // 吸管取色（本管线像素 r=x, g=y, b=128）
    const picked = pickPixel(pixels!, 4, 3, x, y);
    expect(picked).toEqual({ r: 2, g: 1, b: 128, a: 255 });
    useDocsStore.getState().pickColor(picked!);
    expect(useDocsStore.getState().pickedColor).toEqual(picked);
  });

  it("多文件多标签：id 互异、切换激活", async () => {
    const { io } = makeIo();
    await openImagePath("/a/一.png", io);
    await openImagePath("/b/二.png", io);
    const s = useDocsStore.getState();
    expect(s.docs.map((d) => d.name)).toEqual(["一.png", "二.png"]);
    expect(s.activeId).toBe(2);
    expect(getPixels(1)).toBeDefined();
    expect(getPixels(2)).toBeDefined();
  });

  it("打开失败：异常上抛、不留半开标签", async () => {
    const { io } = makeIo();
    await expect(openImagePath("/x/坏文件.png", io)).rejects.toThrow("解码失败");
    expect(useDocsStore.getState().docs).toEqual([]);
    expect(getPixels(1)).toBeUndefined();
  });
});

describe("另存", () => {
  it("saveDocAs 默认质量 95，参数原样下传", async () => {
    const { io, calls } = makeIo();
    await openImagePath("/a/原图.jpg", io);
    await saveDocAs({ docId: 1, path: "/out/另存.png", format: "png" }, io);
    expect(calls).toContainEqual({
      kind: "save",
      arg: { docId: 1, path: "/out/另存.png", format: "png", quality: 95 },
    });
  });

  it("JPEG 指定质量原样传递", async () => {
    const { io, calls } = makeIo();
    await openImagePath("/a/原图.png", io);
    await saveDocAs({ docId: 1, path: "/out/另存.jpg", format: "jpeg", quality: 90 }, io);
    expect(calls).toContainEqual({
      kind: "save",
      arg: { docId: 1, path: "/out/另存.jpg", format: "jpeg", quality: 90 },
    });
  });
});

describe("关闭（两端释放）", () => {
  it("关标签：前端像素删除 + Rust close_document 下传 + 活动让位", async () => {
    const { io, calls } = makeIo();
    await openImagePath("/a/一.png", io);
    await openImagePath("/b/二.png", io);
    await closeDoc(2, io);

    const s = useDocsStore.getState();
    expect(s.docs.map((d) => d.id)).toEqual([1]);
    expect(s.activeId).toBe(1); // 左邻接替
    expect(getPixels(2)).toBeUndefined();
    expect(calls).toContainEqual({ kind: "close", arg: 2 });
  });

  it("Rust 侧释放失败不阻塞 UI（标签已关，异常上抛由调用方提示）", async () => {
    const { io } = makeIo();
    const failing: ImageIo = {
      ...io,
      closeImageFile: vi.fn(async () => {
        throw new Error("文档不存在");
      }),
    };
    await openImagePath("/a/一.png", failing);
    await expect(closeDoc(1, failing)).rejects.toThrow("文档不存在");
    // 标签与像素已经清掉（UI 态不被 Rust 失败回滚）
    expect(useDocsStore.getState().docs).toEqual([]);
    expect(getPixels(1)).toBeUndefined();
  });
});
