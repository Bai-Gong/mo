/**
 * 像素驻留层：docId → RGBA8 缓冲（Rust get_pixels 的前端副本）。
 *
 * 普通模块级 Map，不进 zustand——像素是几十 MB 级缓冲且高频按点读取，
 * 响应式化只带来重渲染开销。UI 需要感知的是元信息与视口，不是像素本身。
 */
const buffers = new Map<number, Uint8ClampedArray>();

export function setPixels(id: number, data: Uint8ClampedArray): void {
  buffers.set(id, data);
}

export function getPixels(id: number): Uint8ClampedArray | undefined {
  return buffers.get(id);
}

export function deletePixels(id: number): boolean {
  return buffers.delete(id);
}

/** 测试用：清空全部驻留。 */
export function clearPixelStore(): void {
  buffers.clear();
}
