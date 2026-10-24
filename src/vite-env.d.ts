/// <reference types="vite/client" />

// fang alias 联调轨下，"@baigong/fang/tokens.css" 这类说明符由 vite alias 解析，
// tsc 侧靠此通配声明通过类型检查。
declare module "*.css";
