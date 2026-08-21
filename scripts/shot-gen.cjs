/* README 截图生成器：开一个高分屏窗口（zoomFactor 2 ≈ 3160×1920 物理像素）
   走 mock 桥过一遍真实流程——案头 → 开题 → 推演台（含行事选项），每个
   阶段截一张 PNG 存 docs/screenshots/。统一米纸亮色主题。
   前置：dev 服务器在 5173 端口。用法：npx electron scripts/shot-gen.cjs */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const OUT_DIR = path.join(__dirname, "..", "docs", "screenshots");
// Windows 钳制窗口不超屏幕：1920 宽就是这台机器的上限；README 展示宽 ≤984px，
// 1920 已是 2 倍视网膜余量。
const WIDTH = 1920;
const HEIGHT = 1040;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function capture(win, name) {
  // 等入场动画收尾（GSAP 弹入 ≤1s）再截，画面干净。
  await wait(1600);
  const image = await win.webContents.capturePage();
  const file = path.join(OUT_DIR, `${name}.png`);
  fs.writeFileSync(file, image.toPNG());
  console.log(`[shot] ${name}.png ${image.getSize().width}x${image.getSize().height}`);
}

// React 受控输入需要走原生 setter，否则 dispatch 的 input 事件不带值。
const CLICK_BY_TEXT = `(txt) => {
  const el = [...document.querySelectorAll("button")].find((b) => b.textContent.includes(txt));
  if (el) { el.click(); return true; }
  return false;
}`;

const FILL_INPUT = `(label, value) => {
  const el = document.querySelector(\`input[aria-label="\${label}"]\`);
  if (!el) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}`;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      show: false,
      frame: false,
      useContentSize: true,
    });
    // 先到源再定主题（localStorage 按源隔离），定成米纸后重载；缩放在加载后
    // 设 2 倍，capturePage 按物理像素出图（3160×1920）。
    await win.loadURL("http://localhost:5173/");
    await win.webContents.executeJavaScript("localStorage.setItem('cp-theme','paper')");
    await win.loadURL("http://localhost:5173/");

    await capture(win, "desk");

    if (!(await win.webContents.executeJavaScript(`(${CLICK_BY_TEXT})("听雨剑录")`))) {
      throw new Error("书卡未找到");
    }
    await wait(900);
    await capture(win, "creation");

    await win.webContents.executeJavaScript(`(${CLICK_BY_TEXT})("男")`);
    await win.webContents.executeJavaScript(`(${FILL_INPUT})("角色姓名", "沈听雨")`);
    await win.webContents.executeJavaScript(`(${CLICK_BY_TEXT})("选落点")`);
    await wait(400);
    await win.webContents.executeJavaScript(`(${CLICK_BY_TEXT})("归元寺山门")`);
    await wait(300);
    await win.webContents.executeJavaScript(`(${CLICK_BY_TEXT})("选境界")`);
    await wait(400);
    await win.webContents.executeJavaScript(`(${CLICK_BY_TEXT})("些许拳脚")`);
    await wait(300);
    if (!(await win.webContents.executeJavaScript(`(${CLICK_BY_TEXT})("落笔入卷")`))) {
      throw new Error("落笔入卷未找到");
    }
    await wait(1800);
    await capture(win, "reading");

    // 再落一笔拿行事选项画面（推演台最有钱的一张）。
    await win.webContents.executeJavaScript(`(${FILL_INPUT})("落笔：写下此刻意图", "在寺中挂单避雨")`);
    await wait(300);
    await win.webContents.executeJavaScript(`(${CLICK_BY_TEXT})("落笔")`);
    await wait(3200);
    await capture(win, "options");

    win.destroy();
    console.log("[shot] done");
  } catch (error) {
    console.error("[shot] 失败：", error);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
