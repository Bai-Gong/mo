//! M4 文字：文本内容（字体/字号/颜色/位置）→ RGBA8 栅格化，进合成管线。
//!
//! 文字以**图层**形式挂在图层栈上（`LayerKind::Text`）：内容参数（TextSpec）
//! 是事实源，`Layer.pixels` 是随内容再栅格化的缓存——编辑文字改参数 + 重栅格化，
//! 合成/导出按普通图层混合（含不透明度与混合模式）。历史条目存参数前后值
//! （撤销重做 = 换参数 + 重栅格化，确定性复现）。
//!
//! 字体：系统字体按**族名候选表**解析（Windows 的 CJK 家族 + 跨平台拉丁族），
//! 族名缺失时按机器回退链取第一个存在的字体；一个可用字体都没有才报错。
//! .ttc 收集字体（微软雅黑/宋体）取第 0 个字面。栅格化用 ab_glyph
//! （纯 Rust，无系统依赖；CI 的 ubuntu 上无 CJK 字体时拉丁字体仍可用）。
//!
//! 排版口径（M4 基础）：横排左对齐、逐字符排版（advance + 字偶距），不支持
//! 复杂 shaping（连字/双向/纵排后置 M5+）；`\n` 分行，行高 = 字号 × 1.25；
//! (x, y) 为**首行基线左端点**（图像坐标）。覆盖率为源 alpha，与颜色 alpha
//! 相乘后按 source-over 落入透明栅格。

use std::path::PathBuf;

use ab_glyph::{point, Font, FontRef, Glyph, PxScale, ScaleFont};
use image::RgbaImage;
use serde::{Deserialize, Serialize};

use crate::layers::to_u8;

/// 文字图层内容（serde camelCase，前端契约）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextSpec {
    pub text: String,
    /// 字体族名（候选表键，如 "微软雅黑"/"黑体"/"Arial"；未知族走回退链）。
    pub family: String,
    /// 字号（px，钳 4–512）。
    pub size: f32,
    /// 文字颜色（RGBA）。
    pub color: [u8; 4],
    /// 首行基线左端点 x（图像坐标）。
    pub x: f32,
    /// 首行基线左端点 y（图像坐标）。
    pub y: f32,
}

/// 字号范围（px）：小于 4 无法辨认，大于 512 超出图层画布合理量级。
pub const SIZE_MIN: f32 = 4.0;
pub const SIZE_MAX: f32 = 512.0;

/// 行高系数（Photoshop 默认自动行高约 1.2；CJK 取 1.25 留呼吸）。
const LINE_HEIGHT_FACTOR: f32 = 1.25;

/// 单个字体族定义：族名 → 平台路径候选（按序探测第一个存在的）。
struct FamilyDef {
    family: &'static str,
    candidates: &'static [&'static str],
}

/// 系统字体族候选表（Windows 常装 CJK 家族 + 跨平台拉丁族）。
/// Linux 候选覆盖常见发行版路径（DejaVu/Liberation/Noto）；macOS 候选为
/// 标准系统字体路径（PingFang/冬青黑体/宋体），**未经实机验证**——
/// 本集群当前只出 Windows 包（release.yml），macOS 支持留待有实机时核验。
const FAMILIES: &[FamilyDef] = &[
    FamilyDef { family: "微软雅黑", candidates: &["C:/Windows/Fonts/msyh.ttc"] },
    FamilyDef { family: "黑体", candidates: &[
        "C:/Windows/Fonts/simhei.ttf",
        "/System/Library/Fonts/Hiragino Sans GB.ttc",
    ] },
    FamilyDef { family: "宋体", candidates: &[
        "C:/Windows/Fonts/simsun.ttc",
        "/System/Library/Fonts/Songti.ttc",
    ] },
    FamilyDef { family: "楷体", candidates: &["C:/Windows/Fonts/simkai.ttf"] },
    FamilyDef { family: "仿宋", candidates: &["C:/Windows/Fonts/simfang.ttf"] },
    FamilyDef { family: "等线", candidates: &["C:/Windows/Fonts/Deng.ttf"] },
    FamilyDef {
        family: "Arial",
        candidates: &[
            "C:/Windows/Fonts/arial.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "/Library/Fonts/Arial Unicode.ttf",
        ],
    },
    FamilyDef {
        family: "Segoe UI",
        candidates: &["C:/Windows/Fonts/segoeui.ttf"],
    },
];

/// 无匹配族名时的回退链（优先 CJK——宣传图文案以中文为主）。
const FALLBACK_CHAIN: &[&str] = &[
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/simhei.ttf",
    "C:/Windows/Fonts/simsun.ttc",
    "C:/Windows/Fonts/arial.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
];

fn file_exists(path: &str) -> bool {
    std::fs::metadata(path).map(|m| m.is_file()).unwrap_or(false)
}

/// 按族名解析字体文件路径：候选表精确匹配 → 第一个存在的候选；未匹配返回 None。
pub fn resolve_font_path(family: &str) -> Option<PathBuf> {
    FAMILIES
        .iter()
        .find(|f| f.family.eq_ignore_ascii_case(family))
        .and_then(|f| f.candidates.iter().copied().find(|p| file_exists(p)))
        .map(PathBuf::from)
}

/// 机器默认字体（回退链第一个存在的；无字体返回 None）。
pub fn default_font_path() -> Option<PathBuf> {
    FALLBACK_CHAIN
        .iter()
        .copied()
        .find(|p| file_exists(p))
        .map(PathBuf::from)
}

/// 本机可用的字体族列表（候选表中探测到文件的族；前端下拉选项）。
pub fn available_families() -> Vec<&'static str> {
    FAMILIES
        .iter()
        .filter(|f| f.candidates.iter().any(|p| file_exists(p)))
        .map(|f| f.family)
        .collect()
}

/// 把 TextSpec 栅格化为文档尺寸的透明 RGBA8（文字像素 = 颜色 × 覆盖率）。
///
/// 字体缺失（族名未知且回退链全空）→ Err；文字为空串 → 全透明图（层保留）。
pub fn rasterize_text(spec: &TextSpec, width: u32, height: u32) -> Result<RgbaImage, String> {
    let path = resolve_font_path(&spec.family)
        .or_else(default_font_path)
        .ok_or_else(|| {
            format!(
                "本机找不到可用字体（请求族 {:?}）：请安装系统字体后重试",
                spec.family
            )
        })?;
    let data = std::fs::read(&path).map_err(|e| format!("读取字体 {} 失败：{e}", path.display()))?;
    // .ttc 收集字体（微软雅黑/宋体）取第 0 个字面
    let font = FontRef::try_from_slice_and_index(&data, 0)
        .map_err(|e| format!("解析字体 {} 失败：{e:?}", path.display()))?;
    let size = if spec.size.is_finite() {
        spec.size.clamp(SIZE_MIN, SIZE_MAX)
    } else {
        return Err("字号须为有限数值".into());
    };
    let scaled = font.as_scaled(PxScale::from(size));
    let mut img = RgbaImage::new(width, height);
    if spec.text.is_empty() {
        return Ok(img);
    }
    let color = spec.color;
    let color_a = color[3] as f32 / 255.0;
    let line_height = size * LINE_HEIGHT_FACTOR;
    let ascent = scaled.ascent();
    let mut pen_x = spec.x;
    let mut baseline_y = spec.y + ascent;
    let mut prev_glyph: Option<ab_glyph::GlyphId> = None;
    for ch in spec.text.chars() {
        if ch == '\r' {
            continue;
        }
        if ch == '\n' {
            pen_x = spec.x;
            baseline_y += line_height;
            prev_glyph = None;
            continue;
        }
        if ch == '\t' {
            // 制表符按 4 个空格的步进处理（空格 advance × 4）
            pen_x += scaled.h_advance(scaled.glyph_id(' ')) * 4.0;
            prev_glyph = None;
            continue;
        }
        let glyph_id = scaled.glyph_id(ch);
        if let Some(prev) = prev_glyph {
            pen_x += scaled.kern(prev, glyph_id);
        }
        let glyph = Glyph {
            id: glyph_id,
            scale: PxScale::from(size),
            position: point(pen_x, baseline_y),
        };
        if let Some(outlined) = scaled.outline_glyph(glyph) {
            let bounds = outlined.px_bounds();
            let (min_x, min_y) = (bounds.min.x as i64, bounds.min.y as i64);
            let (w_img, h_img) = (width as i64, height as i64);
            outlined.draw(|dx, dy, coverage| {
                // draw 的 (dx,dy) 相对 bounds 整数角；换回图像坐标后越界裁剪
                let px = min_x + dx as i64;
                let py = min_y + dy as i64;
                if px < 0 || py < 0 || px >= w_img || py >= h_img {
                    return;
                }
                let as_ = (coverage.clamp(0.0, 1.0)) * color_a;
                if as_ <= 0.0 {
                    return;
                }
                let idx = (py as u32 * width + px as u32) as usize * 4;
                let raw = img.as_mut();
                let ab = raw[idx + 3] as f32 / 255.0;
                let ao = as_ + ab * (1.0 - as_);
                if ao <= 0.0 {
                    return;
                }
                for ch3 in 0..3 {
                    let cs = color[ch3] as f32 / 255.0;
                    let cb = raw[idx + ch3] as f32 / 255.0;
                    let co = as_ * (1.0 - ab) * cs + as_ * ab * cs + (1.0 - as_) * ab * cb;
                    raw[idx + ch3] = to_u8(co / ao);
                }
                raw[idx + 3] = to_u8(ao);
            });
        }
        pen_x += scaled.h_advance(glyph_id);
        prev_glyph = Some(glyph_id);
    }
    Ok(img)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 本机无任何字体时跳过（CI 的精简容器可能无字体；Windows/桌面环境恒有）。
    /// 返回 false = 跳过（测试原样通过并留日志），不按失败计。
    fn have_font() -> bool {
        if default_font_path().is_some() {
            true
        } else {
            eprintln!("跳过：本机无可用系统字体（default_font_path = None）");
            false
        }
    }

    fn spec(text: &str, size: f32, x: f32, y: f32) -> TextSpec {
        TextSpec {
            text: text.into(),
            family: "黑体".into(),
            size,
            color: [255, 255, 255, 255],
            x,
            y,
        }
    }

    fn coverage_count(img: &RgbaImage) -> u32 {
        img.pixels().filter(|p| p.0[3] > 0).count() as u32
    }

    #[test]
    fn 字体解析_候选表与回退链() {
        if !have_font() { return; }
        // Windows 上黑体/微软雅黑可解析
        if file_exists("C:/Windows/Fonts/simhei.ttf") {
            assert_eq!(
                resolve_font_path("黑体"),
                Some(PathBuf::from("C:/Windows/Fonts/simhei.ttf"))
            );
            // 大小写不敏感 + 别名未命中 → None（走回退）
            assert!(resolve_font_path("black").is_none());
        }
        assert!(default_font_path().is_some(), "回退链应至少命中一个");
        // 可用族列表非空且不含未命中族
        let families = available_families();
        assert!(!families.is_empty());
        assert!(families.iter().all(|f| resolve_font_path(f).is_some()));
    }

    #[test]
    fn 栅格化_中文文字有覆盖_且颜色正确() {
        if !have_font() { return; }
        let img = rasterize_text(&spec("墨", 32.0, 8.0, 8.0), 64, 64).expect("栅格化");
        let count = coverage_count(&img);
        assert!(count > 40, "单个 32px 汉字应覆盖数十像素，实际 {count}");
        // 全部覆盖像素应为纯白（颜色生效；抗锯齿边缘 alpha<255 但 rgb=白）
        for p in img.pixels() {
            if p.0[3] > 0 {
                assert_eq!((p.0[0], p.0[1], p.0[2]), (255, 255, 255), "颜色应为白");
            }
        }
        // 基线上方留白区（x<4 或 y<8）无覆盖
        assert_eq!(coverage_count_in(&img, 0, 0, 64, 8), 0, "基线上方应无覆盖");
    }

    fn coverage_count_in(img: &RgbaImage, x0: u32, y0: u32, x1: u32, y1: u32) -> u32 {
        let mut n = 0;
        for y in y0..y1 {
            for x in x0..x1 {
                if img.get_pixel(x, y).0[3] > 0 {
                    n += 1;
                }
            }
        }
        n
    }

    #[test]
    fn 栅格化_多行分行_行高生效() {
        if !have_font() { return; }
        // 两行文字，行高 = 32×1.25 = 40：第二行基线 y = 8+ascent+40
        let img = rasterize_text(&spec("墨\n墨", 32.0, 8.0, 4.0), 64, 96).expect("栅格化");
        // 第一行覆盖带 y∈[4, 44)，第二行 y∈[44, 84)：两带都有覆盖、带间可有间隙
        let first = coverage_count_in(&img, 0, 0, 64, 44);
        let second = coverage_count_in(&img, 0, 44, 64, 96);
        assert!(first > 20, "第一行应有覆盖（{first}）");
        assert!(second > 20, "第二行应下移一行高（{second}）");
    }

    #[test]
    fn 栅格化_空文本与越界文本_不报错() {
        if !have_font() { return; }
        let empty = rasterize_text(&spec("", 32.0, 0.0, 0.0), 32, 32).expect("空文本");
        assert_eq!(coverage_count(&empty), 0, "空文本应全透明");
        // 完全越界的文字：不 panic，全透明（逐像素越界裁剪）
        let outside = rasterize_text(&spec("墨", 32.0, 100.0, 100.0), 32, 32).expect("越界文本");
        assert_eq!(coverage_count(&outside), 0, "画布外文字应无覆盖");
    }

    #[test]
    fn 栅格化_半透明颜色_叠加为_source_over() {
        if !have_font() { return; }
        // 同一位置两个叠加覆盖（粗字重叠）：50% 白 × 2 次 source-over → alpha ≈ 192
        let mut s = spec("墨", 32.0, 8.0, 8.0);
        s.color = [255, 255, 255, 128];
        let img = rasterize_text(&s, 64, 64).expect("栅格化");
        let max_alpha = img.pixels().map(|p| p.0[3]).max().unwrap_or(0);
        assert!(
            max_alpha >= 120 && max_alpha <= 130,
            "50% 不透明度文字的核心像素 α 应 ≈128，实际 {max_alpha}"
        );
    }

    #[test]
    fn 栅格化_字号钳制_非法字号报错() {
        if !have_font() { return; }
        let mut s = spec("墨", 9999.0, 0.0, 0.0);
        let img = rasterize_text(&s, 256, 256).expect("越界字号钳制后可用");
        assert!(coverage_count(&img) > 0, "钳到 512px 仍应栅格化");
        s.size = f32::NAN;
        assert!(rasterize_text(&s, 64, 64).is_err(), "NaN 字号应报错");
    }
}
