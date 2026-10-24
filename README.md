# 百工·墨 (Mo)

图像编辑工具，对标 Adobe Photoshop。

产品分析见 [docs/产品分析.md](docs/产品分析.md)，目标与里程碑见 [docs/目标与里程碑.md](docs/目标与里程碑.md)。

属于「百工」项目集群，约定参见上级目录 [AGENTS.md](../AGENTS.md)。

## 开发

Tauri 2 + React，工程形态对齐 `../jian`（vite / tsconfig / vitest）。
坊（fang）以 **alias 联调轨**接入：`vite.config.ts` 的 alias 与 `tsconfig.json` 的
paths 双轨指向 `../fang/src`，本机需有 fang 检出且装好依赖
（`npm ci --prefix ../fang`，CI 里见 workflows 的「检出 fang」步骤）。

```bash
npm install                                   # 前端依赖（生成 package-lock.json）
npm run tauri dev                             # 起窗口（M1：打开/查看/另存 JPG·PNG）
npm run build                                 # 门禁：tsc && vite build
npm run test                                  # 门禁：vitest run
cargo check --manifest-path src-tauri/Cargo.toml --locked   # 门禁
cargo test  --manifest-path src-tauri/Cargo.toml --locked   # 门禁
```

CI 门禁见 `.github/workflows/ci.yml`（web-gate + rust-gate 双轨）。
图像编解码走 `image` crate（选型定案见 docs/图像库选型.md）：JPEG 解码内置
zune-jpeg、PNG 编解码内置 png，内部工作格式 RGBA8，另存时 ICC 元数据原样写回。
M1 完成多标签画布 / 缩放平移（1%–3200%）/ 吸管取色与像素信息；准入场景
「打开 → 放大到像素级查看 → 另存」由 Rust 侧真实文件 roundtrip 测试
（src-tauri/src/imageio.rs）与前端状态层测试（src/core/）共同锁定。

M2 完成图层与选区：文档模型升级为图层栈（增删/排序/可见性/不透明度/
混合模式——正常、正片叠底、滤色、叠加，合成公式取 W3C Compositing Level 1），
矩形/椭圆/套索选区按浮点几何栅格化为抗锯齿蒙版并约束填充；像素事实源与
合成在 Rust 侧（src-tauri/src/layers.rs、selection.rs），前端经 layerPipeline
编排面板与画布（坊 DockHost 图层面板、选区工具 M/O/L、编辑菜单全选/取消/
填充）。准入场景「多图层合成海报底稿并导出 PNG」由 Rust 侧端到端测试锁定
（真实 new_document → 选区填充 → 多层混合 → PNG 导出 → 重新解码校验尺寸
与关键像素，src-tauri/src/imageio.rs `m2_准入_多图层海报底稿_…`）。
