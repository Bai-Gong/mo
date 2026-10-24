import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { setupWindowControls } from "./shell/windowControls";
import "./styles/global.css";

// 坊 TitleBar 的窗口三键接线（渲染前注入，见 windowControls.ts）
setupWindowControls();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
