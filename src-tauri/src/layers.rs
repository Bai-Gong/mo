//! M2 图层栈与合成：栅格图层（与文档同尺寸 RGBA8）的增删/排序/可见性、
//! 不透明度与混合模式、自底向上合成、选区约束填充。
//!
//! 合成公式取 W3C《Compositing and Blending Level 1》（Photoshop 同源），
//! 非预乘通道参与运算：
//! ```text
//! co = αs·(1−αb)·Cs + αs·αb·B(Cb,Cs) + (1−αs)·αb·Cb
//! αo = αs + αb·(1−αs)          输出色 = co / αo
//! ```
//! 其中图层不透明度直接缩放 αs；B 为混合函数（normal/multiply/screen/overlay）。
//! overlay 按 W3C 定义对**底色**分支：Cb ≤ 0.5 走 2·Cb·Cs（乘性），否则走
//! 1−2(1−Cb)(1−Cs)（屏性）。
//!
//! 性能口径：M2 顺序合成（每层一趟 w×h 循环），海报量级毫秒级；真出现大图
//! 帧预算问题时再上 rayon 分行（image 已带 rayon feature，选型文档已留档）。

use image::RgbaImage;
use serde::{Deserialize, Serialize};

use crate::history::{HistoryEntry, LayerPropState};
use crate::imageio::{ImageDocument, LAYER_BASE_NAME};
use crate::selection::{make_selection, select_all_mask, Selection, SelectionShape};
use tauri::State;

/// M2 混合模式集（前端传小写名，serde camelCase）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BlendMode {
    Normal,
    Multiply,
    Screen,
    Overlay,
}

impl BlendMode {
    /// 前端契约："normal" / "multiply" / "screen" / "overlay"。
    pub fn parse(s: &str) -> Result<Self, String> {
        match s.to_ascii_lowercase().as_str() {
            "normal" => Ok(Self::Normal),
            "multiply" => Ok(Self::Multiply),
            "screen" => Ok(Self::Screen),
            "overlay" => Ok(Self::Overlay),
            other => Err(format!("M2 不支持的混合模式：{other}")),
        }
    }
}

/// 栅格图层。像素与文档同尺寸（M2 不做位移图层/跨文档边界）。
/// Clone 供历史条目持有（删除/裁剪需要整层快照）。
#[derive(Debug, Clone)]
pub struct Layer {
    pub id: u32,
    pub name: String,
    pub pixels: RgbaImage,
    pub visible: bool,
    /// 0.0–1.0（UI 显示为百分比）。
    pub opacity: f32,
    pub blend_mode: BlendMode,
}

/// 图层栈：索引 0 = 最底层（画布底），末位 = 最上层。
#[derive(Debug, Default)]
pub struct LayerStack {
    layers: Vec<Layer>,
    next_id: u32,
}

impl LayerStack {
    /// 以既有像素建栈（打开文件的「背景」图层）。
    pub fn with_base(pixels: RgbaImage) -> Self {
        let mut stack = Self::default();
        stack.layers.push(Layer {
            id: stack.next_id + 1,
            name: LAYER_BASE_NAME.into(),
            pixels,
            visible: true,
            opacity: 1.0,
            blend_mode: BlendMode::Normal,
        });
        stack.next_id = 1;
        stack
    }

    /// 顶层加一张空（全透明）图层，返回其 id（像素修改经 `iter_mut` 按 id 定位）。
    pub fn add(&mut self, name: &str, width: u32, height: u32) -> u32 {
        self.next_id += 1;
        let id = self.next_id;
        self.layers.push(Layer {
            id,
            name: name.into(),
            pixels: RgbaImage::new(width, height),
            visible: true,
            opacity: 1.0,
            blend_mode: BlendMode::Normal,
        });
        id
    }

    /// 自底向上迭代（合成顺序）；next_back 即栈顶。
    pub fn iter(&self) -> impl DoubleEndedIterator<Item = &Layer> {
        self.layers.iter()
    }

    /// 可变版（改可见性/混合模式/像素的落点）。
    pub fn iter_mut(&mut self) -> impl DoubleEndedIterator<Item = &mut Layer> {
        self.layers.iter_mut()
    }

    pub fn len(&self) -> usize {
        self.layers.len()
    }

    pub fn index_of(&self, id: u32) -> Option<usize> {
        self.layers.iter().position(|l| l.id == id)
    }

    /// 摘除图层并交还（历史条目要持有被删层）。最后一张不允许删
    /// （Photoshop 惯例：文档至少一层）。
    pub fn remove(&mut self, id: u32) -> Result<Layer, String> {
        let index = self
            .index_of(id)
            .ok_or_else(|| format!("图层 {id} 不存在"))?;
        if self.layers.len() <= 1 {
            return Err("文档至少保留一个图层，不能删除最后一张".into());
        }
        Ok(self.layers.remove(index))
    }

    /// 按 id 无条件摘除并交还（历史重放路径：撤销「新建」时栈必有 ≥2 层，
    /// 无需再校验最后一张）。
    pub fn remove_by_id(&mut self, id: u32) -> Option<Layer> {
        let index = self.index_of(id)?;
        Some(self.layers.remove(index))
    }

    /// 置顶压入一张现成图层（历史重放「新建」用；id 复用条目存的旧 id，
    /// next_id 已单调越过它，不会冲突）。
    pub fn push_layer(&mut self, layer: Layer) {
        self.layers.push(layer);
    }

    /// 按栈下标原位插回（历史重放「删除」的撤销）。
    pub fn insert_layer_at(&mut self, index: usize, layer: Layer) {
        let index = index.min(self.layers.len());
        self.layers.insert(index, layer);
    }

    /// 整栈替换（历史重放「裁剪」的撤销；id 均来自本栈，next_id 无需回拨）。
    pub fn replace_all(&mut self, layers: Vec<Layer>) {
        self.layers = layers;
    }

    /// 把图层 id 移到栈的 to_index（0 = 最底）。钳到合法范围。
    pub fn move_to(&mut self, id: u32, to_index: usize) -> Result<(), String> {
        let from = self
            .index_of(id)
            .ok_or_else(|| format!("图层 {id} 不存在"))?;
        let to = to_index.min(self.layers.len() - 1);
        let layer = self.layers.remove(from);
        self.layers.insert(to, layer);
        Ok(())
    }
}

/// 前端视角的图层元信息（get_layers 契约）。
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LayerInfo {
    pub id: u32,
    pub name: String,
    pub visible: bool,
    pub opacity: f32,
    pub blend_mode: BlendMode,
}

/// 图层面板一次拉取的完整快照（每次图层操作后的返回，保持两端一致）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayersSnapshot {
    /// 自底向上（面板展示时前端倒序）。
    pub layers: Vec<LayerInfo>,
    pub active_layer_id: u32,
}

/// 面板快照（crate 内共用：命令与 paint.rs 的笔画命令都回它）。
pub(crate) fn snapshot(doc: &ImageDocument) -> LayersSnapshot {
    LayersSnapshot {
        layers: doc
            .stack
            .iter()
            .map(|l| LayerInfo {
                id: l.id,
                name: l.name.clone(),
                visible: l.visible,
                opacity: l.opacity,
                blend_mode: l.blend_mode,
            })
            .collect(),
        active_layer_id: doc.active_layer_id,
    }
}

// —— 合成 ——

/// 单通道混合函数 B(Cb, Cs)（输入输出均为 [0,1] 非预乘）。
#[inline]
fn blend_channel(cb: f32, cs: f32, mode: BlendMode) -> f32 {
    match mode {
        BlendMode::Normal => cs,
        BlendMode::Multiply => cb * cs,
        BlendMode::Screen => cb + cs - cb * cs,
        // 对底色分支（W3C compositing-1 overlay；Photoshop 同行为）
        BlendMode::Overlay => {
            if cb <= 0.5 {
                2.0 * cb * cs
            } else {
                1.0 - 2.0 * (1.0 - cb) * (1.0 - cs)
            }
        }
    }
}

/// [0,1] → u8，半进位取整（选区蒙版/填充/笔画同一口径，链路取整一致）。
#[inline]
pub(crate) fn to_u8(v: f32) -> u8 {
    (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8
}

/// 把一层按混合模式与不透明度合到累积缓冲上（acc 为非预乘 RGBA8）。
fn blend_onto(acc: &mut [u8], src: &RgbaImage, opacity: f32, mode: BlendMode) {
    for (dst, s) in acc.chunks_exact_mut(4).zip(src.pixels()) {
        let ab = dst[3] as f32 / 255.0;
        let as_raw = s.0[3] as f32 / 255.0;
        // 图层不透明度缩放源 alpha（Photoshop 语义：混合按像素 alpha、贡献按不透明度）
        let as_ = as_raw * opacity;
        if as_ <= 0.0 {
            continue; // 对结果无贡献（透明像素/不透明度 0）
        }
        let cb = [
            dst[0] as f32 / 255.0,
            dst[1] as f32 / 255.0,
            dst[2] as f32 / 255.0,
        ];
        let cs = [
            s.0[0] as f32 / 255.0,
            s.0[1] as f32 / 255.0,
            s.0[2] as f32 / 255.0,
        ];
        let ao = as_ + ab * (1.0 - as_);
        if ao <= 0.0 {
            dst.fill(0);
            continue;
        }
        for ch in 0..3 {
            let b = blend_channel(cb[ch], cs[ch], mode);
            let co = as_ * (1.0 - ab) * cs[ch] + as_ * ab * b + (1.0 - as_) * ab * cb[ch];
            dst[ch] = to_u8(co / ao);
        }
        dst[3] = to_u8(ao);
    }
}

/// 合成整栈（跳过隐藏/全透明的层），自底向上。空栈 → 全透明。
pub fn composite(stack: &LayerStack, width: u32, height: u32) -> RgbaImage {
    let mut acc = vec![0u8; width as usize * height as usize * 4];
    for layer in stack.iter().filter(|l| l.visible && l.opacity > 0.0) {
        blend_onto(&mut acc, &layer.pixels, layer.opacity, layer.blend_mode);
    }
    RgbaImage::from_raw(width, height, acc).expect("累积缓冲与文档同尺寸")
}

// —— 填充 ——

/// 用纯色填充图层的选区覆盖处（选区 None = 整层；蒙版 0 处不动）。
///
/// 覆盖率与颜色 alpha 相乘为源 alpha，走标准 source-over（与合成同一公式，
/// mode=Normal 的特例）。
pub fn fill_layer(layer: &mut RgbaImage, selection: Option<&Selection>, color: [u8; 4]) {
    let cs = [
        color[0] as f32 / 255.0,
        color[1] as f32 / 255.0,
        color[2] as f32 / 255.0,
    ];
    let color_a = color[3] as f32 / 255.0;
    for (i, px) in layer.pixels_mut().enumerate() {
        let coverage = selection.map(|s| s.mask[i] as f32 / 255.0).unwrap_or(1.0);
        let as_ = coverage * color_a;
        if as_ <= 0.0 {
            continue;
        }
        let ab = px.0[3] as f32 / 255.0;
        let ao = as_ + ab * (1.0 - as_);
        if ao <= 0.0 {
            px.0 = [0, 0, 0, 0];
            continue;
        }
        for ch in 0..3 {
            let co = as_ * cs[ch] + (1.0 - as_) * ab * (px.0[ch] as f32 / 255.0);
            px.0[ch] = to_u8(co / ao);
        }
        px.0[3] = to_u8(ao);
    }
}

/// 文档级填充入口（命令与测试共用）：填充活动图层。
pub fn apply_fill(doc: &mut ImageDocument, color: [u8; 4]) -> Result<(), String> {
    let active = doc.active_layer_id;
    let layer = doc
        .stack
        .iter_mut()
        .find(|l| l.id == active)
        .ok_or_else(|| format!("活动图层 {active} 不存在"))?;
    fill_layer(&mut layer.pixels, doc.selection.as_ref(), color);
    Ok(())
}

// —— 选区操作（文档级）——

/// 设置文档选区（栅格化并记录）。空集形状（如负尺寸/少于 3 点）也如实记录：
/// 后续填充落在空蒙版上等于无操作。
pub fn apply_selection(doc: &mut ImageDocument, shape: SelectionShape) {
    doc.selection = Some(make_selection(shape, doc.width, doc.height));
}

/// 全选。
pub fn apply_select_all(doc: &mut ImageDocument) {
    doc.selection = Some(Selection {
        mask: select_all_mask(doc.width, doc.height),
    });
}

/// 取消选择（此后填充作用于整层）。
pub fn apply_clear_selection(doc: &mut ImageDocument) {
    doc.selection = None;
}

// —— 编辑函数（M3：改文档 + 压历史条目；命令与测试共用）——
//
// 命名约定：edit_* 返回 () 或 Result（业务错误），历史条目在成功变更后压入；
// 无实际变更（同值设置/空操作）不压条目。选区命令不进历史（会话态）。

/// 新建空图层（置顶并激活）。
pub fn edit_add_layer(doc: &mut ImageDocument) {
    let count = doc.stack.len();
    let name = format!("图层 {count}");
    let active_before = doc.active_layer_id;
    let id = doc.stack.add(&name, doc.width, doc.height);
    doc.active_layer_id = id;
    doc.history.push(HistoryEntry::AddLayer {
        label: "新建图层".into(),
        layer_id: id,
        name,
        active_before,
        active_after: id,
    });
}

/// 删除图层（最后一张拒绝；删的是活动层则激活邻位顶层）。
pub fn edit_delete_layer(doc: &mut ImageDocument, layer_id: u32) -> Result<(), String> {
    let index = doc
        .stack
        .index_of(layer_id)
        .ok_or_else(|| format!("图层 {layer_id} 不存在"))?;
    let active_before = doc.active_layer_id;
    let layer = doc.stack.remove(layer_id)?;
    let active_after = if active_before == layer_id {
        doc.stack.iter().next_back().expect("栈非空").id
    } else {
        active_before
    };
    doc.active_layer_id = active_after;
    doc.history.push(HistoryEntry::DeleteLayer {
        label: "删除图层".into(),
        index,
        layer,
        active_before,
        active_after,
    });
    Ok(())
}

/// 排序：把图层移到 to_index（0 = 最底）。无位移不压历史。
pub fn edit_move_layer(doc: &mut ImageDocument, layer_id: u32, to_index: usize) -> Result<(), String> {
    let from = doc
        .stack
        .index_of(layer_id)
        .ok_or_else(|| format!("图层 {layer_id} 不存在"))?;
    let to = to_index.min(doc.stack.len() - 1);
    if from == to {
        return Ok(()); // 目标即当前位置（钳制后），无变更
    }
    doc.stack.move_to(layer_id, to)?;
    doc.history.push(HistoryEntry::MoveLayer {
        label: "排列图层".into(),
        layer_id,
        from,
        to,
        active_before: doc.active_layer_id,
        active_after: doc.active_layer_id,
    });
    Ok(())
}

/// 可见性开关。同值不压历史。
pub fn edit_set_layer_visible(doc: &mut ImageDocument, layer_id: u32, visible: bool) -> Result<(), String> {
    let layer = doc
        .stack
        .iter_mut()
        .find(|l| l.id == layer_id)
        .ok_or_else(|| format!("图层 {layer_id} 不存在"))?;
    if layer.visible == visible {
        return Ok(());
    }
    let before = LayerPropState::of(layer);
    layer.visible = visible;
    let after = LayerPropState::of(layer);
    doc.history.push(HistoryEntry::LayerProp {
        label: if visible { "显示图层".into() } else { "隐藏图层".into() },
        layer_id,
        before,
        after,
        active_before: doc.active_layer_id,
        active_after: doc.active_layer_id,
    });
    Ok(())
}

/// 不透明度（0–1，越界钳制）。同值不压历史。
pub fn edit_set_opacity(doc: &mut ImageDocument, layer_id: u32, opacity: f32) -> Result<(), String> {
    let layer = doc
        .stack
        .iter_mut()
        .find(|l| l.id == layer_id)
        .ok_or_else(|| format!("图层 {layer_id} 不存在"))?;
    let opacity = opacity.clamp(0.0, 1.0);
    if (layer.opacity - opacity).abs() < f32::EPSILON {
        return Ok(());
    }
    let before = LayerPropState::of(layer);
    layer.opacity = opacity;
    let after = LayerPropState::of(layer);
    doc.history.push(HistoryEntry::LayerProp {
        label: "图层不透明度".into(),
        layer_id,
        before,
        after,
        active_before: doc.active_layer_id,
        active_after: doc.active_layer_id,
    });
    Ok(())
}

/// 混合模式。同值不压历史。
pub fn edit_set_blend_mode(doc: &mut ImageDocument, layer_id: u32, mode: BlendMode) -> Result<(), String> {
    let layer = doc
        .stack
        .iter_mut()
        .find(|l| l.id == layer_id)
        .ok_or_else(|| format!("图层 {layer_id} 不存在"))?;
    if layer.blend_mode == mode {
        return Ok(());
    }
    let before = LayerPropState::of(layer);
    layer.blend_mode = mode;
    let after = LayerPropState::of(layer);
    doc.history.push(HistoryEntry::LayerProp {
        label: "混合模式".into(),
        layer_id,
        before,
        after,
        active_before: doc.active_layer_id,
        active_after: doc.active_layer_id,
    });
    Ok(())
}

/// 填充活动图层的选区（无选区 = 整层）并压历史（脏矩形 = 整层）。
/// 字节未变（空选区等）不压历史。
pub fn edit_fill(doc: &mut ImageDocument, color: [u8; 4]) -> Result<(), String> {
    let active = doc.active_layer_id;
    let dirty = (0, 0, doc.width, doc.height);
    let before = doc
        .stack
        .iter()
        .find(|l| l.id == active)
        .map(|l| crate::history::read_region(&l.pixels, dirty))
        .ok_or_else(|| format!("活动图层 {active} 不存在"))?;
    apply_fill(doc, color)?;
    let after = doc
        .stack
        .iter()
        .find(|l| l.id == active)
        .map(|l| crate::history::read_region(&l.pixels, dirty))
        .expect("apply_fill 已校验活动图层存在");
    if before == after {
        return Ok(());
    }
    doc.history.push(HistoryEntry::Pixels {
        label: "填充".into(),
        layer_id: active,
        dirty,
        before,
        after,
        active_before: active,
        active_after: active,
    });
    Ok(())
}

// —— Tauri 命令（薄壳：锁注册表 → 调上面的编辑函数）——

/// 面板快照。
#[tauri::command]
pub fn get_layers(
    doc_id: u32,
    documents: State<crate::imageio::Documents>,
) -> Result<LayersSnapshot, String> {
    documents.with_doc(doc_id, snapshot)
}

/// 编辑命令的统一返回：图层快照 + 历史快照（前端一次往返拿到一致状态，
/// 并刷新历史面板）。尺寸供裁剪/撤销重做后校正前端文档元信息。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditResult {
    pub layers: LayersSnapshot,
    pub history: crate::history::HistoryInfo,
    pub width: u32,
    pub height: u32,
}

/// 组装编辑返回（各命令尾部共用）。
fn edit_result(doc: &ImageDocument) -> EditResult {
    EditResult {
        layers: snapshot(doc),
        history: doc.history.info(),
        width: doc.width,
        height: doc.height,
    }
}

/// 新建空图层（置顶并激活）。
#[tauri::command]
pub fn add_layer(
    doc_id: u32,
    documents: State<crate::imageio::Documents>,
) -> Result<EditResult, String> {
    documents.with_doc_mut(doc_id, |doc| {
        edit_add_layer(doc);
        edit_result(doc)
    })
}

/// 删除图层（最后一张拒绝；删的是活动层则激活邻位顶层）。
#[tauri::command]
pub fn delete_layer(
    doc_id: u32,
    layer_id: u32,
    documents: State<crate::imageio::Documents>,
) -> Result<EditResult, String> {
    documents.with_doc_mut(doc_id, |doc| {
        edit_delete_layer(doc, layer_id)?;
        Ok(edit_result(doc))
    })?
}

/// 排序：把图层移到 to_index（0 = 最底；前端面板自上而下展示，注意换算）。
#[tauri::command]
pub fn move_layer(
    doc_id: u32,
    layer_id: u32,
    to_index: u32,
    documents: State<crate::imageio::Documents>,
) -> Result<EditResult, String> {
    documents.with_doc_mut(doc_id, |doc| {
        edit_move_layer(doc, layer_id, to_index as usize)?;
        Ok(edit_result(doc))
    })?
}

/// 可见性开关（隐藏层不参与合成）。
#[tauri::command]
pub fn set_layer_visible(
    doc_id: u32,
    layer_id: u32,
    visible: bool,
    documents: State<crate::imageio::Documents>,
) -> Result<EditResult, String> {
    documents.with_doc_mut(doc_id, |doc| {
        edit_set_layer_visible(doc, layer_id, visible)?;
        Ok(edit_result(doc))
    })?
}

/// 不透明度（0–1，越界钳制）。
#[tauri::command]
pub fn set_layer_opacity(
    doc_id: u32,
    layer_id: u32,
    opacity: f32,
    documents: State<crate::imageio::Documents>,
) -> Result<EditResult, String> {
    documents.with_doc_mut(doc_id, |doc| {
        edit_set_opacity(doc, layer_id, opacity)?;
        Ok(edit_result(doc))
    })?
}

/// 混合模式（normal/multiply/screen/overlay）。
#[tauri::command]
pub fn set_layer_blend_mode(
    doc_id: u32,
    layer_id: u32,
    mode: String,
    documents: State<crate::imageio::Documents>,
) -> Result<EditResult, String> {
    let mode = BlendMode::parse(&mode)?;
    documents.with_doc_mut(doc_id, |doc| {
        edit_set_blend_mode(doc, layer_id, mode)?;
        Ok(edit_result(doc))
    })?
}

/// 设活动图层（笔画/填充的落点）。会话态，不进历史。
#[tauri::command]
pub fn set_active_layer(
    doc_id: u32,
    layer_id: u32,
    documents: State<crate::imageio::Documents>,
) -> Result<LayersSnapshot, String> {
    documents.with_doc_mut(doc_id, |doc| {
        if doc.stack.index_of(layer_id).is_none() {
            return Err(format!("图层 {layer_id} 不存在"));
        }
        doc.active_layer_id = layer_id;
        Ok(snapshot(doc))
    })?
}

/// 设置选区（矩形/椭圆/套索，浮点几何，Rust 栅格化为抗锯齿蒙版）。
/// 选区是会话态，不进历史（Photoshop 同惯例）。
#[tauri::command]
pub fn set_selection(
    doc_id: u32,
    shape: SelectionShape,
    documents: State<crate::imageio::Documents>,
) -> Result<(), String> {
    documents.with_doc_mut(doc_id, |doc| {
        apply_selection(doc, shape);
    })
}

/// 全选。
#[tauri::command]
pub fn select_all(doc_id: u32, documents: State<crate::imageio::Documents>) -> Result<(), String> {
    documents.with_doc_mut(doc_id, |doc| {
        apply_select_all(doc);
    })
}

/// 取消选择。
#[tauri::command]
pub fn deselect(doc_id: u32, documents: State<crate::imageio::Documents>) -> Result<(), String> {
    documents.with_doc_mut(doc_id, |doc| {
        apply_clear_selection(doc);
    })
}

/// 用颜色填充活动图层的选区（无选区 = 整层）。color 为 RGBA。
#[tauri::command]
pub fn fill_active_layer(
    doc_id: u32,
    color: [u8; 4],
    documents: State<crate::imageio::Documents>,
) -> Result<EditResult, String> {
    documents.with_doc_mut(doc_id, |doc| {
        edit_fill(doc, color)?;
        Ok(edit_result(doc))
    })?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 纯色不透明图层。
    fn solid_layer(color: [u8; 4]) -> Layer {
        Layer {
            id: 0,
            name: "测试".into(),
            pixels: RgbaImage::from_pixel(4, 4, image::Rgba(color)),
            visible: true,
            opacity: 1.0,
            blend_mode: BlendMode::Normal,
        }
    }

    /// 4×4 两层栈合成后取 (0,0) 像素。
    fn blend_top_over_bottom(bottom: Layer, top: Layer) -> [u8; 4] {
        let stack = LayerStack { layers: vec![bottom, top], next_id: 2 };
        composite(&stack, 4, 4).get_pixel(0, 0).0
    }

    fn assert_close(actual: [u8; 4], expected: [u8; 4], tol: i32, ctx: &str) {
        for ch in 0..4 {
            let diff = (actual[ch] as i32 - expected[ch] as i32).abs();
            assert!(diff <= tol, "{ctx} 第 {ch} 通道差 {diff} 超容差 {tol}：实际 {actual:?} 期望 {expected:?}");
        }
    }

    // —— 混合数学（期望值为手算，不引自被测代码） ——

    #[test]
    fn 正常_不透明源盖底_等于源色() {
        // 蓝盖红 → 蓝
        let out = blend_top_over_bottom(solid_layer([255, 0, 0, 255]), solid_layer([0, 0, 255, 255]));
        assert_close(out, [0, 0, 255, 255], 0, "正常混合不透明源应完全覆盖");
    }

    #[test]
    fn 正片叠底_红乘蓝为黑() {
        // 混合模式取自顶层（与底下的合成）；红(1,0,0)×蓝(0,0,1) 逐通道 = (0,0,0)
        let stack = LayerStack {
            layers: vec![
                solid_layer([255, 0, 0, 255]),
                { let mut l = solid_layer([0, 0, 255, 255]); l.blend_mode = BlendMode::Multiply; l },
            ],
            next_id: 2,
        };
        let px = composite(&stack, 4, 4).get_pixel(0, 0).0;
        assert_close(px, [0, 0, 0, 255], 1, "正片叠底红×蓝应为黑");
    }

    #[test]
    fn 滤色_红屏蓝为品红() {
        let stack = LayerStack {
            layers: vec![
                solid_layer([255, 0, 0, 255]),
                { let mut l = solid_layer([0, 0, 255, 255]); l.blend_mode = BlendMode::Screen; l },
            ],
            next_id: 2,
        };
        let px = composite(&stack, 4, 4).get_pixel(0, 0).0;
        // r: 1+1−1=1；g: 0；b: 0+1−0=1 → 品红
        assert_close(px, [255, 0, 255, 255], 1, "滤色红+蓝应为品红");
    }

    #[test]
    fn 叠加_中灰分支走乘性() {
        // 底 64（0.251）≤0.5 → 2×0.251×0.8 = 0.4016 → 102
        let stack = LayerStack {
            layers: vec![
                solid_layer([64, 64, 64, 255]),
                { let mut l = solid_layer([204, 204, 204, 255]); l.blend_mode = BlendMode::Overlay; l },
            ],
            next_id: 2,
        };
        let px = composite(&stack, 4, 4).get_pixel(0, 0).0;
        assert_close(px, [102, 102, 102, 255], 1, "叠加底≤0.5 走 2·Cb·Cs");
    }

    #[test]
    fn 叠加_亮底分支走屏性() {
        // 底 204（0.8）>0.5 → 1−2×0.2×0.2 = 0.92 → 235
        let stack = LayerStack {
            layers: vec![
                solid_layer([204, 204, 204, 255]),
                { let mut l = solid_layer([204, 204, 204, 255]); l.blend_mode = BlendMode::Overlay; l },
            ],
            next_id: 2,
        };
        let px = composite(&stack, 4, 4).get_pixel(0, 0).0;
        assert_close(px, [235, 235, 235, 255], 1, "叠加底>0.5 走屏性分支");
    }

    #[test]
    fn 不透明度_半透明白盖黑为中灰() {
        let top = { let mut l = solid_layer([255, 255, 255, 255]); l.opacity = 0.5; l };
        let px = blend_top_over_bottom(solid_layer([0, 0, 0, 255]), top);
        // co = 0.5·白 + 0.5·黑 = 0.5 → 128
        assert_close(px, [128, 128, 128, 255], 1, "50% 白盖黑应为中灰");
    }

    #[test]
    fn 半透明源_色彩不偏移只减淡() {
        // 50% 红盖白：co = 0.5·红 + 0.5·白 = (255,128,128) → 淡红而非深粉
        let top = { let mut l = solid_layer([255, 0, 0, 255]); l.opacity = 0.5; l };
        let px = blend_top_over_bottom(solid_layer([255, 255, 255, 255]), top);
        assert_close(px, [255, 128, 128, 255], 1, "半透明红盖白应为淡红");
    }

    #[test]
    fn 空栈合成_全透明() {
        let stack = LayerStack::default();
        let out = composite(&stack, 2, 2);
        assert!(out.pixels().all(|p| p.0 == [0, 0, 0, 0]));
    }

    // —— 栈操作语义 ——

    #[test]
    fn 栈操作_增删排序可见性与活动层() {
        let mut stack = LayerStack::with_base(RgbaImage::new(4, 4));
        let base_id = stack.iter().next().unwrap().id;
        let l1 = stack.add("图层 1", 4, 4);
        let l2 = stack.add("图层 2", 4, 4);
        assert_eq!(stack.len(), 3, "背景 + 2 新层");
        assert_ne!(base_id, l1);
        assert_ne!(l1, l2, "图层 id 互异");

        // 排序：把最底（背景）移到顶
        stack.move_to(base_id, 2).expect("移动到顶");
        assert_eq!(
            stack.iter().map(|l| l.id).collect::<Vec<_>>(),
            vec![l1, l2, base_id],
            "背景层应移到栈顶"
        );

        // 可见性：底白、顶红隐藏 → 合成不含红的贡献，应为白
        let mut stack2 =
            LayerStack::with_base(RgbaImage::from_pixel(4, 4, image::Rgba([255, 255, 255, 255])));
        let red_id = stack2.add("红", 4, 4);
        stack2
            .iter_mut()
            .find(|l| l.id == red_id)
            .unwrap()
            .pixels = RgbaImage::from_pixel(4, 4, image::Rgba([255, 0, 0, 255]));
        stack2.iter_mut().find(|l| l.id == red_id).unwrap().visible = false;
        let px = composite(&stack2, 4, 4).get_pixel(0, 0).0;
        assert_close(px, [255, 255, 255, 255], 0, "隐藏层的贡献不应出现");

        // 删除：最后一张拒绝，其余可删
        assert!(stack.remove(l2).is_ok(), "非最后一张可删");
        assert_eq!(stack.len(), 2);
        // 删到只剩一张后再删应报错
        assert!(stack.remove(base_id).is_ok());
        assert!(stack.remove(l1).is_err(), "最后一张不允许删除");
        // 不存在的 id 报错
        assert!(stack.move_to(999, 0).is_err());
    }

    // —— 填充（选区约束 + 抗锯齿覆盖）——

    #[test]
    fn 填充_无选区整层_有选区只落选区() {
        let mut layer = RgbaImage::new(8, 8);
        // 无选区：整层填红
        fill_layer(&mut layer, None, [255, 0, 0, 255]);
        assert_eq!(layer.get_pixel(0, 0).0, [255, 0, 0, 255]);

        // 矩形选区 (2,2)-(6,6)：只填选区，外部保持
        let mut layer = RgbaImage::new(8, 8);
        let sel = make_selection(
            SelectionShape::Rect { x: 2.0, y: 2.0, w: 4.0, h: 4.0 },
            8,
            8,
        );
        fill_layer(&mut layer, Some(&sel), [0, 255, 0, 255]);
        assert_eq!(layer.get_pixel(3, 3).0, [0, 255, 0, 255], "选区内应被填充");
        assert_eq!(layer.get_pixel(0, 0).0, [0, 0, 0, 0], "选区外应保持原样");
    }

    #[test]
    fn 填充_抗锯齿边缘为部分覆盖() {
        // 左边 x=2.5 的矩形：像素 (2,4) 覆盖 0.5 → 填白到透明层上应得半透明白
        let mut layer = RgbaImage::new(8, 8);
        let sel = make_selection(
            SelectionShape::Rect { x: 2.5, y: 0.0, w: 3.0, h: 8.0 },
            8,
            8,
        );
        fill_layer(&mut layer, Some(&sel), [255, 255, 255, 255]);
        let edge = layer.get_pixel(2, 4).0;
        // αs=0.5、αb=0 → αo=0.5→128，色 = 白（非预乘输出不变）
        assert_close(edge, [255, 255, 255, 128], 2, "半覆盖像素应为 50% 白");
        let inside = layer.get_pixel(4, 4).0;
        assert_close(inside, [255, 255, 255, 255], 0, "全覆盖像素应为纯白");
    }

    #[test]
    fn 填充_半透明色与已有内容合成() {
        // 50% 黑填到不透明白上 → 128 灰
        let mut layer = RgbaImage::from_pixel(4, 4, image::Rgba([255, 255, 255, 255]));
        fill_layer(&mut layer, None, [0, 0, 0, 128]);
        let px = layer.get_pixel(1, 1).0;
        assert_close(px, [128, 128, 128, 255], 1, "半透明黑盖白应为中灰");
    }
}
