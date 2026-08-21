// userData 目录定名与品牌更名迁移。
// 独立成模块（不 import electron）便于纯 Node 单测。
import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";

// 数据目录显式钉在 ASCII 名：productName「推演书」是中文，交给 Electron 按
// 应用名默认派生会得到中文目录，命令行与脚本场景都难处理。
const DATA_DIR_NAME = "calculationpaper";
// 更名前的旧数据目录：首启一次性搬入新目录，老书架/存档/已解密设置原样带走。
// 只作为迁移来源保留，不再对外出现。
const LEGACY_DATA_DIR_NAMES = ["rujuan-story-engine"];

export function migrateUserDataDir(appDataDir) {
  const target = join(appDataDir, DATA_DIR_NAME);
  if (!existsSync(target)) {
    for (const name of LEGACY_DATA_DIR_NAMES) {
      try {
        renameSync(join(appDataDir, name), target);
        break;
      } catch {}
    }
  }
  return target;
}
