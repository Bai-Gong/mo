//! M3 命令式历史栈：每个编辑命令压入一条「可逆命令」条目，撤销 = 倒放逆命令，
//! 重做 = 正放。同时覆盖两类操作：
//!
//! - **图像内容**（画笔/橡皮/填充）：条目持有脏矩形的前/后像素字节——撤销写回
//!   `before`、重做写回 `after`，与选区等会话态无关（填充依赖当时的选区蒙版，
//!   重放参数不可靠，存字节是唯一保真的做法）；
//! - **图层结构**（增删/排序/可见性/不透明度/混合模式/裁剪）：条目持有逆命令
//!   参数（新建存 id、删除存整层、排序存双下标、属性存前后值、裁剪存整栈快照）。
//!
//! 不变量（撤销重做的正确性根基）：条目按 LIFO 消费——撤销到第 k 条时，文档
//! 状态必然等于「第 k 条刚应用完」的状态，因此逆命令参数在应用时永远有效。
//! 据此，新建图层的撤销/重做无需存像素（压栈时新层必为空层）。
//!
//! 选区不进历史（Photoshop 同惯例：选区是会话态不是文档编辑）；裁剪会清空
//! 选区，撤销裁剪不恢复选区。历史上限 50 条（Photoshop 默认值同量级），
//! 超限丢最旧。

use image::RgbaImage;
use serde::Serialize;

use crate::imageio::ImageDocument;
use crate::layers::{BlendMode, Layer};

/// 历史条目上限（超出丢最旧；Photoshop 默认 20–50 的量级）。
pub const MAX_ENTRIES: usize = 50;

/// 脏矩形（x, y, w, h）——像素类条目的影响范围（图像坐标，含端点内）。
pub type DirtyRect = (u32, u32, u32, u32);

/// 图层属性快照（可见性/不透明度/混合模式三件套，属性类条目的前后值）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LayerPropState {
    pub visible: bool,
    pub opacity: f32,
    pub blend_mode: BlendMode,
}

impl LayerPropState {
    pub fn of(layer: &Layer) -> Self {
        Self {
            visible: layer.visible,
            opacity: layer.opacity,
            blend_mode: layer.blend_mode,
        }
    }
}

/// 单条历史命令。label 供历史面板显示；active_before/after 让撤销重做
/// 连「当时哪个图层是活动的」也一并还原。
#[derive(Debug, Clone)]
pub enum HistoryEntry {
    /// 像素编辑（画笔/橡皮/填充）：脏矩形的 before/after 字节（行优先 RGBA8）。
    Pixels {
        label: String,
        layer_id: u32,
        dirty: DirtyRect,
        before: Vec<u8>,
        after: Vec<u8>,
        active_before: u32,
        active_after: u32,
    },
    /// 新建图层（压栈时必为空层，撤销直接摘除，重放按同 id 置顶重插空层）。
    AddLayer {
        label: String,
        layer_id: u32,
        name: String,
        active_before: u32,
        active_after: u32,
    },
    /// 删除图层：整层（含像素）存进条目，撤销按原下标原位重插。
    DeleteLayer {
        label: String,
        index: usize,
        layer: Layer,
        active_before: u32,
        active_after: u32,
    },
    /// 排序：from/to 为栈索引（0 = 最底）。
    MoveLayer {
        label: String,
        layer_id: u32,
        from: usize,
        to: usize,
        active_before: u32,
        active_after: u32,
    },
    /// 图层属性（可见性/不透明度/混合模式）。
    LayerProp {
        label: String,
        layer_id: u32,
        before: LayerPropState,
        after: LayerPropState,
        active_before: u32,
        active_after: u32,
    },
    /// 裁剪：整栈（含像素）与原尺寸的快照；重放 = 对快照再裁一次（纯几何，
    /// 确定性）。
    Crop {
        label: String,
        rect: DirtyRect,
        before_layers: Vec<Layer>,
        before_width: u32,
        before_height: u32,
        active_before: u32,
        active_after: u32,
    },
}

impl HistoryEntry {
    pub fn label(&self) -> &str {
        match self {
            HistoryEntry::Pixels { label, .. }
            | HistoryEntry::AddLayer { label, .. }
            | HistoryEntry::DeleteLayer { label, .. }
            | HistoryEntry::MoveLayer { label, .. }
            | HistoryEntry::LayerProp { label, .. }
            | HistoryEntry::Crop { label, .. } => label,
        }
    }
}

/// 历史面板一次拉取的快照：条目标签序列 + 游标（已应用条数）。
/// index == k 表示「第 k 条已应用、第 k+1 条未应用」；k == 0 即初始状态。
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HistoryInfo {
    /// 自最早的可用条目起（超上限丢最旧后不含被丢条目）。
    pub entries: Vec<String>,
    /// 已应用条数（0 = 初始状态）。
    pub index: u32,
}

/// 文档历史：条目向量 + 游标。`entries[..cursor]` 为已应用前缀，其余为重做段。
#[derive(Debug, Default)]
pub struct History {
    entries: Vec<HistoryEntry>,
    cursor: usize,
}

impl History {
    pub fn push(&mut self, entry: HistoryEntry) {
        // 分支截断：新命令清掉重做段（Photoshop 同语义）
        self.entries.truncate(self.cursor);
        self.entries.push(entry);
        self.cursor = self.entries.len();
        // 超上限丢最旧（连带游标左移）
        if self.entries.len() > MAX_ENTRIES {
            let overflow = self.entries.len() - MAX_ENTRIES;
            self.entries.drain(0..overflow);
            self.cursor -= overflow;
        }
    }

    pub fn info(&self) -> HistoryInfo {
        HistoryInfo {
            entries: self.entries.iter().map(|e| e.label().to_string()).collect(),
            index: self.cursor as u32,
        }
    }

    pub fn can_undo(&self) -> bool {
        self.cursor > 0
    }

    pub fn can_redo(&self) -> bool {
        self.cursor < self.entries.len()
    }

    fn len(&self) -> usize {
        self.entries.len()
    }
}

// —— 区域读写（像素类条目的字节搬运） ——

/// 读图像中脏矩形区域（行优先 RGBA8）。
pub fn read_region(img: &RgbaImage, r: DirtyRect) -> Vec<u8> {
    let (x, y, w, h) = r;
    let stride = img.width() as usize * 4;
    let raw = img.as_raw();
    let mut out = Vec::with_capacity(w as usize * h as usize * 4);
    for row in y..y + h {
        let start = row as usize * stride + x as usize * 4;
        out.extend_from_slice(&raw[start..start + w as usize * 4]);
    }
    out
}

/// 把字节写回图像的脏矩形区域（行优先；尺寸不符为编程错误，切片越界即暴露）。
pub fn write_region(img: &mut RgbaImage, r: DirtyRect, bytes: &[u8]) {
    let (x, y, w, h) = r;
    let row_len = w as usize * 4;
    for (i, row) in img
        .rows_mut()
        .skip(y as usize)
        .take(h as usize)
        .enumerate()
    {
        let src = &bytes[i * row_len..(i + 1) * row_len];
        for (px, bs) in row
            .into_iter()
            .skip(x as usize)
            .take(w as usize)
            .zip(src.chunks_exact(4))
        {
            px.0 = [bs[0], bs[1], bs[2], bs[3]];
        }
    }
}

/// 对一层做矩形裁剪（裁剪命令与 Crop 条目重放共用；纯几何，确定性）。
fn crop_image(img: &RgbaImage, rect: DirtyRect) -> RgbaImage {
    let (x, y, w, h) = rect;
    image::imageops::crop_imm(img, x, y, w, h).to_image()
}

/// 应用一条历史条目（forward = 正放/重做，false = 倒放/撤销）。
///
/// LIFO 不变量保证：倒放第 k 条时文档恰处于「第 k 条刚应用完」的状态，
/// 因此这里的逆参数永远有效（如 AddLayer 撤销时空层无需存像素）。
fn apply_entry(doc: &mut ImageDocument, index: usize, forward: bool) {
    // 条目（doc.history）与文档其余字段（doc.stack/doc.width…）为不相交字段
    // 借用，可同时持有。
    let entry = &doc.history.entries[index];
    match entry {
        HistoryEntry::Pixels {
            layer_id,
            dirty,
            before,
            after,
            active_before,
            active_after,
            ..
        } => {
            let bytes = if forward { after } else { before };
            if let Some(layer) = doc.stack.iter_mut().find(|l| l.id == *layer_id) {
                write_region(&mut layer.pixels, *dirty, bytes);
            }
            doc.active_layer_id = if forward { *active_after } else { *active_before };
        }
        HistoryEntry::AddLayer {
            layer_id,
            name,
            active_before,
            active_after,
            ..
        } => {
            if forward {
                let layer = Layer {
                    id: *layer_id,
                    name: name.clone(),
                    // 压栈时新层必为空（LIFO 不变量），重放按当前文档尺寸重建
                    pixels: RgbaImage::new(doc.width, doc.height),
                    visible: true,
                    opacity: 1.0,
                    blend_mode: BlendMode::Normal,
                };
                doc.stack.push_layer(layer);
            } else {
                doc.stack.remove_by_id(*layer_id);
            }
            doc.active_layer_id = if forward { *active_after } else { *active_before };
        }
        HistoryEntry::DeleteLayer {
            index,
            layer,
            active_before,
            active_after,
            ..
        } => {
            if forward {
                doc.stack.remove_by_id(layer.id);
            } else {
                doc.stack.insert_layer_at(*index, layer.clone());
            }
            doc.active_layer_id = if forward { *active_after } else { *active_before };
        }
        HistoryEntry::MoveLayer {
            layer_id,
            from,
            to,
            active_before,
            active_after,
            ..
        } => {
            // move_to 按 id 定位源下标，目标下标来自条目（LIFO 下必然合法）
            let target = if forward { *to } else { *from };
            let _ = doc.stack.move_to(*layer_id, target);
            doc.active_layer_id = if forward { *active_after } else { *active_before };
        }
        HistoryEntry::LayerProp {
            layer_id,
            before,
            after,
            active_before,
            active_after,
            ..
        } => {
            let state = if forward { after } else { before };
            if let Some(layer) = doc.stack.iter_mut().find(|l| l.id == *layer_id) {
                layer.visible = state.visible;
                layer.opacity = state.opacity;
                layer.blend_mode = state.blend_mode;
            }
            doc.active_layer_id = if forward { *active_after } else { *active_before };
        }
        HistoryEntry::Crop {
            rect,
            before_layers,
            before_width,
            before_height,
            active_before,
            active_after,
            ..
        } => {
            if forward {
                for layer in doc.stack.iter_mut() {
                    layer.pixels = crop_image(&layer.pixels, *rect);
                }
                doc.width = rect.2;
                doc.height = rect.3;
            } else {
                let restored: Vec<Layer> = before_layers.iter().cloned().collect();
                doc.stack.replace_all(restored);
                doc.width = *before_width;
                doc.height = *before_height;
            }
            // 裁剪清空选区（选区是会话态，尺寸变了蒙版随之作废）；撤销不恢复
            doc.selection = None;
            doc.active_layer_id = if forward { *active_after } else { *active_before };
        }
    }
}

/// 撤销一步（无可撤销时安静返回 false，不报错——前端按 history 信息把按钮置灰）。
pub fn undo(doc: &mut ImageDocument) -> bool {
    if !doc.history.can_undo() {
        return false;
    }
    let index = doc.history.cursor - 1;
    apply_entry(doc, index, false);
    doc.history.cursor = index;
    true
}

/// 重做一步。
pub fn redo(doc: &mut ImageDocument) -> bool {
    if !doc.history.can_redo() {
        return false;
    }
    let index = doc.history.cursor;
    apply_entry(doc, index, true);
    doc.history.cursor = index + 1;
    true
}

/// 历史面板跳转：把文档退/进到「第 target 条已应用」的状态（target 钳到
/// [0, len]）。多次 undo/redo 的复合，单次命令内完成（原子）。
pub fn jump(doc: &mut ImageDocument, target: u32) {
    let target = (target as usize).min(doc.history.len());
    while doc.history.cursor > target {
        undo(doc);
    }
    while doc.history.cursor < target {
        redo(doc);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::imageio::new_document;
    use crate::layers::{
        edit_add_layer, edit_delete_layer, edit_fill, edit_move_layer, edit_set_blend_mode,
        edit_set_layer_visible, edit_set_opacity, snapshot,
    };
    use crate::paint::edit_stroke;

    /// 8×8 透明底文档（背景层 id 固定为 1）。
    fn doc8() -> ImageDocument {
        let mut doc = new_document(8, 8, None).expect("新建");
        doc.active_layer_id = doc.stack.iter().next().unwrap().id;
        doc
    }

    fn pixels_of(doc: &ImageDocument, layer_id: u32) -> Vec<u8> {
        doc.stack
            .iter()
            .find(|l| l.id == layer_id)
            .unwrap()
            .pixels
            .as_raw()
            .clone()
    }

    #[test]
    fn 像素条目_撤销还原_before_重做还原_after() {
        let mut doc = doc8();
        let base = doc.stack.iter().next().unwrap().id;
        // 画一笔红（内容编辑）
        edit_stroke(
            &mut doc,
            &[[4.0, 4.0], [6.0, 4.0]],
            1.0,
            [255, 0, 0, 255],
            false,
        )
        .expect("画笔");
        let painted = pixels_of(&doc, base);
        assert_ne!(painted, pixels_of(&doc8(), base), "画笔应改变像素");

        // 撤销 → 像素回到画前
        assert!(undo(&mut doc));
        assert_eq!(pixels_of(&doc, base), vec![0u8; 8 * 8 * 4], "撤销后应回到全透明");

        // 重做 → 像素回到画后（与撤销前逐字节一致）
        assert!(redo(&mut doc));
        assert_eq!(pixels_of(&doc, base), painted, "重做应精确复现画后状态");
    }

    #[test]
    fn 结构条目_增删撤销重做_整层像素可复原() {
        let mut doc = doc8();
        let base = doc.stack.iter().next().unwrap().id;
        edit_add_layer(&mut doc);
        let new_id = doc.stack.iter().next_back().unwrap().id;
        // 在新层上画一笔（使它带非空像素）
        edit_stroke(&mut doc, &[[2.0, 2.0]], 1.0, [0, 255, 0, 255], false).expect("画笔");
        let painted = pixels_of(&doc, new_id);
        assert!(painted.iter().any(|&b| b != 0));

        // 撤销笔画 → 新层空；再撤销新建 → 层消失；重做新建 → 同 id 空层回来
        assert!(undo(&mut doc));
        assert_eq!(doc.stack.len(), 2, "撤销笔画不撤层数");
        assert!(undo(&mut doc));
        assert_eq!(doc.stack.len(), 1, "撤销新建应摘除新层");
        assert!(doc.stack.iter().all(|l| l.id != new_id));
        assert!(redo(&mut doc));
        assert_eq!(doc.stack.len(), 2);
        assert_eq!(
            doc.stack.iter().next_back().unwrap().id,
            new_id,
            "重做新建应复用原 id（历史面板与前端影子按 id 对齐）"
        );
        assert_eq!(pixels_of(&doc, new_id), vec![0u8; 8 * 8 * 4], "重放的新建为空层");
        // 重做笔画 → 像素复原
        assert!(redo(&mut doc));
        assert_eq!(pixels_of(&doc, new_id), painted);

        // 删除：撤销应把带像素的层原位复原
        edit_delete_layer(&mut doc, new_id).expect("删除");
        assert_eq!(doc.stack.len(), 1);
        assert!(undo(&mut doc));
        assert_eq!(doc.stack.len(), 2);
        assert_eq!(pixels_of(&doc, new_id), painted, "撤销删除应整层复原（含像素）");
        let _ = base;
    }

    #[test]
    fn 结构条目_排序与属性撤销重做() {
        let mut doc = doc8();
        let a = doc.stack.iter().next().unwrap().id;
        edit_add_layer(&mut doc);
        let b = doc.stack.iter().next_back().unwrap().id;
        edit_add_layer(&mut doc);
        let c = doc.stack.iter().next_back().unwrap().id;
        assert_eq!(
            doc.stack.iter().map(|l| l.id).collect::<Vec<_>>(),
            vec![a, b, c]
        );

        // 排序：把底层 a 移到顶 → [b, c, a]
        edit_move_layer(&mut doc, a, 2).expect("移动");
        assert_eq!(
            doc.stack.iter().map(|l| l.id).collect::<Vec<_>>(),
            vec![b, c, a]
        );
        assert!(undo(&mut doc));
        assert_eq!(
            doc.stack.iter().map(|l| l.id).collect::<Vec<_>>(),
            vec![a, b, c],
            "撤销排序应回到原栈序"
        );
        assert!(redo(&mut doc));
        assert_eq!(doc.stack.iter().map(|l| l.id).collect::<Vec<_>>(), vec![b, c, a]);

        // 属性：隐藏 + 半透明 + 混合模式（三条历史）
        edit_set_layer_visible(&mut doc, a, false).expect("隐藏");
        edit_set_opacity(&mut doc, a, 0.25).expect("不透明度");
        edit_set_blend_mode(&mut doc, a, BlendMode::Screen).expect("混合模式");
        let after_props = snapshot(&doc).layers;
        undo(&mut doc);
        undo(&mut doc);
        undo(&mut doc);
        let restored = snapshot(&doc).layers;
        assert!(
            restored
                .iter()
                .all(|l| l.visible && l.opacity == 1.0 && l.blend_mode == BlendMode::Normal),
            "撤销属性链后应回到全默认：{restored:?}"
        );
        redo(&mut doc);
        redo(&mut doc);
        redo(&mut doc);
        assert_eq!(snapshot(&doc).layers, after_props, "重做属性链应精确复原");
    }

    #[test]
    fn 分支截断_撤销后新命令清掉重做段() {
        let mut doc = doc8();
        edit_add_layer(&mut doc); // 条目 1
        assert!(undo(&mut doc));
        assert!(doc.history.can_redo());
        edit_add_layer(&mut doc); // 新命令 → 截断重做段，新条目成为唯一条目
        assert!(!doc.history.can_redo(), "新命令后不应再能重做旧分支");
        assert_eq!(doc.history.info().index, 1, "截断后游标应指向新条目");
        assert_eq!(doc.history.info().entries.len(), 1);
    }

    #[test]
    fn 跳转_历史面板游标多步往返() {
        let mut doc = doc8();
        // 三次不同颜色的填充（同色填充不压历史，见 edit_fill）
        for i in 0..3u8 {
            edit_fill(&mut doc, [10 + i, 20, 30, 255]).expect("填充");
        }
        assert_eq!(doc.history.info().index, 3);
        jump(&mut doc, 1); // 退到第 1 条已应用
        assert_eq!(doc.history.info().index, 1);
        assert!(doc.history.can_redo());
        jump(&mut doc, 3); // 进回最前
        assert_eq!(doc.history.info().index, 3);
        assert!(!doc.history.can_redo());
        jump(&mut doc, 0); // 回初始状态
        assert_eq!(doc.history.info().index, 0);
        assert!(!doc.history.can_undo());
    }

    #[test]
    fn 上限_超限丢最旧_游标同步左移() {
        let mut doc = doc8();
        for i in 0..(MAX_ENTRIES + 5) {
            edit_fill(&mut doc, [i as u8, 0, 0, 255]).expect("填充");
        }
        let info = doc.history.info();
        assert_eq!(info.entries.len(), MAX_ENTRIES, "条目应钳在上限");
        assert_eq!(info.index as usize, MAX_ENTRIES, "游标应指向最前");
        // 全部可撤销回初始（最旧被丢，初始=最早幸存条目之前的状态）
        while undo(&mut doc) {}
        assert_eq!(doc.history.info().index, 0);
    }
}
