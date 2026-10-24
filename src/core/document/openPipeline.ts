/**
 * 文档打开/关闭/另存的编排层：Rust 命令（imageIo）↔ 像素驻留（pixelStore）↔ 状态（store）。
 *
 * io 以接口注入（默认 tauriImageIo）：真实管线在 Tauri IPC 上，测试注入假 io
 * 即可走全编排逻辑（标签/像素/关闭释放），编解码本身由 Rust 侧 roundtrip 测试兜住。
 */
import type { ImageDocMeta } from "./types";
import { deletePixels, setPixels } from "./pixelStore";
import { useDocsStore } from "./store";
import { tauriImageIo } from "./imageIo";

/** open_image + get_pixels 拉回前端的负载（像素为 RGBA8）。 */
export interface OpenedImagePayload {
  docId: number;
  width: number;
  height: number;
  hasIcc: boolean;
  format: string;
  pixels: Uint8ClampedArray;
}

/** Rust 图像命令面的前端抽象（imageIo.ts 提供真实实现）。 */
export interface ImageIo {
  openImageFile(path: string): Promise<OpenedImagePayload>;
  /** M2 新建文档（背景层纯色或透明）。 */
  createDocument(input: {
    width: number;
    height: number;
    background: [number, number, number, number] | null;
  }): Promise<OpenedImagePayload>;
  saveImageFile(input: {
    docId: number;
    path: string;
    format: "png" | "jpeg";
    quality: number;
  }): Promise<void>;
  closeImageFile(docId: number): Promise<void>;
}

/** 路径 → 文件基名（Windows 反斜杠与正斜杠都认）。 */
export function fileNameOf(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

function openPayloadAsTab(payload: OpenedImagePayload, name: string, path: string): ImageDocMeta {
  setPixels(payload.docId, payload.pixels);
  const meta: ImageDocMeta = {
    id: payload.docId,
    name,
    width: payload.width,
    height: payload.height,
    format: payload.format,
    hasIcc: payload.hasIcc,
    path,
  };
  useDocsStore.getState().openTab(meta);
  return meta;
}

/** 打开一个文件为标签：像素驻留 + 元信息入 store + 激活。 */
export async function openImagePath(
  path: string,
  io: ImageIo = tauriImageIo,
): Promise<ImageDocMeta> {
  const payload = await io.openImageFile(path);
  return openPayloadAsTab(payload, fileNameOf(path), path);
}

/** 新建空白文档为标签（M2 海报/图层玩法起点）。标签名按打开序编号。 */
export async function createDocumentTab(
  input: { width: number; height: number; background: [number, number, number, number] | null },
  io: ImageIo = tauriImageIo,
): Promise<ImageDocMeta> {
  const payload = await io.createDocument(input);
  const seq = useDocsStore.getState().docs.length + 1;
  return openPayloadAsTab(payload, `未命名-${seq}.png`, "");
}

/** 关闭标签并释放两端内存（前端像素 + Rust 驻留文档）。 */
export async function closeDoc(
  id: number,
  io: ImageIo = tauriImageIo,
): Promise<void> {
  deletePixels(id);
  useDocsStore.getState().closeTab(id);
  await io.closeImageFile(id);
}

/** 另存（quality 仅 JPEG 生效，1–100，默认 95）。ICC 由 Rust 侧按文档原样写回。 */
export async function saveDocAs(
  input: { docId: number; path: string; format: "png" | "jpeg"; quality?: number },
  io: ImageIo = tauriImageIo,
): Promise<void> {
  await io.saveImageFile({
    docId: input.docId,
    path: input.path,
    format: input.format,
    quality: input.quality ?? 95,
  });
}
