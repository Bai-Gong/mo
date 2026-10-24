/**
 * 文档模型类型：M1「查看与文档」+ M2「图层与选区」的前端契约（M4 起图层
 * 分种类：栅格/调整/文字）。
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

/** 工具集：抓手（平移）/ 吸管（取色）/ 矩形·椭圆·套索选区（M2）/
 * 画笔·橡皮·裁剪（M3）/ 文字（M4）。 */
export type Tool =
  | "hand"
  | "eyedropper"
  | "marquee-rect"
  | "marquee-ellipse"
  | "lasso"
  | "brush"
  | "eraser"
  | "crop"
  | "text";

/** M2 混合模式名（Rust `BlendMode::parse` 的字符串契约）。 */
export type BlendModeName = "normal" | "multiply" | "screen" | "overlay";

/**
 * M4 调整参数（Rust `Adjustment` 的 serde 契约，tag=type）：
 * 亮度（amount -1..1）/ 曲线（控制点 0..255，x 严格递增）/ 色相（度）。
 */
export type AdjustmentSpec =
  | { type: "brightness"; amount: number }
  | { type: "curves"; points: [number, number][] }
  | { type: "hue"; degrees: number };

/** 调整种类显示名（面板徽标与参数标签共用）。 */
export const ADJUSTMENT_TYPE_LABELS: Record<AdjustmentSpec["type"], string> = {
  brightness: "亮度",
  curves: "曲线",
  hue: "色相",
};

/** M4 文字图层内容（Rust `TextSpec` 契约，camelCase）。 */
export interface TextSpec {
  text: string;
  family: string;
  /** 字号（px，Rust 钳 4–512）。 */
  size: number;
  /** RGBA。 */
  color: [number, number, number, number];
  /** 首行基线左端点 x（图像坐标）。 */
  x: number;
  /** 首行基线左端点 y（图像坐标）。 */
  y: number;
}

/**
 * 图层种类（Rust `LayerKindInfo` 契约，tag=kind）：栅格 / 调整（带参数回传，
 * 供调整面板编辑）/ 文字（带内容回传，供选项栏编辑）。
 */
export type LayerKindMeta =
  | { kind: "raster" }
  | { kind: "adjustment"; adjustment: AdjustmentSpec }
  | { kind: "text"; spec: TextSpec };

/** 图层元信息（Rust `get_layers`/各图层命令返回的 LayersSnapshot 行）。 */
export interface LayerMeta {
  id: number;
  name: string;
  visible: boolean;
  /** 0–1（UI 显示为百分比）。 */
  opacity: number;
  blendMode: BlendModeName;
  kind: LayerKindMeta;
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

/**
 * 历史面板快照（Rust `HistoryInfo` 契约，M3）：entries 为条目标签序列
 * （自最早幸存条目起，超上限丢最旧），index 为已应用条数（0 = 初始状态）。
 */
export interface HistoryMeta {
  entries: string[];
  index: number;
}

/** 画笔/橡皮笔画参数（paint_stroke 命令契约；points 为图像坐标折线）。 */
export interface StrokeParams {
  points: [number, number][];
  /** 半径（px）。前端「笔刷大小」为直径，传 size/2。 */
  radius: number;
  /** RGBA；橡皮路径下 alpha 当擦除强度。 */
  color: [number, number, number, number];
  /** true = 橡皮（destination-out），false = 画笔（source-over）。 */
  erase: boolean;
}
