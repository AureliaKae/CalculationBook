// 桥接层：Electron 里走 preload 注入的 window.calculationpaper；
// 纯浏览器打开（设计走查/离线演示）时回退到同形状的 mock 桥。
import { mockBridge } from "./mock-bridge.js";

export const api = window.calculationpaper ?? mockBridge;
