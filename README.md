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
npm run tauri dev                             # 起窗口（M0 骨架：欢迎页）
npm run build                                 # 门禁：tsc && vite build
npm run test                                  # 门禁：vitest run
cargo check --manifest-path src-tauri/Cargo.toml --locked   # 门禁
cargo test  --manifest-path src-tauri/Cargo.toml --locked   # 门禁
```

CI 门禁见 `.github/workflows/ci.yml`（web-gate + rust-gate 双轨）。
图像编解码依赖（image 系等）待选型评审定档后于 M1 引入（docs/图像库选型.md）。
