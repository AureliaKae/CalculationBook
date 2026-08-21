/* 应用图标生成器：Electron 单窗口页内渲染——SVG 先绘成 1024 画布，再由
   canvas 高质量降采样出各尺寸 PNG（窗口只开一个，避开离屏多窗口的波动）。
   产出 build/icon.png(512) 与 build/icon.ico(16-256 PNG 条目)。设计令牌与
   styles.css 同源（拍板 2026-08-22：图标采用应用配色与主题）——暖奶油画布
   #FFE9CE、白纸卡 #FFFFFF、粗黑描边 #222222、朱红印章 #DC2626；绘本扁平、
   无阴影无渐变。用法：npx electron scripts/icon-gen.cjs */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" rx="226" fill="#FFE9CE"/>
  <g stroke="#222222" stroke-linejoin="round" stroke-linecap="round">
    <path d="M512 316 C 428 252, 292 240, 204 268 L 204 704 C 292 676, 428 688, 512 748 Z" fill="#FFFFFF" stroke-width="34"/>
    <path d="M512 316 C 596 252, 732 240, 820 268 L 820 704 C 732 676, 596 688, 512 748 Z" fill="#FFFFFF" stroke-width="34"/>
    <path d="M512 316 L 512 748" fill="none" stroke-width="30"/>
  </g>
  <g stroke="rgba(34,34,34,0.28)" stroke-width="20" stroke-linecap="round" fill="none">
    <path d="M268 380 C 330 366, 400 368, 452 392"/>
    <path d="M268 462 C 330 448, 400 450, 452 474"/>
    <path d="M572 392 C 624 368, 694 366, 756 380"/>
    <path d="M572 474 C 624 450, 694 448, 756 462"/>
  </g>
  <rect x="668" y="568" width="212" height="212" rx="36" fill="#DC2626" stroke="#222222" stroke-width="26"/>
  <text x="774" y="674" text-anchor="middle" dominant-baseline="central" font-family="'Microsoft YaHei','PingFang SC',sans-serif" font-weight="700" font-size="140" fill="#FFFFFF">书</text>
</svg>`;

const ICO_SIZES = [256, 128, 64, 48, 32, 24, 16];
const PNG_SIZE = 512;

// ICO 容器：PNG 条目（Windows Vista+ 支持），256 用 0 表示。
function packIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + 16 * entries.length;
  const blobs = [];
  entries.forEach((entry, index) => {
    const base = 16 * index;
    const dimension = entry.size >= 256 ? 0 : entry.size;
    dir.writeUInt8(dimension, base);
    dir.writeUInt8(dimension, base + 1);
    dir.writeUInt8(0, base + 2);
    dir.writeUInt8(0, base + 3);
    dir.writeUInt16LE(1, base + 4);
    dir.writeUInt16LE(32, base + 6);
    dir.writeUInt32LE(entry.buf.length, base + 8);
    dir.writeUInt32LE(offset, base + 12);
    offset += entry.buf.length;
    blobs.push(entry.buf);
  });
  return Buffer.concat([header, dir, ...blobs]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      width: 1024,
      height: 1024,
      show: false,
      frame: false,
      webPreferences: { offscreen: false },
    });
    await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent("<body style=\"margin:0\"></body>"));
    const dataUrls = JSON.parse(
      await win.webContents.executeJavaScript(`(async () => {
        const svg = ${JSON.stringify(SVG)};
        const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
        const img = new Image();
        img.src = url;
        await img.decode();
        const sizes = [${[PNG_SIZE, ...ICO_SIZES].join(",")}];
        const out = {};
        for (const size of sizes) {
          const canvas = document.createElement("canvas");
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext("2d");
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = "high";
          ctx.drawImage(img, 0, 0, size, size);
          out[size] = canvas.toDataURL("image/png");
        }
        return JSON.stringify(out);
      })()`),
    );
    win.destroy();
    const buildDir = path.join(__dirname, "..", "build");
    const decode = (dataUrl) => Buffer.from(String(dataUrl).split(",")[1], "base64");
    fs.writeFileSync(path.join(buildDir, "icon.png"), decode(dataUrls[PNG_SIZE]));
    const entries = ICO_SIZES.map((size) => ({ size, buf: decode(dataUrls[size]) }));
    fs.writeFileSync(path.join(buildDir, "icon.ico"), packIco(entries));
    console.log(
      `[icon] icon.png ${PNG_SIZE}px；icon.ico ${ICO_SIZES.join("/")}px 共 ${entries.length} 条目`,
    );
  } catch (error) {
    console.error("[icon] 生成失败：", error);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
