/**
 * 应用标题栏：坊 TitleBar（菜单栏＋窗口三键＋拖动区）＋墨的文件/编辑/查看动作。
 *
 * 菜单：文件＝新建 / 打开… / 另存为 PNG… / 另存为 JPEG… / 关闭标签 / 退出；
 * 编辑（M2）＝全选 / 取消选择 / 填充选区（前景色，取吸管取到的颜色，默认黑）；
 * 视图＝适合窗口 / 实际像素 / 放大 / 缩小；帮助＝关于。
 * 快捷键经坊 useHotkeys 挂窗口级（Ctrl+N / Ctrl+O / Ctrl+Shift+S / Ctrl+W /
 * Ctrl+A / Ctrl+D / Alt+Backspace / Ctrl+0 / Ctrl+1 / Ctrl+= / Ctrl+-）。
 */
import { useCallback, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { FolderOpen, ImageDown } from "lucide-react";
import { getWindowAdapter, TitleBar, useHotkeys, type MenuEntry } from "@baigong/fang";
import { selectActiveDoc, useDocsStore } from "../core/document/store";
import {
  closeDoc,
  createDocumentTab,
  fileNameOf,
  openImagePath,
  saveDocAs,
} from "../core/document/openPipeline";
import { deselect, fillSelection, selectAll } from "../core/document/layerPipeline";

const ZOOM_STEP = Math.sqrt(2); // 每次约 141%（两步翻倍），Photoshop 惯例量级

/** 新建文档的默认尺寸与底色（M2：海报/图层玩法起点，尺寸对话框后置）。 */
const NEW_DOC = { width: 800, height: 600, background: [255, 255, 255, 255] as [number, number, number, number] };

export function AppTitleBar() {
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const hasDoc = useDocsStore((s) => s.activeId !== null);

  const notify = useCallback((kind: "ok" | "error", text: string) => {
    setMessage({ kind, text });
  }, []);

  /** 文件→新建：白底 800×600（图层列表由图层面板自动拉取）。 */
  const onNew = useCallback(async () => {
    try {
      const meta = await createDocumentTab(NEW_DOC);
      notify("ok", `已新建 ${meta.width}×${meta.height} 白底文档`);
    } catch (err) {
      notify("error", `新建失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [notify]);

  /** 文件→打开…：多选，逐个走 openImagePath（失败照常提示，不中断其余）。 */
  const onOpen = useCallback(async () => {
    try {
      const picked = await openFileDialog({
        multiple: true,
        filters: [{ name: "图像（JPG/PNG）", extensions: ["png", "jpg", "jpeg"] }],
      });
      if (!picked) return; // 用户取消
      const paths = Array.isArray(picked) ? picked : [picked];
      let okCount = 0;
      const failures: string[] = [];
      for (const path of paths) {
        try {
          await openImagePath(path);
          okCount += 1;
        } catch (err) {
          failures.push(`${fileNameOf(path)}：${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (okCount > 0) notify("ok", `已打开 ${okCount} 个文件`);
      if (failures.length > 0) notify("error", `打开失败：${failures.join("；")}`);
    } catch (err) {
      notify("error", `打开对话框失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [notify]);

  /** 编辑→全选/取消选择/填充。 */
  const onSelectAll = useCallback(async () => {
    const id = useDocsStore.getState().activeId;
    if (id === null) return;
    try {
      await selectAll(id);
    } catch (err) {
      notify("error", `全选失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [notify]);

  const onDeselect = useCallback(async () => {
    const id = useDocsStore.getState().activeId;
    if (id === null) return;
    try {
      await deselect(id);
    } catch (err) {
      notify("error", `取消选择失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [notify]);

  const onFill = useCallback(async () => {
    const id = useDocsStore.getState().activeId;
    if (id === null) return;
    // 前景色 = 吸管最近取到的颜色，未取过用黑（颜色面板随 M4 进）
    const picked = useDocsStore.getState().pickedColor;
    const color: [number, number, number, number] = picked
      ? [picked.r, picked.g, picked.b, picked.a]
      : [0, 0, 0, 255];
    try {
      await fillSelection(id, color);
      notify("ok", "已填充活动图层（选区内）");
    } catch (err) {
      notify("error", `填充失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [notify]);

  /** 文件→另存为…：Rust 侧从驻留像素编码（含 ICC 原样写回）。 */
  const onSaveAs = useCallback(
    async (format: "png" | "jpeg") => {
      const meta = selectActiveDoc(useDocsStore.getState());
      if (!meta) return;
      const ext = format === "png" ? "png" : "jpg";
      const base = meta.name.replace(/\.[^.]+$/, "");
      try {
        const path = await saveFileDialog({
          defaultPath: `${base}-另存.${ext}`,
          filters: [
            format === "png"
              ? { name: "PNG 图像", extensions: ["png"] }
              : { name: "JPEG 图像", extensions: ["jpg", "jpeg"] },
          ],
        });
        if (!path) return; // 用户取消
        await saveDocAs({ docId: meta.id, path, format });
        notify("ok", `已保存：${path}`);
      } catch (err) {
        notify("error", `保存失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [notify],
  );

  const onCloseTab = useCallback(async () => {
    const activeId = useDocsStore.getState().activeId;
    if (activeId === null) return;
    try {
      await closeDoc(activeId);
    } catch (err) {
      // Rust 侧释放失败：标签已关，提示即可
      notify("error", `释放图像内存失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [notify]);

  const onAbout = useCallback(async () => {
    try {
      const info = await invoke<{ name: string; version: string }>("app_info");
      notify("ok", `${info.name} v${info.version} · 百工集群 · Tauri + React`);
    } catch {
      notify("ok", "百工·墨 · 百工集群 · Tauri + React");
    }
  }, [notify]);

  const menus = useMemo<MenuEntry[]>(
    () => [
      {
        label: "文件",
        items: [
          { kind: "item", label: "新建", hint: "Ctrl+N", onSelect: () => void onNew() },
          { kind: "item", label: "打开…", hint: "Ctrl+O", onSelect: () => void onOpen() },
          { kind: "separator" },
          {
            kind: "item",
            label: "另存为 PNG…",
            hint: "Ctrl+Shift+S",
            disabled: !hasDoc,
            onSelect: () => void onSaveAs("png"),
          },
          {
            kind: "item",
            label: "另存为 JPEG…",
            disabled: !hasDoc,
            onSelect: () => void onSaveAs("jpeg"),
          },
          { kind: "separator" },
          {
            kind: "item",
            label: "关闭标签",
            hint: "Ctrl+W",
            disabled: !hasDoc,
            onSelect: () => void onCloseTab(),
          },
          { kind: "separator" },
          { kind: "item", label: "退出", onSelect: () => getWindowAdapter()?.close() },
        ],
      },
      {
        label: "编辑",
        items: [
          {
            kind: "item",
            label: "全选",
            hint: "Ctrl+A",
            disabled: !hasDoc,
            onSelect: () => void onSelectAll(),
          },
          {
            kind: "item",
            label: "取消选择",
            hint: "Ctrl+D",
            disabled: !hasDoc,
            onSelect: () => void onDeselect(),
          },
          { kind: "separator" },
          {
            kind: "item",
            label: "填充选区（前景色）",
            hint: "Alt+Backspace",
            disabled: !hasDoc,
            onSelect: () => void onFill(),
          },
        ],
      },
      {
        label: "视图",
        items: [
          {
            kind: "item",
            label: "适合窗口",
            hint: "Ctrl+0",
            disabled: !hasDoc,
            onSelect: () => useDocsStore.getState().fitActive(),
          },
          {
            kind: "item",
            label: "实际像素（100%）",
            hint: "Ctrl+1",
            disabled: !hasDoc,
            onSelect: () => useDocsStore.getState().actualSizeActive(),
          },
          { kind: "separator" },
          {
            kind: "item",
            label: "放大",
            hint: "Ctrl+=",
            disabled: !hasDoc,
            onSelect: () => {
              const s = useDocsStore.getState();
              s.setZoom((s.views[s.activeId ?? 0]?.zoom ?? 1) * ZOOM_STEP);
            },
          },
          {
            kind: "item",
            label: "缩小",
            hint: "Ctrl+-",
            disabled: !hasDoc,
            onSelect: () => {
              const s = useDocsStore.getState();
              s.setZoom((s.views[s.activeId ?? 0]?.zoom ?? 1) / ZOOM_STEP);
            },
          },
        ],
      },
      { label: "帮助", items: [{ kind: "item", label: "关于 百工·墨", onSelect: () => void onAbout() }] },
    ],
    [hasDoc, onNew, onOpen, onSaveAs, onCloseTab, onSelectAll, onDeselect, onFill, onAbout],
  );

  useHotkeys({
    "Ctrl+N": () => void onNew(),
    "Ctrl+O": () => void onOpen(),
    "Ctrl+Shift+S": () => void onSaveAs("png"),
    "Ctrl+W": () => void onCloseTab(),
    "Ctrl+A": () => void onSelectAll(),
    "Ctrl+D": () => void onDeselect(),
    "Alt+Backspace": () => void onFill(),
    "Ctrl+0": () => useDocsStore.getState().fitActive(),
    "Ctrl+1": () => useDocsStore.getState().actualSizeActive(),
    "Ctrl+=": () => {
      const s = useDocsStore.getState();
      s.setZoom((s.views[s.activeId ?? 0]?.zoom ?? 1) * ZOOM_STEP);
    },
    "Ctrl+-": () => {
      const s = useDocsStore.getState();
      s.setZoom((s.views[s.activeId ?? 0]?.zoom ?? 1) / ZOOM_STEP);
    },
  });

  const activeSummary = useDocsStore((s) => {
    const doc = selectActiveDoc(s);
    return doc ? `${doc.name} · ${doc.width}×${doc.height}px` : "M1 查看与文档";
  });

  return (
    <TitleBar
      appName="百工·墨"
      menus={menus}
      center={<span className="top-bar__doc-hint">{activeSummary}</span>}
      actions={
        <>
          {message && (
            <span
              className={`top-bar__msg${message.kind === "error" ? " top-bar__msg--error" : ""}`}
              title={message.text}
            >
              {message.text}
            </span>
          )}
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void onOpen()}
            title="打开图像文件（Ctrl+O）"
          >
            <FolderOpen size={14} aria-hidden />
            打开
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => void onSaveAs("png")}
            disabled={!hasDoc}
            title="另存为 PNG（Ctrl+Shift+S）"
          >
            <ImageDown size={14} aria-hidden />
            另存 PNG
          </button>
        </>
      }
    />
  );
}
