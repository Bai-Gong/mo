/**
 * imageIo 的 IPC 接线测试：mock @tauri-apps/api/core，锁定
 * 命令名、camelCase 参数与 ArrayBuffer → Uint8ClampedArray 的像素通道。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { tauriImageIo } from "./imageIo";

beforeEach(() => {
  invokeMock.mockReset();
});

describe("tauriImageIo", () => {
  it("openImageFile：open_image → get_pixels 两跳，像素转 Uint8ClampedArray", async () => {
    const rgba = new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]);
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "open_image") {
        expect(args).toEqual({ path: "C:/图/样张.png" });
        return { docId: 7, width: 2, height: 1, hasIcc: true, format: "png" };
      }
      if (cmd === "get_pixels") {
        expect(args).toEqual({ docId: 7 }); // rust doc_id ← camelCase docId
        return rgba.buffer;
      }
      throw new Error(`意外的命令：${cmd}`);
    });

    const payload = await tauriImageIo.openImageFile("C:/图/样张.png");
    expect(payload.docId).toBe(7);
    expect(payload.width).toBe(2);
    expect(payload.height).toBe(1);
    expect(payload.hasIcc).toBe(true);
    expect(payload.format).toBe("png");
    expect(payload.pixels).toBeInstanceOf(Uint8ClampedArray);
    expect(Array.from(payload.pixels)).toEqual(Array.from(rgba));
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("saveImageFile：save_document 一次性带全参数（quality 必传）", async () => {
    invokeMock.mockResolvedValue(undefined);
    await tauriImageIo.saveImageFile({ docId: 7, path: "D:/out/x.jpg", format: "jpeg", quality: 90 });
    expect(invokeMock).toHaveBeenCalledWith("save_document", {
      docId: 7,
      path: "D:/out/x.jpg",
      format: "jpeg",
      quality: 90,
    });
  });

  it("closeImageFile：close_document 传 docId", async () => {
    invokeMock.mockResolvedValue(true);
    await tauriImageIo.closeImageFile(7);
    expect(invokeMock).toHaveBeenCalledWith("close_document", { docId: 7 });
  });

  it("Rust 错误（字符串 Err）原样上抛", async () => {
    invokeMock.mockRejectedValue("无法打开文件：系统找不到指定的路径");
    await expect(tauriImageIo.openImageFile("C:/不存在.png")).rejects.toBe(
      "无法打开文件：系统找不到指定的路径",
    );
  });
});
