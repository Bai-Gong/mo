/**
 * 左侧工具栏（产品分析「左侧竖排工具栏」的 M1 子集）：抓手（平移）/ 吸管（取色）。
 * 单键切换（H/I，Photoshop 惯例）；按住空格临时抓手在 CanvasView 内处理。
 */
import { Hand, Pipette } from "lucide-react";
import { useHotkeys } from "@baigong/fang";
import { useDocsStore } from "../../core/document/store";
import type { Tool } from "../../core/document/types";

const TOOLS: { id: Tool; label: string; hint: string; Icon: typeof Hand }[] = [
  { id: "hand", label: "抓手（平移画布）", hint: "H", Icon: Hand },
  { id: "eyedropper", label: "吸管（取色）", hint: "I", Icon: Pipette },
];

export function Toolbar() {
  const tool = useDocsStore((s) => s.tool);
  const setTool = useDocsStore((s) => s.setTool);

  useHotkeys({
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
