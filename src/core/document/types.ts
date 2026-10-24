/**
 * 文档模型类型：M1「查看与文档」+ M2「图层与选区」的前端契约。
 *
 * 元信息进 zustand（响应式）；像素本体刻意不进 store——大缓冲放
 * pixelStore（普通 Map），避免每次取色/移动光标触发全量重渲染。
 */

/** 打开的图像文档（前端视角）。像素事实源在 Rust 侧（src-tauri/src/imageio.rs）。 */
export interface ImageDocMeta {
  /** Rust 文档注册表 id（open_image 返回）。 */
  id: number;
  /** 标签名：文件基名（含扩展名）。 */
  name: string;
  width: number;
  height: number;
  /** 来源格式名（"png" / "jpeg"），另存对话框的默认扩展。 */
  format: string;
  /** 打开时是否携带 ICC 色彩配置（另存时 Rust 侧原样写回）。 */
  hasIcc: boolean;
  /** 打开时的完整路径（另存对话框 defaultPath）。 */
  path: string;
}

/** M2 工具集：抓手（平移画布）/ 吸管（取色）/ 矩形选框 / 椭圆选框 / 套索。 */
export type Tool = "hand" | "eyedropper" | "marquee-rect" | "marquee-ellipse" | "lasso";

/** M2 混合模式名（Rust `BlendMode::parse` 的字符串契约）。 */
export type BlendModeName = "normal" | "multiply" | "screen" | "overlay";

/** 图层元信息（Rust `get_layers`/各图层命令返回的 LayersSnapshot 行）。 */
export interface LayerMeta {
  id: number;
  name: string;
  visible: boolean;
  /** 0–1（UI 显示为百分比）。 */
  opacity: number;
  blendMode: BlendModeName;
}

/** 面板显示名（下拉选项共用）。 */
export const BLEND_MODE_LABELS: ReadonlyArray<{ value: BlendModeName; label: string }> = [
  { value: "normal", label: "正常" },
  { value: "multiply", label: "正片叠底" },
  { value: "screen", label: "滤色" },
  { value: "overlay", label: "叠加" },
];

/**
 * 单文档视口：zoom 以 1 = 100% 计（钳制范围见 canvas/fit.ts），
 * pan 为图像左上角在画布视口中的像素偏移。
 */
export interface Viewport {
  zoom: number;
  panX: number;
  panY: number;
}
