/**
 * 应用外壳：坊标题栏（菜单＋窗口三键）＋ 左工具栏 ＋ 中央画布区（标签/选项栏/
 * 视口/状态栏）＋ 右停靠面板（M2 起：图层；M3 起：历史；M4 起：调整——坊
 * DockHost/DockPanel）。布局对应产品分析四区：顶部菜单栏、左侧工具栏、中央
 * 画布区、右侧停靠面板区。
 *
 * M4 起带文本输入（文字工具选项栏）：全局键盘监听（工具单键切换/空格抓手）
 * 在输入框聚焦时全部让路——捕获阶段拦截，交还浏览器原生输入与撤销。
 */
import { useEffect } from "react";
import { ThemeProvider, DockHost, DockPanel } from "@baigong/fang";
import "@baigong/fang/tokens.css";
import { AppTitleBar } from "./AppTitleBar";
import { Toolbar } from "../features/canvas/Toolbar";
import { DocTabs } from "../features/canvas/DocTabs";
import { ToolOptionsBar } from "../features/canvas/ToolOptionsBar";
import { CanvasView } from "../features/canvas/CanvasView";
import { StatusBar } from "../features/statusbar/StatusBar";
import { LayersPanel } from "../features/layers/LayersPanel";
import { AdjustPanel } from "../features/adjust/AdjustPanel";
import { HistoryPanel } from "../features/history/HistoryPanel";
import { useDocsStore } from "../core/document/store";

function EmptyState() {
  return (
    <div className="mo-empty">
      <p className="mo-empty__title">打开一张图或新建文档开始（Ctrl+O / Ctrl+N）</p>
      <p className="mo-empty__note">M4 支持调色（调整图层）与文字工具</p>
    </div>
  );
}

/** 文本输入护栏：input/textarea/select 聚焦时拦下全局快捷键（捕获阶段优先于
 *  坊 useHotkeys 与 CanvasView 的 window 冒泡监听，输入不再被抢键）。 */
function useTextInputGuard() {
  useEffect(() => {
    const guard = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el) return;
      const tag = el.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        el.isContentEditable
      ) {
        e.stopImmediatePropagation();
      }
    };
    window.addEventListener("keydown", guard, true);
    return () => window.removeEventListener("keydown", guard, true);
  }, []);
}

export function AppShell() {
  const hasDoc = useDocsStore((s) => s.docs.length > 0);
  useTextInputGuard();

  return (
    <ThemeProvider>
      <div className="app-shell">
        <AppTitleBar />
        <div className="app-main">
          <Toolbar />
          <DockHost
            center={
              <div className="app-canvas-area">
                <DocTabs />
                {hasDoc ? <ToolOptionsBar /> : null}
                {hasDoc ? <CanvasView /> : <EmptyState />}
                <StatusBar />
              </div>
            }
            right={
              <>
                <DockPanel title="图层" collapsed={false}>
                  <LayersPanel />
                </DockPanel>
                <DockPanel title="调整" collapsed={false}>
                  <AdjustPanel />
                </DockPanel>
                <DockPanel title="历史" collapsed={false}>
                  <HistoryPanel />
                </DockPanel>
              </>
            }
            sideWidth={240}
          />
        </div>
      </div>
    </ThemeProvider>
  );
}
