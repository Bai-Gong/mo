//! M1 图像管线：打开（解码→RGBA8 文档）、像素传输、另存（编码 + ICC 写回）。
//! M2 起文档模型升级为图层栈（见 layers.rs）：像素事实源从单张 `pixels` 变为
//! `stack`，`get_pixels`/另存返回**合成结果**（单背景层文档行为与 M1 等价）。
//!
//! 选型定案（docs/图像库选型.md）：image 0.25.x 默认 feature 作总入口——JPEG 解码
//! 走内置 zune-jpeg、PNG 编解码走内置 png 0.18.x；内部工作格式 `RgbaImage`（RGBA8）；
//! 色彩管理 M1 只做 sRGB 假设 + ICC 元数据保全（读出挂在文档上、另存时原样写回），
//! 不做完整 ICC 变换。
//!
//! 像素的事实源在 Rust 侧（`Documents` 注册表）：前端按文档 id 拉合成字节用于
//! 显示与取色，另存由本侧直接从合成像素编码。

use std::collections::HashMap;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngEncoder;
use image::{
    DynamicImage, ExtendedColorType, ImageDecoder, ImageEncoder, ImageFormat, ImageReader,
    RgbaImage,
};
use serde::Serialize;
use tauri::ipc::Response;
use tauri::State;

use crate::history::{self, History};
use crate::layers::{composite, EditResult, LayerStack};
use crate::selection::Selection;

/// 打开文件解码后首层的固定名（Photoshop「背景」惯例）。
pub const LAYER_BASE_NAME: &str = "背景";

/// 打开命令回给前端的文档元信息（camelCase 契约）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedImageInfo {
    pub doc_id: u32,
    pub width: u32,
    pub height: u32,
    /// 是否携带 ICC 色彩配置（状态栏提示「含色彩配置，另存时原样保留」）。
    /// 字节本体只留 Rust 侧，不跨 IPC 传。
    pub has_icc: bool,
    /// 来源格式名（"png" / "jpeg"），另存对话框的默认项。
    pub format: String,
}

/// 图像文档：图层栈 + 选区 + 命令式历史栈 + 打开时读出的 ICC。
///
/// M2 起像素事实源是 `stack`（自底向上）；`composite()` 产出扁平 RGBA8。
/// M3 起 `history` 记录可逆编辑命令（见 history.rs），撤销重做在此栈上运转。
#[derive(Debug)]
pub struct ImageDocument {
    pub width: u32,
    pub height: u32,
    pub stack: LayerStack,
    /// 文档级选区（None = 无选区，填充作用于整层）。
    pub selection: Option<Selection>,
    /// 填充等像素操作的落点图层。
    pub active_layer_id: u32,
    /// 命令式历史栈（撤销/重做/历史面板的事实源）。
    pub history: History,
    pub icc_profile: Option<Vec<u8>>,
    pub format: ImageFormat,
}

impl ImageDocument {
    /// 合成整栈为扁平 RGBA8（get_pixels / 另存 / 导出共用出口）。
    pub fn composite(&self) -> RgbaImage {
        composite(&self.stack, self.width, self.height)
    }
}

/// 文档注册表：多标签画布各持一个 id；像素驻留 Rust 侧内存。
#[derive(Default)]
pub struct Documents {
    next_id: AtomicU32,
    docs: Mutex<HashMap<u32, ImageDocument>>,
}

impl Documents {
    pub fn new() -> Self {
        Self::default()
    }

    /// 登记文档，返回新 id（从 1 起，0 保留为非法值）。
    pub fn insert(&self, doc: ImageDocument) -> u32 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        self.docs
            .lock()
            .expect("文档注册表锁中毒")
            .insert(id, doc);
        id
    }

    /// 借用访问文档；id 不存在（已关闭/从未打开）返回 Err。
    pub fn with_doc<R>(&self, id: u32, f: impl FnOnce(&ImageDocument) -> R) -> Result<R, String> {
        let guard = self.docs.lock().expect("文档注册表锁中毒");
        let doc = guard
            .get(&id)
            .ok_or_else(|| format!("文档 {id} 不存在（可能已关闭）"))?;
        Ok(f(doc))
    }

    /// 可变借用访问（M2 图层/选区操作的落点）。
    pub fn with_doc_mut<R>(
        &self,
        id: u32,
        f: impl FnOnce(&mut ImageDocument) -> R,
    ) -> Result<R, String> {
        let mut guard = self.docs.lock().expect("文档注册表锁中毒");
        let doc = guard
            .get_mut(&id)
            .ok_or_else(|| format!("文档 {id} 不存在（可能已关闭）"))?;
        Ok(f(doc))
    }

    /// 摘除文档（关标签释放内存）。返回是否真的摘到了。
    pub fn remove(&self, id: u32) -> bool {
        self.docs
            .lock()
            .expect("文档注册表锁中毒")
            .remove(&id)
            .is_some()
    }
}

/// 解码磁盘图像文件 → RGBA8 文档（真实管线入口，命令与测试共用）。
///
/// ICC 读取：`ImageDecoder::icc_profile()`——JPEG（zune-jpeg 解析 APP2）与
/// PNG（iCCP chunk）均透传（选型文档已核源码 image `src/codecs/jpeg/decoder.rs:126`、
/// `src/codecs/png.rs:307`）。
pub fn decode_image_file(path: &Path) -> Result<ImageDocument, String> {
    // image 对恶意输入可能 panic（其 CHANGES.md 自列已知问题）——catch_unwind 屏障
    // 让坏文件变成一条错误而不是拖垮进程（选型「风险与待验证」节的低成本兜底；
    // release 的 panic=abort 下不可捕，dev/debug 构建有效）。
    let decoded = std::panic::catch_unwind(|| decode_image_inner(path));
    match decoded {
        Ok(result) => result,
        Err(_) => Err(format!(
            "图像解码器在处理该文件时崩溃（可能为损坏或恶意构造的图像）：{}",
            path.display()
        )),
    }
}

fn decode_image_inner(path: &Path) -> Result<ImageDocument, String> {
    let reader = ImageReader::open(path).map_err(|e| format!("无法打开文件：{e}"))?;
    let reader = reader
        .with_guessed_format()
        .map_err(|e| format!("无法读取文件内容：{e}"))?;
    let format = reader
        .format()
        .ok_or_else(|| format!("无法识别图像格式：{}", path.display()))?;
    let mut decoder = reader
        .into_decoder()
        .map_err(|e| format!("解码器初始化失败：{e}"))?;
    let icc_profile = decoder
        .icc_profile()
        .map_err(|e| format!("读取 ICC 色彩配置失败：{e}"))?;
    let dynamic = DynamicImage::from_decoder(decoder).map_err(|e| format!("解码失败：{e}"))?;
    let (width, height) = (dynamic.width(), dynamic.height());
    // JPG（无 alpha）等格式在此统一补不透明通道，落位选型定案的 RGBA8 工作格式。
    let pixels = dynamic.to_rgba8();
    // M2：解码像素落「背景」图层——单层文档的合成结果与像素本体逐字节一致，
    // M1「打开→查看→另存」行为不变。
    let stack = LayerStack::with_base(pixels);
    let active_layer_id = stack.iter().next().expect("背景层必在").id;
    Ok(ImageDocument {
        width,
        height,
        stack,
        selection: None,
        active_layer_id,
        history: History::default(),
        icc_profile,
        format,
    })
}

/// 新建空白文档（M2 海报合成的起点；也是前端「新建」命令）。
///
/// `background` 为 None → 背景 层全透明；Some(rgba) → 纯色填充。
/// 尺寸收拢到 1–16384（防 0 与天文数字把内存打穿）。
pub fn new_document(
    width: u32,
    height: u32,
    background: Option<[u8; 4]>,
) -> Result<ImageDocument, String> {
    let clamp_dim = |v: u32, name: &str| {
        if v == 0 {
            Err(format!("新建文档的{name}必须大于 0"))
        } else {
            Ok(v.min(16384))
        }
    };
    let width = clamp_dim(width, "宽")?;
    let height = clamp_dim(height, "高")?;
    let mut base = RgbaImage::new(width, height);
    if let Some(color) = background {
        base = RgbaImage::from_pixel(width, height, image::Rgba(color));
    }
    let stack = LayerStack::with_base(base);
    let active_layer_id = stack.iter().next().expect("背景层必在").id;
    Ok(ImageDocument {
        width,
        height,
        stack,
        selection: None,
        active_layer_id,
        history: History::default(),
        icc_profile: None,
        format: ImageFormat::Png,
    })
}

/// 裁剪：把整栈裁到矩形（浮点几何 → 四舍五入到像素边界），文档尺寸随之
/// 变化、选区清空（尺寸变了蒙版随之作废）。条目持有整栈快照供撤销。
///
/// 返回是否真的发生了变更（矩形与整幅相同 → false，不压历史）。
pub fn apply_crop(doc: &mut ImageDocument, x: f64, y: f64, w: f64, h: f64) -> Result<bool, String> {
    if !(w.is_finite() && h.is_finite() && x.is_finite() && y.is_finite()) {
        return Err("裁剪矩形含非有限数值".into());
    }
    let round_clamp = |v: f64, lo: i64, hi: i64| v.round().clamp(lo as f64, hi as f64) as i64;
    let left = round_clamp(x, 0, doc.width as i64);
    let top = round_clamp(y, 0, doc.height as i64);
    let right = round_clamp(x + w, 0, doc.width as i64);
    let bottom = round_clamp(y + h, 0, doc.height as i64);
    if right - left < 1 || bottom - top < 1 {
        let (cw_err, ch_err) = (right - left, bottom - top);
        return Err(format!("裁剪区域过小（{cw_err}×{ch_err}），至少保留 1×1 像素"));
    }
    let (cw, ch) = ((right - left) as u32, (bottom - top) as u32);
    if (left, top) == (0, 0) && (cw, ch) == (doc.width, doc.height) {
        return Ok(false); // 裁剪框 = 整幅，无变更
    }
    let before_layers: Vec<crate::layers::Layer> =
        doc.stack.iter().cloned().collect();
    let (before_width, before_height) = (doc.width, doc.height);
    let active_before = doc.active_layer_id;
    let rect = (left as u32, top as u32, cw, ch);
    for layer in doc.stack.iter_mut() {
        layer.pixels = image::imageops::crop_imm(&layer.pixels, rect.0, rect.1, rect.2, rect.3)
            .to_image();
    }
    doc.width = cw;
    doc.height = ch;
    doc.selection = None;
    doc.history.push(history::HistoryEntry::Crop {
        label: "裁剪".into(),
        rect,
        before_layers,
        before_width,
        before_height,
        active_before,
        active_after: active_before,
    });
    Ok(true)
}

/// 另存格式（M1 支持面，与选型范围一致）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SaveFormat {
    Png,
    Jpeg,
}

impl SaveFormat {
    /// 前端传 "png" / "jpeg"。
    pub fn parse(s: &str) -> Result<Self, String> {
        match s.to_ascii_lowercase().as_str() {
            "png" => Ok(Self::Png),
            "jpeg" | "jpg" => Ok(Self::Jpeg),
            other => Err(format!("M1 不支持的保存格式：{other}（支持 png / jpeg）")),
        }
    }
}

/// 把文档**合成结果**编码写入磁盘（真实管线出口，命令与测试共用）。
///
/// ICC 写回：PngEncoder 写 iCCP、JpegEncoder 写 APP2（image 0.25.6 起的
/// `ImageEncoder::set_icc_profile`，Png/Jpeg 编码器均已实现，选型文档已核）。
/// JPEG 质量 1–100（与 image 编码器同刻度），越界收拢。
pub fn encode_image_file(
    doc: &ImageDocument,
    path: &Path,
    format: SaveFormat,
    quality: u8,
) -> Result<(), String> {
    let file = File::create(path).map_err(|e| format!("无法创建输出文件：{e}"))?;
    let (width, height) = (doc.width, doc.height);
    let composite_pixels = doc.composite();
    let raw = composite_pixels.as_raw();
    match format {
        SaveFormat::Png => {
            let mut encoder = PngEncoder::new(file);
            if let Some(icc) = doc.icc_profile.as_ref() {
                encoder
                    .set_icc_profile(icc.clone())
                    .map_err(|e| format!("写入 ICC 配置失败：{e}"))?;
            }
            encoder
                .write_image(raw, width, height, ExtendedColorType::Rgba8)
                .map_err(|e| format!("PNG 编码失败：{e}"))?;
        }
        SaveFormat::Jpeg => {
            let quality = quality.clamp(1, 100);
            let mut encoder = JpegEncoder::new_with_quality(file, quality);
            if let Some(icc) = doc.icc_profile.as_ref() {
                encoder
                    .set_icc_profile(icc.clone())
                    .map_err(|e| format!("写入 ICC 配置失败：{e}"))?;
            }
            // JPEG 无 alpha：0.25.10 内置编码器只收 L8/Rgb8（源码 encode 的 match
            // 只有这两支），Rgba8 在此显式丢 alpha 转 RGB 后再进编码器。
            let rgb = DynamicImage::ImageRgba8(composite_pixels.clone()).to_rgb8();
            encoder
                .write_image(rgb.as_raw(), width, height, ExtendedColorType::Rgb8)
                .map_err(|e| format!("JPEG 编码失败：{e}"))?;
        }
    }
    Ok(())
}

fn format_name(format: ImageFormat) -> String {
    match format {
        ImageFormat::Jpeg => "jpeg".into(),
        ImageFormat::Png => "png".into(),
        other => format!("{other:?}").to_lowercase(),
    }
}

/// 打开图像文件并登记为文档（前端「打开…」的落点）。
#[tauri::command]
pub fn open_image(path: String, documents: State<Documents>) -> Result<OpenedImageInfo, String> {
    let doc = decode_image_file(&PathBuf::from(path))?;
    let info = OpenedImageInfo {
        doc_id: 0,
        width: doc.width,
        height: doc.height,
        has_icc: doc.icc_profile.is_some(),
        format: format_name(doc.format),
    };
    let doc_id = documents.insert(doc);
    Ok(OpenedImageInfo { doc_id, ..info })
}

/// 新建空白文档（前端「新建」的落点）。background 为 None = 透明背景，
/// Some([r,g,b,a]) = 纯色背景层。
#[tauri::command]
pub fn new_document_cmd(
    width: u32,
    height: u32,
    background: Option<[u8; 4]>,
    documents: State<Documents>,
) -> Result<OpenedImageInfo, String> {
    let doc = new_document(width, height, background)?;
    let info = OpenedImageInfo {
        doc_id: 0,
        width: doc.width,
        height: doc.height,
        has_icc: false,
        format: "png".into(),
    };
    let doc_id = documents.insert(doc);
    Ok(OpenedImageInfo { doc_id, ..info })
}

/// 取文档合成像素（RGBA8，width×height×4 字节；M2 起为图层栈合成结果）。
///
/// 走 `tauri::ipc::Response` 原始字节通道：不经 JSON 数组序列化，
/// 前端 invoke 直接拿到 ArrayBuffer。
#[tauri::command]
pub fn get_pixels(doc_id: u32, documents: State<Documents>) -> Result<Response, String> {
    documents.with_doc(doc_id, |doc| {
        Response::new(doc.composite().into_raw())
    })
}

/// 另存文档（前端「另存为…」的落点）。quality 仅 JPEG 生效（1–100）。
#[tauri::command]
pub fn save_document(
    doc_id: u32,
    path: String,
    format: String,
    quality: u8,
    documents: State<Documents>,
) -> Result<(), String> {
    let format = SaveFormat::parse(&format)?;
    documents.with_doc(doc_id, |doc| {
        encode_image_file(doc, &PathBuf::from(path), format, quality)
    })?
}

/// 关闭文档释放 Rust 侧驻留像素（关标签时调用）。
#[tauri::command]
pub fn close_document(doc_id: u32, documents: State<Documents>) -> bool {
    documents.remove(doc_id)
}

/// 裁剪文档（整栈 + 尺寸）。矩形为图像坐标浮点几何，四舍五入到像素边界。
#[tauri::command]
pub fn crop_document(
    doc_id: u32,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    documents: State<Documents>,
) -> Result<EditResult, String> {
    documents.with_doc_mut(doc_id, |doc| {
        apply_crop(doc, x, y, w, h)?;
        Ok(EditResult {
            layers: crate::layers::snapshot(doc),
            history: doc.history.info(),
            width: doc.width,
            height: doc.height,
        })
    })?
}

/// 撤销一步（无可撤销时安静返回当前状态）。
#[tauri::command]
pub fn undo(doc_id: u32, documents: State<Documents>) -> Result<EditResult, String> {
    documents.with_doc_mut(doc_id, |doc| {
        history::undo(doc);
        EditResult {
            layers: crate::layers::snapshot(doc),
            history: doc.history.info(),
            width: doc.width,
            height: doc.height,
        }
    })
}

/// 重做一步。
#[tauri::command]
pub fn redo(doc_id: u32, documents: State<Documents>) -> Result<EditResult, String> {
    documents.with_doc_mut(doc_id, |doc| {
        history::redo(doc);
        EditResult {
            layers: crate::layers::snapshot(doc),
            history: doc.history.info(),
            width: doc.width,
            height: doc.height,
        }
    })
}

/// 历史面板跳转：退/进到「第 target 条已应用」（0 = 初始状态）。
#[tauri::command]
pub fn history_jump(
    doc_id: u32,
    target: u32,
    documents: State<Documents>,
) -> Result<EditResult, String> {
    documents.with_doc_mut(doc_id, |doc| {
        history::jump(doc, target);
        EditResult {
            layers: crate::layers::snapshot(doc),
            history: doc.history.info(),
            width: doc.width,
            height: doc.height,
        }
    })
}

/// 历史面板一次拉取（标签打开/切换时刷新面板用）。
#[tauri::command]
pub fn get_history(
    doc_id: u32,
    documents: State<Documents>,
) -> Result<history::HistoryInfo, String> {
    documents.with_doc(doc_id, |doc| doc.history.info())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layers::{apply_fill, apply_select_all, apply_selection, BlendMode};
    use crate::selection::SelectionShape;

    // —— 测试用具：真实磁盘文件（temp 目录），走 decode/encode 真实管线 ——

    /// 每测试独占的临时文件路径（进程 id + 计数器避免并发测试互踩）。
    fn temp_path(name: &str) -> PathBuf {
        static SEQ: AtomicU32 = AtomicU32::new(0);
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let mut p = std::env::temp_dir();
        p.push(format!("mo-m2-{}-{n}-{name}", std::process::id()));
        p
    }

    /// 64×64 四象限纯色样张：红/绿/蓝/白，各象限 32×32（块中心采样远离 8×8 边界，
    /// JPEG 有损往返的断言点取在各象限中心，色差只来自压缩本身）。
    /// M2 起样张像素落「背景」单层（M1 打开文件的等价形态）。
    fn sample_doc(icc: Option<Vec<u8>>) -> ImageDocument {
        let mut img = RgbaImage::new(64, 64);
        for (x, y, color) in [
            (0u32, 0u32, [255u8, 0, 0, 255]),
            (32, 0, [0, 255, 0, 255]),
            (0, 32, [0, 0, 255, 255]),
            (32, 32, [255, 255, 255, 255]),
        ] {
            for dy in 0..32 {
                for dx in 0..32 {
                    img.put_pixel(x + dx, y + dy, image::Rgba(color));
                }
            }
        }
        let stack = LayerStack::with_base(img);
        let active_layer_id = stack.iter().next().unwrap().id;
        ImageDocument {
            width: 64,
            height: 64,
            stack,
            selection: None,
            active_layer_id,
            history: History::default(),
            icc_profile: icc,
            format: ImageFormat::Png,
        }
    }

    fn fake_icc() -> Vec<u8> {
        // 任意字节即可：png iCCP / jpeg APP2 均按不透明负载读写，管线不解析内容
        (0..64u32).map(|i| (i * 7 % 251) as u8).collect()
    }

    fn assert_channel_close(actual: [u8; 4], expected: [u8; 4], tol: i32, ctx: &str) {
        for ch in 0..4 {
            let diff = (actual[ch] as i32 - expected[ch] as i32).abs();
            assert!(
                diff <= tol,
                "{ctx} 第 {ch} 通道差 {diff} 超容差 {tol}：实际 {actual:?} 期望 {expected:?}"
            );
        }
    }

    // —— 准入场景「打开 → 查看 → 另存」的 Rust 侧真实往返（M1，图层模型下回归） ——

    #[test]
    fn png_往返_像素无损且_icc_保全() {
        let path = temp_path("roundtrip.png");
        let doc = sample_doc(Some(fake_icc()));
        encode_image_file(&doc, &path, SaveFormat::Png, 0).expect("PNG 编码写盘");

        // 「打开」：真实磁盘文件 → 真实 png 解码管线
        let reopened = decode_image_file(&path).expect("重新打开");
        assert_eq!((reopened.width, reopened.height), (64, 64));
        // PNG 无损：逐字节相等（单背景层：合成 == 像素本体）
        assert_eq!(
            reopened.composite().as_raw(), doc.composite().as_raw(),
            "PNG 往返必须像素无损"
        );
        // 元数据保全：iCCP 原样写回、原样读出
        assert_eq!(reopened.icc_profile.as_deref(), Some(fake_icc().as_slice()));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn jpeg_往返_尺寸精确_象限中心色在容差内_icc_保全() {
        let path = temp_path("roundtrip.jpg");
        let doc = sample_doc(Some(fake_icc()));
        encode_image_file(&doc, &path, SaveFormat::Jpeg, 90).expect("JPEG 编码写盘");

        let reopened = decode_image_file(&path).expect("重新打开");
        assert_eq!((reopened.width, reopened.height), (64, 64), "尺寸必须精确保持");
        let composite = reopened.composite();
        // JPEG 有损：象限中心（(16,16)/(48,16)/(16,48)/(48,48)）色在容差内
        for (x, y, expect) in [
            (16u32, 16u32, [255u8, 0, 0, 255]),
            (48, 16, [0, 255, 0, 255]),
            (16, 48, [0, 0, 255, 255]),
            (48, 48, [255, 255, 255, 255]),
        ] {
            let px = composite.get_pixel(x, y).0;
            assert_channel_close(px, expect, 16, &format!("象限中心 ({x},{y})"));
        }
        // JPEG 无 alpha：解码后统一补不透明
        for px in composite.pixels() {
            assert_eq!(px.0[3], 255, "JPEG 往返后 alpha 应统一为不透明");
        }
        // APP2 ICC 往返
        assert_eq!(reopened.icc_profile.as_deref(), Some(fake_icc().as_slice()));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn 打开_不存在路径与坏文件_返回错误而非崩溃() {
        let missing = temp_path("不存在.png");
        let err = decode_image_file(&missing).expect_err("不存在路径必须报错");
        assert!(err.contains("无法打开文件"), "错误信息应可读：{err}");

        let garbage = temp_path("garbage.png");
        std::fs::write(&garbage, b"this is definitely not an image").expect("写测试文件");
        let err = decode_image_file(&garbage).expect_err("非图像内容必须报错");
        assert!(!err.is_empty());
        let _ = std::fs::remove_file(&garbage);
    }

    #[test]
    fn 注册表_多文档_id_互异_摘除后访问报错() {
        let docs = Documents::new();
        let a = docs.insert(sample_doc(None));
        let b = docs.insert(sample_doc(None));
        assert_ne!(a, b, "两个文档的 id 必须互异（多标签画布的前提）");

        // 合成像素经注册表可取（get_pixels 命令的内核路径）
        let len = docs
            .with_doc(a, |doc| doc.composite().as_raw().len())
            .expect("登记后可访问");
        assert_eq!(len, 64 * 64 * 4, "RGBA8 字节长度应为 w*h*4");

        // with_doc_mut：M2 图层操作路径
        let stack_len = docs
            .with_doc_mut(a, |doc| {
                doc.stack.add("图层 1", doc.width, doc.height);
                doc.stack.len()
            })
            .expect("可变访问");
        assert_eq!(stack_len, 2, "注册表上应能加层");

        assert!(docs.remove(a), "摘除已存在的文档应返回 true");
        assert!(
            docs.with_doc(a, |_| ()).is_err(),
            "摘除后再访问应报错（get_pixels 同路径）"
        );
        assert!(!docs.remove(a), "重复摘除应返回 false");
    }

    #[test]
    fn 保存格式_只收_png_jpeg() {
        assert_eq!(SaveFormat::parse("png"), Ok(SaveFormat::Png));
        assert_eq!(SaveFormat::parse("JPEG"), Ok(SaveFormat::Jpeg));
        assert_eq!(SaveFormat::parse("jpg"), Ok(SaveFormat::Jpeg));
        assert!(SaveFormat::parse("webp").is_err(), "M1 范围外格式应拒绝");
    }

    // —— 新建文档 ——

    #[test]
    fn 新建文档_尺寸收拢与背景填充() {
        let doc = new_document(320, 240, Some([255, 255, 255, 255])).expect("新建");
        assert_eq!((doc.width, doc.height), (320, 240));
        assert_eq!(doc.stack.len(), 1, "新文档应有背景层");
        assert_eq!(doc.stack.iter().next().unwrap().name, LAYER_BASE_NAME);
        assert_eq!(
            doc.composite().get_pixel(0, 0).0,
            [255, 255, 255, 255],
            "指定白色背景应生效"
        );

        let transparent = new_document(8, 8, None).expect("新建透明");
        assert_eq!(
            transparent.composite().get_pixel(3, 3).0,
            [0, 0, 0, 0],
            "未指定背景应全透明"
        );

        assert!(new_document(0, 10, None).is_err(), "零宽必须报错");
        let huge = new_document(99999, 10, None).expect("超大尺寸收拢不报错");
        assert_eq!(huge.width, 16384, "宽应钳到 16384");
    }

    // —— M2 准入场景：多图层合成海报底稿并导出 PNG（真实管线端到端） ——
    //
    // 海报布版（320×240，自底向上）：
    //   背景    白色（new_document 生成）
    //   天空带  矩形选区 y∈[20.5,120.5]（半像素边 → 抗锯齿行）填充玉米花蓝，正常 100%
    //   太阳    椭圆选区 中心(250,60) r30 填充向日葵黄，正常 100%
    //   暗角    全选填充浅灰(200,200,200)，正片叠底 100%（整体压暗）
    //   标题带  矩形选区 y∈[160,200] 填充红色，滤色 50%
    //   斜杠    套索三角形 (200,230)(260,140)(300,230) 填充绿色，正常 100%
    // 期望色全部手算（W3C 合成公式代入具体数值），见各断言处注释。
    #[test]
    fn m2_准入_多图层海报底稿_合成导出_png_校验尺寸与关键像素() {
        const W: u32 = 320;
        const H: u32 = 240;
        let mut doc = new_document(W, H, Some([255, 255, 255, 255])).expect("新建海报底稿");

        // —— 图层与填充编排（与图层命令同一条内核路径）——
        // 天空带：半像素上边（y=20.5）→ 第 20 行覆盖 0.5（抗锯齿行）
        apply_selection(
            &mut doc,
            SelectionShape::Rect { x: 0.0, y: 20.5, w: 320.0, h: 100.0 },
        );
        let sky_id = doc.stack.add("天空", W, H);
        doc.active_layer_id = sky_id;
        apply_fill(&mut doc, [100, 149, 237, 255]).expect("填充天空");

        // 太阳：椭圆，中心 (250,60)，两轴半径 30
        apply_selection(
            &mut doc,
            SelectionShape::Ellipse { cx: 250.0, cy: 60.0, rx: 30.0, ry: 30.0 },
        );
        let sun_id = doc.stack.add("太阳", W, H);
        doc.active_layer_id = sun_id;
        apply_fill(&mut doc, [255, 215, 0, 255]).expect("填充太阳");

        // 暗角：全选 + 正片叠底浅灰
        apply_select_all(&mut doc);
        let veil_id = doc.stack.add("暗角", W, H);
        doc.active_layer_id = veil_id;
        apply_fill(&mut doc, [200, 200, 200, 255]).expect("填充暗角");
        doc.stack
            .iter_mut()
            .find(|l| l.id == veil_id)
            .unwrap()
            .blend_mode = BlendMode::Multiply;

        // 标题带：滤色 50% 红色
        apply_selection(
            &mut doc,
            SelectionShape::Rect { x: 0.0, y: 160.0, w: 320.0, h: 40.0 },
        );
        let title_id = doc.stack.add("标题带", W, H);
        doc.active_layer_id = title_id;
        apply_fill(&mut doc, [255, 0, 0, 255]).expect("填充标题带");
        {
            let layer = doc.stack.iter_mut().find(|l| l.id == title_id).unwrap();
            layer.blend_mode = BlendMode::Screen;
            layer.opacity = 0.5;
        }

        // 斜杠：套索三角形，绿色
        apply_selection(
            &mut doc,
            SelectionShape::Lasso {
                points: vec![[200.0, 230.0], [260.0, 140.0], [300.0, 230.0]],
            },
        );
        let slash_id = doc.stack.add("斜杠", W, H);
        doc.active_layer_id = slash_id;
        apply_fill(&mut doc, [0, 128, 0, 255]).expect("填充斜杠");

        assert_eq!(doc.stack.len(), 6, "背景 + 5 个内容图层");

        // —— 导出 PNG（真实编码管线）→ 重新打开（真实解码管线）——
        let path = temp_path("poster.png");
        encode_image_file(&doc, &path, SaveFormat::Png, 0).expect("海报导出 PNG");
        let reopened = decode_image_file(&path).expect("重新打开导出的海报");
        let out = reopened.composite();
        assert_eq!(
            (reopened.width, reopened.height),
            (W, H),
            "导出 PNG 尺寸必须精确保持"
        );
        assert!(
            out.pixels().all(|p| p.0[3] == 255),
            "海报底稿不透明白底：合成 alpha 应全为 255"
        );

        // —— 关键像素校验（期望值手算，注释给出算式；容差吸收逐层取整误差）——
        // 角落 (2,2)：白底 × 暗角(200/255) = (200,200,200)
        assert_channel_close(out.get_pixel(2, 2).0, [200, 200, 200, 255], 2, "白底暗角角");
        // 天空内部 (160,70)：玉米花蓝(100,149,237) × 200/255 = (78,117,186)
        assert_channel_close(out.get_pixel(160, 70).0, [78, 117, 186, 255], 2, "天空内部");
        // 太阳中心 (250,60)：向日葵黄(255,215,0) × 200/255 = (200,169,0)
        assert_channel_close(out.get_pixel(250, 60).0, [200, 169, 0, 255], 2, "太阳中心");
        // 标题带内部 (160,180)：暗角灰(200) 上滤色 50% 红 →
        //   B = (1, 0.784, 0.784)；co = 0.5·B + 0.5·Cb = (0.892, 0.784, 0.784) → (228,200,200)
        assert_channel_close(out.get_pixel(160, 180).0, [228, 200, 200, 255], 3, "标题带内部");
        // 斜杠内部 (253,200)：顶层不透明绿 (0,128,0)
        assert_channel_close(out.get_pixel(253, 200).0, [0, 128, 0, 255], 1, "斜杠内部");

        // —— 抗锯齿证据（导出后的像素级断言）——
        // 天空带上半像素边（y=20.5）：第 20 行覆盖 0.5。逐层算：
        //   填充后层像素 = 0.5·蓝（alpha 128）→ 合成到白底得 (177,202,246)
        //   → 暗角乘 200/255 → (139,158,193)
        assert_channel_close(out.get_pixel(160, 20).0, [139, 158, 193, 255], 3, "天空抗锯齿行");
        // 对照：整行覆盖的 21 行应为纯天空×暗角 (78,117,186)
        assert_channel_close(out.get_pixel(160, 21).0, [78, 117, 186, 255], 2, "天空满覆盖行");

        // 太阳斜边：沿理想圆周采样 ±1 像素，至少一个像素为「天蓝暗角色」与
        // 「太阳暗角色」之间的中间值（部分覆盖 → 椭圆边缘抗锯齿存在）
        let (cx, cy, r) = (250.0f64, 60.0f64, 30.0f64);
        let low = [78.0f32, 117.0, 186.0]; // 圆外（天空×暗角）
        let high = [200.0f32, 169.0, 0.0]; // 圆内（太阳×暗角）
        let mut found_partial = false;
        for deg in 0..360 {
            let rad = deg as f64 * std::f64::consts::PI / 180.0;
            let ex = cx + r * rad.cos();
            let ey = cy + r * rad.sin();
            for dy in -1i32..=1 {
                for dx in -1i32..=1 {
                    let px = (ex.floor() as i32 + dx).clamp(0, W as i32 - 1) as u32;
                    let py = (ey.floor() as i32 + dy).clamp(0, H as i32 - 1) as u32;
                    let c = out.get_pixel(px, py).0;
                    let between = (0..3).all(|ch| {
                        let v = c[ch] as f32;
                        let (lo, hi) = if low[ch] <= high[ch] {
                            (low[ch] + 12.0, high[ch] - 12.0)
                        } else {
                            (high[ch] + 12.0, low[ch] - 12.0)
                        };
                        v > lo && v < hi
                    });
                    if between {
                        found_partial = true;
                    }
                }
            }
        }
        assert!(
            found_partial,
            "太阳椭圆边缘应存在部分覆盖的中间值像素（抗锯齿）"
        );

        // —— 状态变化影响合成（同文档内直接验证，不出盘）——
        // 隐藏暗角层：天空内部回到纯玉米花蓝
        doc.stack
            .iter_mut()
            .find(|l| l.id == veil_id)
            .unwrap()
            .visible = false;
        let live = doc.composite();
        assert_channel_close(live.get_pixel(160, 70).0, [100, 149, 237, 255], 1, "隐藏暗角后天空");
        // 恢复暗角、把斜杠移到最底（排序语义）：该点不再被顶层斜杠覆盖。
        // 无斜杠时的本底值：标题带矩形 y∈[160,200) 半开，不含第 200 行 →
        // 该点只有 白×暗角 = (200,200,200)
        doc.stack
            .iter_mut()
            .find(|l| l.id == veil_id)
            .unwrap()
            .visible = true;
        doc.stack.move_to(slash_id, 0).expect("移动斜杠到底");
        let reordered = doc.composite();
        assert_channel_close(
            reordered.get_pixel(253, 200).0,
            [200, 200, 200, 255],
            2,
            "斜杠沉底后不再覆盖该点",
        );
        // 而太阳中心不受斜杠沉底影响
        assert_channel_close(reordered.get_pixel(250, 60).0, [200, 169, 0, 255], 2, "太阳不受排序影响");

        let _ = std::fs::remove_file(&path);
    }

    /// 选区持久性与取消选择：同一选区连续两次填充、取消后整层填充。
    #[test]
    fn 选区_跨操作保持_取消后整层填充() {
        let mut doc = new_document(8, 8, None).expect("新建");
        let base_id = doc.stack.iter().next().unwrap().id;
        doc.active_layer_id = base_id;
        apply_selection(
            &mut doc,
            SelectionShape::Rect { x: 2.0, y: 2.0, w: 4.0, h: 4.0 },
        );
        apply_fill(&mut doc, [255, 0, 0, 255]).expect("第一次填充");
        apply_fill(&mut doc, [255, 0, 0, 255]).expect("第二次填充（选区仍在）");
        let layer = &doc.stack.iter().next().unwrap().pixels;
        assert_eq!(layer.get_pixel(3, 3).0, [255, 0, 0, 255], "选区内被填充");
        assert_eq!(layer.get_pixel(0, 0).0, [0, 0, 0, 0], "选区外两次填充都不落");

        crate::layers::apply_clear_selection(&mut doc);
        apply_fill(&mut doc, [0, 0, 255, 255]).expect("无选区整层填充");
        let layer = &doc.stack.iter().next().unwrap().pixels;
        assert_eq!(layer.get_pixel(0, 0).0, [0, 0, 255, 255], "取消选区后整层填充");
    }

    // —— M3 准入场景：从零画一张图（中途含改错与回退）——
    //
    // 场景编排（与产品路径同一条内核：new_document → edit_stroke → 撤销 →
    // 重做 → 继续绘制 → 导出 PNG → 重新打开）：
    //   1. 从零新建 96×64 白底文档；
    //   2. 画笔绘「地平线」（绿色横线，正确的一笔）；
    //   3. 画笔绘「太阳」——画错了（位置偏出构图，红色斜线）；
    //   4. 撤销（回退错误一笔）→ 验证红线消失、绿线仍在、历史游标回退；
    //   5. 重做（改回主意，保留太阳）→ 验证红线精确复现；
    //   6. 继续绘制（蓝色第二笔地平线）→ 验证历史前进、新笔落位；
    //   7. 中途撤销两次再重做两次（历史面板跳转的内核路径）；
    //   8. 导出 PNG（真实编码）→ 重新打开（真实解码）→ 校验尺寸与关键像素。
    #[test]
    fn m3_准入_从零画图_改错回退_撤销重做后继续绘制_导出_png() {
        use crate::history::{redo, undo as undo_one};
        use crate::layers::edit_fill;
        use crate::paint::edit_stroke;

        const W: u32 = 96;
        const H: u32 = 64;
        let mut doc = new_document(W, H, Some([255, 255, 255, 255])).expect("从零新建白底文档");
        assert_eq!(doc.history.info().index, 0, "新文档历史为空");

        // 1) 正确的一笔：地平线（绿色横线，y≈44）
        edit_stroke(&mut doc, &[[8.0, 44.0], [88.0, 44.0]], 2.0, [34, 139, 34, 255], false)
            .expect("画地平线");
        // 2) 改错的一笔：太阳画偏了（红色斜线，扎到天空外）
        edit_stroke(&mut doc, &[[60.0, 8.0], [92.0, 2.0]], 2.5, [255, 0, 0, 255], false)
            .expect("画错位的太阳");
        let (index, labels) = {
            let info = doc.history.info();
            (info.index, info.entries)
        };
        assert_eq!(index, 2, "两笔各压一条历史");
        assert_eq!(labels, vec!["画笔", "画笔"], "历史面板标签应为两条画笔");
        let wrong_stroke_px = doc.composite().get_pixel(76, 5).0;
        assert_eq!(wrong_stroke_px, [255, 0, 0, 255], "错误一笔应可见（红色）");

        // 3) 撤销：回退错误的一笔
        assert!(undo_one(&mut doc));
        assert_eq!(doc.history.info().index, 1, "撤销后游标回退一格");
        let c = doc.composite();
        assert_eq!(
            c.get_pixel(76, 5).0,
            [255, 255, 255, 255],
            "撤销后错误一笔应消失（回到白底）"
        );
        assert_eq!(
            c.get_pixel(48, 45).0,
            [34, 139, 34, 255],
            "撤销只回退最后一笔，地平线应保留"
        );

        // 4) 重做：改回主意，太阳回来（逐字节精确复现）
        assert!(redo(&mut doc));
        assert_eq!(doc.history.info().index, 2);
        assert_eq!(
            doc.composite().get_pixel(76, 5).0,
            wrong_stroke_px,
            "重做后错误一笔应精确复现（供继续修改）"
        );

        // 5) 继续绘制：蓝色第二笔（水面）
        edit_stroke(&mut doc, &[[8.0, 54.0], [88.0, 54.0]], 1.5, [30, 90, 210, 255], false)
            .expect("继续绘制水面");
        assert_eq!(doc.history.info().index, 3, "继续绘制历史前进");
        assert_eq!(
            doc.composite().get_pixel(48, 54).0,
            [30, 90, 210, 255],
            "继续绘制的新笔应落位（线芯像素满覆盖）"
        );

        // 6) 历史面板跳转内核：退两格（回到只有地平线）再进两格回来
        crate::history::jump(&mut doc, 1);
        let c = doc.composite();
        assert_eq!(c.get_pixel(76, 5).0, [255, 255, 255, 255], "跳转后太阳应消失");
        assert_eq!(c.get_pixel(48, 54).0, [255, 255, 255, 255], "跳转后水面应消失");
        assert_eq!(c.get_pixel(48, 45).0, [34, 139, 34, 255], "地平线仍在");
        crate::history::jump(&mut doc, 3);
        let c = doc.composite();
        assert_eq!(c.get_pixel(76, 5).0, [255, 0, 0, 255], "跳回最前后全部复现");
        assert_eq!(c.get_pixel(48, 54).0, [30, 90, 210, 255]);

        // 7) 再来一次「改错与回退」：错误填充后撤销（填充也走同一历史栈）
        edit_fill(&mut doc, [0, 0, 0, 255]).expect("整层误填黑");
        assert_eq!(doc.composite().get_pixel(2, 2).0, [0, 0, 0, 255], "误填生效");
        assert!(undo_one(&mut doc));
        assert_eq!(
            doc.composite().get_pixel(2, 2).0,
            [255, 255, 255, 255],
            "撤销误填后回到绘制结果"
        );
        assert_eq!(
            doc.history.info().entries.last().map(String::as_str),
            Some("填充"),
            "填充也压历史（内容操作与结构操作同栈）"
        );

        // 8) 导出 PNG → 重新打开（真实编解码管线）
        let path = temp_path("m3-drawing.png");
        encode_image_file(&doc, &path, SaveFormat::Png, 0).expect("导出 PNG");
        let reopened = decode_image_file(&path).expect("重新打开");
        let out = reopened.composite();
        assert_eq!((reopened.width, reopened.height), (W, H), "尺寸必须精确保持");
        // 关键像素：地平线绿 / 太阳红 / 水面蓝 / 留白白底
        assert_eq!(out.get_pixel(48, 45).0, [34, 139, 34, 255], "地平线");
        assert_eq!(out.get_pixel(76, 5).0, [255, 0, 0, 255], "太阳（重做保留）");
        assert_eq!(out.get_pixel(48, 54).0, [30, 90, 210, 255], "水面");
        assert_eq!(out.get_pixel(2, 2).0, [255, 255, 255, 255], "白底");
        let _ = std::fs::remove_file(&path);
    }

    /// M3 裁剪：整栈裁剪 + 撤销复原（尺寸与像素）+ 重做。
    #[test]
    fn 裁剪_整栈裁剪_撤销复原_重做复现() {
        use crate::layers::edit_fill;

        // 两层文档：白底 + 红色涂鸦层
        let mut doc = new_document(16, 16, Some([255, 255, 255, 255])).expect("新建");
        crate::layers::edit_add_layer(&mut doc);
        edit_fill(&mut doc, [255, 0, 0, 255]).expect("涂红");
        assert_eq!((doc.width, doc.height), (16, 16));

        // 裁到右下 8×8
        apply_crop(&mut doc, 8.0, 8.0, 8.0, 8.0).expect("裁剪");
        assert_eq!((doc.width, doc.height), (8, 8), "裁剪后尺寸应变化");
        for layer in doc.stack.iter() {
            assert_eq!(layer.pixels.dimensions(), (8, 8), "每层都应随裁剪变尺寸");
        }
        assert!(
            doc.composite().pixels().all(|p| p.0 == [255, 0, 0, 255]),
            "裁出的区域两层皆满色，合成应为红"
        );
        assert_eq!(doc.history.info().entries.last().map(String::as_str), Some("裁剪"));

        // 撤销：尺寸与两层像素完全复原
        assert!(crate::history::undo(&mut doc));
        assert_eq!((doc.width, doc.height), (16, 16), "撤销裁剪应复原尺寸");
        assert_eq!(doc.stack.len(), 2, "撤销裁剪不撤图层结构");
        let px = doc.composite().get_pixel(4, 4).0;
        assert_eq!(px, [255, 0, 0, 255], "左上区域应复原为红（涂鸦层在最上）");

        // 重做：再裁一次，与首次结果一致
        assert!(crate::history::redo(&mut doc));
        assert_eq!((doc.width, doc.height), (8, 8));
        assert!(
            doc.composite().pixels().all(|p| p.0 == [255, 0, 0, 255]),
            "重做裁剪应精确复现"
        );

        // 整幅裁剪 = 无操作（不压历史）
        let before = doc.history.info();
        assert!(!apply_crop(&mut doc, 0.0, 0.0, 8.0, 8.0).expect("整幅裁剪"));
        assert_eq!(doc.history.info().index, before.index, "整幅裁剪不压历史");
        // 过小矩形报错
        assert!(apply_crop(&mut doc, 4.0, 4.0, 0.2, 0.2).is_err());
    }
}
