import { createRoot } from "react-dom/client";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import App from "./App.jsx";
import ErrorBoundary from "./components/ErrorBoundary.jsx";

/* 字体（拍板 2026-08-21 Fiction 版）：本地打包 Cossette Texte/Titre（拉丁）
   + JetBrains Mono；CSP 'self' 下自托管，汉字回退系统圆体。 */
import "@fontsource/cossette-texte/latin-400.css";
import "@fontsource/cossette-texte/latin-700.css";
import "@fontsource/cossette-titre/latin-400.css";
import "@fontsource/cossette-titre/latin-700.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-700.css";

import "./styles.css";

gsap.registerPlugin(ScrollTrigger);

createRoot(document.getElementById("root")).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
