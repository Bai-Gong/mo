/**
 * Rust 图像命令的真实 IPC 绑定（src-tauri/src/imageio.rs 的前端契约）。
 * - open_image → 元信息（camelCase，serde rename_all）；
 * - get_pixels → tauri::ipc::Response 原始字节通道，invoke 直接得 ArrayBuffer；
 * - save_document / close_document → 常规 JSON 命令。
 */
import { invoke } from "@tauri-apps/api/core";
// 只引类型避免运行时环（openPipeline 静态引本文件的 tauriImageIo 作默认 io）。
import type { ImageIo, OpenedImagePayload } from "./openPipeline";

interface OpenImageInfo {
  docId: number;
  width: number;
  height: number;
  hasIcc: boolean;
  format: string;
}

export const tauriImageIo: ImageIo = {
  async openImageFile(path: string): Promise<OpenedImagePayload> {
    const info = await invoke<OpenImageInfo>("open_image", { path });
    const buffer = await invoke<ArrayBuffer>("get_pixels", { docId: info.docId });
    return { ...info, pixels: new Uint8ClampedArray(buffer) };
  },

  async saveImageFile({ docId, path, format, quality }) {
    await invoke("save_document", { docId, path, format, quality });
  },

  async closeImageFile(docId: number) {
    await invoke("close_document", { docId });
  },
};
