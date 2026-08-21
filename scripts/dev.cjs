const { spawn } = require("node:child_process");
const { join } = require("node:path");
const electron = require("electron");

const env = { ...process.env, VITE_DEV_SERVER_URL: "http://localhost:5173" };
delete env.ELECTRON_RUN_AS_NODE;

const vite = spawn(process.execPath, [join(process.cwd(), "node_modules", "vite", "bin", "vite.js")], {
  cwd: process.cwd(),
  env,
  stdio: ["inherit", "pipe", "inherit"],
});

let app = null;
let started = false;
let exiting = false;

// 统一收尾：两个子进程一起清，别留下只杀 vite 不杀 electron 的孤儿。
function shutdown(code = 0) {
  if (exiting) return;
  exiting = true;
  if (app && !app.killed) app.kill();
  vite.kill();
  process.exit(code);
}

// Vite 起不来（端口占用、配置错误）时给出报错退出，不再无限挂起。
const readyTimer = setTimeout(() => {
  if (!started) {
    console.error("[dev] Vite 在 30 秒内没有就绪，退出（检查端口与配置）。");
    shutdown(1);
  }
}, 30_000);

vite.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  if (started || !String(chunk).includes("ready in")) return;
  started = true;
  clearTimeout(readyTimer);
  app = spawn(electron, ["."], { cwd: process.cwd(), env, stdio: "inherit" });
  app.on("exit", (code) => shutdown(code ?? 0));
});

// dev server 先死而 Electron 还活着 = 白屏窗口：一起退出。
vite.on("exit", (code) => shutdown(started ? 0 : code ?? 1));
vite.on("error", (error) => {
  console.error("[dev] Vite 启动失败：", error.message);
  shutdown(1);
});

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
