//! M4 调整（非破坏）：亮度 / 曲线 / 色相三种调整的像素数学与参数校验。
//!
//! 调整以**图层**形式挂在图层栈上（见 layers.rs `LayerKind::Adjustment`）：
//! 合成时对「位于其下所有层的合成结果」逐像素运算，不改动任何下层像素——
//! 关闭/删除/下移调整图层即回到未调整状态（Photoshop 调整图层语义）。
//!
//! 三种调整的口径：
//! - **亮度**：线性平移 `v + amount·255`（amount ∈ [-1,1]，UI 显示 -100..100）；
//! - **曲线**：控制点（0..255，x 严格递增）经 Fritsch–Carlson **单调三次
//!   Hermite** 插值生成 256 项 LUT，对 R/G/B 三通道同曲线应用（复合曲线）；
//!   单调插值保证不出现过冲振铃（对比度曲线的安全性质）。
//! - **色相**：RGB→HSL→色相旋转（度）→RGB，饱和度/亮度不动；无彩色像素
//!   （max==min）恒等返回。
//!
//! 图层不透明度对调整层的语义 = 原值与调整值按 opacity 线性混合
//! （`out = lerp(orig, adjusted, opacity)`，Photoshop 同观感）；混合模式对
//! 调整层无意义（不参与）。

use serde::{Deserialize, Serialize};

use crate::layers::to_u8; // hue_shift 的 HSL 逆变换在 [0,1] 刻度上取整

/// [0,255] → u8，半进位取整。调整链路以 0..255 浮点为工作刻度（与合成的
/// [0,1] 刻度不同，勿混用 layers::to_u8）。
#[inline]
fn to_u8_255(v: f32) -> u8 {
    (v.clamp(0.0, 255.0) + 0.5) as u8
}

/// 单条调整参数（serde tag=type，前端契约：brightness/curves/hue）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Adjustment {
    /// 线性亮度平移。amount ∈ [-1,1]（负压暗、正提亮）。
    Brightness { amount: f32 },
    /// 曲线：控制点 [x, y]（均 0..255，x 严格递增），单调三次样条插值。
    Curves { points: Vec<[f32; 2]> },
    /// 色相旋转（度，正=顺色轮）。饱和度/亮度保持。
    Hue { degrees: f32 },
}

/// 曲线控制点数量上限（拖拽加点防爆炸）。
pub const CURVES_MAX_POINTS: usize = 16;

impl Adjustment {
    /// 面板显示名（图层命名与历史标签共用）。
    pub fn kind_name(&self) -> &'static str {
        match self {
            Adjustment::Brightness { .. } => "亮度",
            Adjustment::Curves { .. } => "曲线",
            Adjustment::Hue { .. } => "色相",
        }
    }

    /// 参数校验与归一（命令入口必经）：
    /// - 亮度 amount 钳到 [-1,1]；色相 degrees 钳到 [-360,360]；
    /// - 曲线要求 ≥2 个点、x 严格递增（排序后判重）、坐标钳到 [0,255]、
    ///   点数 ≤ 上限（超出报错——前端拖拽不应产生这么多点）。
    /// 非法输入返回可读错误（前端原样透传给用户）。
    pub fn normalize(&self) -> Result<Adjustment, String> {
        match self {
            Adjustment::Brightness { amount } => {
                if !amount.is_finite() {
                    return Err("亮度参数须为有限数值".into());
                }
                Ok(Adjustment::Brightness { amount: amount.clamp(-1.0, 1.0) })
            }
            Adjustment::Curves { points } => {
                if points.len() < 2 {
                    return Err("曲线至少需要 2 个控制点".into());
                }
                if points.len() > CURVES_MAX_POINTS {
                    return Err(format!("曲线控制点过多（{}），上限 {CURVES_MAX_POINTS}", points.len()));
                }
                let mut normalized: Vec<[f32; 2]> = points
                    .iter()
                    .map(|[x, y]| {
                        [
                            x.clamp(0.0, 255.0),
                            y.clamp(0.0, 255.0),
                        ]
                    })
                    .collect();
                normalized.sort_by(|a, b| a[0].total_cmp(&b[0]));
                for w in normalized.windows(2) {
                    // 排序后仍相等（同 x 重复点）→ 插值区间宽度为 0，拒绝
                    if (w[0][0] - w[1][0]).abs() < f32::EPSILON {
                        return Err("曲线控制点的 x 不能重复".into());
                    }
                }
                Ok(Adjustment::Curves { points: normalized })
            }
            Adjustment::Hue { degrees } => {
                if !degrees.is_finite() {
                    return Err("色相参数须为有限数值".into());
                }
                Ok(Adjustment::Hue { degrees: degrees.clamp(-360.0, 360.0) })
            }
        }
    }

    /// 把调整应用到合成累积缓冲（RGBA8 非预乘，逐像素改 RGB、alpha 不动）。
    /// opacity 为图层不透明度（0..1）：原值与调整值线性混合。
    pub fn apply_to(&self, acc: &mut [u8], opacity: f32) {
        let mix = |orig: f32, adjusted: f32| to_u8_255(orig + (adjusted - orig) * opacity);
        match self {
            Adjustment::Brightness { amount } => {
                let shift = amount * 255.0;
                for px in acc.chunks_exact_mut(4) {
                    for ch in 0..3 {
                        let v = px[ch] as f32;
                        px[ch] = mix(v, v + shift);
                    }
                }
            }
            Adjustment::Curves { points } => {
                let lut = curves_lut(points);
                for px in acc.chunks_exact_mut(4) {
                    for ch in 0..3 {
                        let v = px[ch] as usize;
                        px[ch] = mix(v as f32, lut[v]);
                    }
                }
            }
            Adjustment::Hue { degrees } => {
                for px in acc.chunks_exact_mut(4) {
                    let rgb = [px[0], px[1], px[2]];
                    let shifted = hue_shift(rgb, *degrees);
                    for ch in 0..3 {
                        px[ch] = mix(rgb[ch] as f32, shifted[ch] as f32);
                    }
                }
            }
        }
    }
}

// —— 曲线（单调三次 Hermite，Fritsch–Carlson 切线） ——

/// 生成 256 项 LUT：lut[v] = 曲线在 x=v 处的值（v=0..255 整数格点）。
/// 输入应为 `normalize` 后的合法点列；空/单点退化为恒等（防御，正常不可达）。
pub fn curves_lut(points: &[[f32; 2]]) -> [f32; 256] {
    let mut lut = [0.0f32; 256];
    if points.len() < 2 {
        for (i, v) in lut.iter_mut().enumerate() {
            *v = i as f32;
        }
        return lut;
    }
    // 相邻段斜率
    let n = points.len() - 1;
    let mut slope = vec![0.0f32; n];
    for i in 0..n {
        let dx = points[i + 1][0] - points[i][0];
        slope[i] = if dx.abs() < f32::EPSILON {
            0.0
        } else {
            (points[i + 1][1] - points[i][1]) / dx
        };
    }
    // Fritsch–Carlson 切线：端点取邻段斜率；内点在单调段取调和平均的 1/3 权
    // （等价 3m₁m₂/(m₁+m₂)），极值点（斜率变号）置 0——保证不过冲。
    let mut tangents = vec![0.0f32; points.len()];
    tangents[0] = slope[0];
    tangents[n] = slope[n - 1];
    for i in 1..n {
        if slope[i - 1] * slope[i] <= 0.0 {
            tangents[i] = 0.0;
        } else {
            tangents[i] = 3.0 * (slope[i - 1] * slope[i]) / (slope[i - 1] + slope[i]);
        }
    }
    for (i, v) in lut.iter_mut().enumerate() {
        let x = i as f32;
        // 定位所在段（点列已按 x 升序；x 超出首尾由端点段外延的钳制处理）
        let seg = points
            .windows(2)
            .position(|w| x >= w[0][0] && x <= w[1][0])
            .unwrap_or(if x < points[0][0] { 0 } else { n - 1 });
        let (x0, y0) = (points[seg][0], points[seg][1]);
        let (x1, y1) = (points[seg + 1][0], points[seg + 1][1]);
        let dx = x1 - x0;
        if dx.abs() < f32::EPSILON {
            *v = y0.clamp(0.0, 255.0);
            continue;
        }
        let t = ((x - x0) / dx).clamp(0.0, 1.0);
        let h00 = 2.0 * t * t * t - 3.0 * t * t + 1.0;
        let h10 = t * t * t - 2.0 * t * t + t;
        let h01 = -2.0 * t * t * t + 3.0 * t * t;
        let h11 = t * t * t - t * t;
        let y = h00 * y0
            + h10 * dx * tangents[seg]
            + h01 * y1
            + h11 * dx * tangents[seg + 1];
        *v = y.clamp(0.0, 255.0);
    }
    lut
}

// —— 色相（HSL 旋转） ——

/// 单像素色相旋转（度）。无彩色（max==min）恒等。返回新 RGB。
fn hue_shift(rgb: [u8; 3], degrees: f32) -> [u8; 3] {
    let [r, g, b] = [rgb[0] as f32 / 255.0, rgb[1] as f32 / 255.0, rgb[2] as f32 / 255.0];
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    if max == min {
        return rgb; // 灰阶：色相无定义，保持
    }
    let l = (max + min) / 2.0;
    let d = max - min;
    let s = if l <= 0.5 { d / (max + min) } else { d / (2.0 - max - min) };
    // 色相（度，0..360）
    let h = if max == r {
        60.0 * (((g - b) / d) % 6.0)
    } else if max == g {
        60.0 * ((b - r) / d + 2.0)
    } else {
        60.0 * ((r - g) / d + 4.0)
    };
    let h = if h < 0.0 { h + 360.0 } else { h };
    let h = (h + degrees).rem_euclid(360.0);
    // HSL → RGB（标准 sextant 逆变换）
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let hp = h / 60.0;
    let x = c * (1.0 - (hp % 2.0 - 1.0).abs());
    let (r1, g1, b1) = match hp as u32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let m = l - c / 2.0;
    [
        to_u8(r1 + m),
        to_u8(g1 + m),
        to_u8(b1 + m),
    ]
}#[cfg(test)]
mod tests {
    use super::*;

    /// 单像素应用（绕开合成，直接验证调整数学；期望值全部手算）。
    fn apply_px(adj: &Adjustment, px: [u8; 4], opacity: f32) -> [u8; 4] {
        let mut buf = px;
        adj.apply_to(&mut buf, opacity);
        buf
    }

    fn assert_close(actual: f32, expected: f32, tol: f32, ctx: &str) {
        assert!(
            (actual - expected).abs() <= tol,
            "{ctx}：实际 {actual} 期望 {expected}（容差 {tol}）"
        );
    }

    #[test]
    fn 亮度_线性平移_半进位取整() {
        // +0.2：100+51=151；100+0.2*255=151 精确
        let out = apply_px(&Adjustment::Brightness { amount: 0.2 }, [100, 100, 100, 255], 1.0);
        assert_eq!(out, [151, 151, 151, 255], "亮度 +0.2 应平移 +51");
        // -0.5：100-127.5=-27.5 → 钳 0
        let out = apply_px(&Adjustment::Brightness { amount: -0.5 }, [100, 100, 100, 200], 1.0);
        assert_eq!(out, [0, 0, 0, 200], "压暗越界应钳 0，alpha 不动");
        // 上越界钳 255
        let out = apply_px(&Adjustment::Brightness { amount: 1.0 }, [200, 200, 200, 255], 1.0);
        assert_eq!(out, [255, 255, 255, 255]);
    }

    #[test]
    fn 亮度_不透明度_按原值与调整值线性混合() {
        // orig=100、adjusted=151、opacity=0.5 → 100+25.5=125.5 → 半进位 126
        let out = apply_px(&Adjustment::Brightness { amount: 0.2 }, [100, 100, 100, 255], 0.5);
        assert_eq!(out, [126, 126, 126, 255], "opacity 0.5 应取原值与调整值的中点");
        // opacity 0 → 原样
        let out = apply_px(&Adjustment::Brightness { amount: 0.2 }, [100, 100, 100, 255], 0.0);
        assert_eq!(out, [100, 100, 100, 255]);
    }

    #[test]
    fn 曲线_恒等曲线_像素不变() {
        let adj = Adjustment::Curves { points: vec![[0.0, 0.0], [255.0, 255.0]] };
        for v in [0u8, 1, 64, 128, 200, 254, 255] {
            let out = apply_px(&adj, [v, v, v, 255], 1.0);
            assert_eq!(out, [v, v, v, 255], "恒等曲线应逐字节不变（v={v}）");
        }
    }

    #[test]
    fn 曲线_控制点精确过点_且中间单调() {
        // 提亮暗部：[(0,0),(64,96),(255,255)]——x=64 应精确过 y=96
        let lut = curves_lut(&[[0.0, 0.0], [64.0, 96.0], [255.0, 255.0]]);
        assert_eq!(lut[0], 0.0, "起点过 (0,0)");
        assert_eq!(lut[64], 96.0, "中间控制点应精确过点");
        assert_eq!(lut[255], 255.0, "终点过 (255,255)");
        // 单调性：LUT 全程不降（无振铃）
        for i in 1..256 {
            assert!(lut[i] >= lut[i - 1] - 1e-4, "曲线必须单调不降（i={i}）");
        }
        // 暗部确实被抬升、亮部几乎不动
        assert!(lut[16] > 16.0, "暗部应抬升");
        assert!((lut[240] - 240.0).abs() < 8.0, "亮部应基本保持（拖尾段斜率≈1）");
    }

    #[test]
    fn 曲线_极值点不过冲() {
        // U 形曲线（先降后升）：拐点段切线置 0，值域不得冲出 [min(y), max(y)]
        let pts = vec![[0.0, 64.0], [128.0, 0.0], [255.0, 192.0]];
        let lut = curves_lut(&pts);
        for (i, &v) in lut.iter().enumerate() {
            assert!(v >= -1e-4 && v <= 255.0 + 1e-4, "值域钳制（i={i} v={v}）");
            // 关键安全性质：不冲出控制点值域（单调三次保证）
            assert!(v >= 0.0 && v <= 192.0, "U 形曲线不应冲出 [0,192]（i={i} v={v}）");
        }
        assert_eq!(lut[128], 0.0, "谷底控制点精确过点");
    }

    #[test]
    fn 色相_红旋转120度为绿_负120度为蓝_往返恒等() {
        // HSL 色轮：0°红 / 60°黄 / 120°绿 / 180°青 / 240°蓝 / 300°品红
        let red = [255, 0, 0, 255];
        let green = apply_px(&Adjustment::Hue { degrees: 120.0 }, red, 1.0);
        assert_eq!(green, [0, 255, 0, 255], "红+120°=绿");
        let blue = apply_px(&Adjustment::Hue { degrees: -120.0 }, red, 1.0);
        assert_eq!(blue, [0, 0, 255, 255], "红−120°=蓝");
        // 一来回 = 恒等（旋转 mod 360）
        let back = apply_px(&Adjustment::Hue { degrees: 240.0 }, green, 1.0);
        assert_eq!(back, red, "绿+240° 应回到红");
    }

    #[test]
    fn 色相_灰阶恒等_黄旋转120度到青_不透明度混合() {
        // 灰阶不动
        let gray = apply_px(&Adjustment::Hue { degrees: 120.0 }, [128, 128, 128, 255], 1.0);
        assert_eq!(gray, [128, 128, 128, 255], "无彩色色相无定义，应保持");
        // 黄 (255,255,0) H=60° → +120° = 180° 青 (0,255,255)
        let cyan = apply_px(&Adjustment::Hue { degrees: 120.0 }, [255, 255, 0, 255], 1.0);
        assert_eq!(cyan, [0, 255, 255, 255], "黄+120°=青");
        // 半透明混合：黄→青 各半 → (128,255,128)
        let mix = apply_px(&Adjustment::Hue { degrees: 120.0 }, [255, 255, 0, 255], 0.5);
        assert_eq!(mix, [128, 255, 128, 255], "opacity 0.5 应为黄与青的中点");
    }

    #[test]
    fn 参数归一_越界钳制_非法拒绝() {
        assert_eq!(
            Adjustment::Brightness { amount: 3.0 }.normalize(),
            Ok(Adjustment::Brightness { amount: 1.0 })
        );
        assert_eq!(
            Adjustment::Hue { degrees: 720.0 }.normalize(),
            Ok(Adjustment::Hue { degrees: 360.0 })
        );
        assert!(Adjustment::Curves { points: vec![] }.normalize().is_err(), "空点列拒绝");
        assert!(
            Adjustment::Curves { points: vec![[0.0, 0.0], [0.0, 255.0]] }.normalize().is_err(),
            "重复 x 拒绝"
        );
        // 乱序点列排序后合法
        let sorted = Adjustment::Curves { points: vec![[255.0, 255.0], [0.0, 0.0]] }.normalize();
        assert_eq!(
            sorted,
            Ok(Adjustment::Curves { points: vec![[0.0, 0.0], [255.0, 255.0]] })
        );
        // 越界坐标钳到 [0,255]
        let clamped = Adjustment::Curves { points: vec![[-10.0, -5.0], [300.0, 999.0]] }.normalize();
        assert_eq!(
            clamped,
            Ok(Adjustment::Curves { points: vec![[0.0, 0.0], [255.0, 255.0]] })
        );
    }

    #[test]
    fn 曲线_lut_随点数与位置稳定() {
        // 三点 S 曲线的中点近似抬升（手算参考：x=128 位于 (64,96)-(255,255) 段前部）
        let lut = curves_lut(&[[0.0, 0.0], [64.0, 96.0], [255.0, 255.0]]);
        assert_close(lut[128], 150.0, 30.0, "S 曲线中点应在抬升区间");
    }
}
