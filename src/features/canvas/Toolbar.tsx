/**
 * 左侧工具栏（产品分析「左侧竖排工具栏」）：M1 抓手/吸管 + M2 选区三件套
 * （矩形选框/椭圆选框/套索）。单键切换（H/I/M/O/L，Photoshop 惯例）；
 * 按住空格临时抓手在 CanvasView 内处理。
 */
import { Hand, Pipette, Square, Circle, Lasso } from "lucide-react";
import { useHotkeys } from "@baigong/fang";
import { useDocsStore } from "../../core/document/store";
import type { Tool } from "../../core/document/types";

const TOOLS: { id: Tool; label: string; hint: string; Icon: typeof Hand }[] = [
  { id: "marquee-rect", label: "矩形选框", hint: "M", Icon: Square },
  { id: "marquee-ellipse", label: "椭圆选框", hint: "O", Icon: Circle },
  { id: "lasso", label: "套索（自由圈选）", hint: "L", Icon: Lasso },
  { id: "hand", label: "抓手（平移画布）", hint: "H", Icon: Hand },
  { id: "eyedropper", label: "吸管（取色）", hint: "I", Icon: Pipette },
];

export function Toolbar() {
  const tool = useDocsStore((s) => s.tool);
  const setTool = useDocsStore((s) => s.setTool);

  useHotkeys({
    M: () => setTool("marquee-rect"),
    O: () => setTool("marquee-ellipse"),
    L: () => setTool("lasso"),
    H: () => setTool("hand"),
    I: () => setTool("eyedropper"),
  });

  return (
    <div className="mo-toolbar" role="toolbar" aria-label="工具">
      {TOOLS.map(({ id, label, hint, Icon }) => (
        <button
          key={id}
          type="button"
          className={`mo-toolbar__btn${tool === id ? " mo-toolbar__btn--active" : ""}`}
          onClick={() => setTool(id)}
          title={`${label}（${hint}）`}
          aria-pressed={tool === id}
        >
          <Icon size={16} aria-hidden />
        </button>
      ))}
    </div>
  );
}
