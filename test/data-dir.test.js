import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { migrateUserDataDir } from "../electron/data-dir.js";

function scaffold() {
  return mkdtempSync(join(tmpdir(), "data-dir-"));
}

test("旧品牌数据目录一次性迁入新目录", () => {
  const root = scaffold();
  try {
    mkdirSync(join(root, "rujuan-story-engine"));
    writeFileSync(join(root, "rujuan-story-engine", "settings.json"), "{}");
    const target = migrateUserDataDir(root);
    assert.equal(target, join(root, "calculationpaper"));
    assert.equal(existsSync(join(root, "calculationpaper", "settings.json")), true, "数据原样带走");
    assert.equal(existsSync(join(root, "rujuan-story-engine")), false, "旧目录已让位");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("新目录已存在时不用旧数据覆盖新数据", () => {
  const root = scaffold();
  try {
    mkdirSync(join(root, "rujuan-story-engine"));
    mkdirSync(join(root, "calculationpaper"));
    writeFileSync(join(root, "calculationpaper", "settings.json"), "new");
    migrateUserDataDir(root);
    // 两边都原样保留：新目录接管，旧目录留给用户自行处置，永不互相覆盖。
    assert.equal(existsSync(join(root, "calculationpaper", "settings.json")), true);
    assert.equal(existsSync(join(root, "rujuan-story-engine")), true, "旧目录不动");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("没有任何旧目录时直接使用新目录", () => {
  const root = scaffold();
  try {
    assert.equal(migrateUserDataDir(root), join(root, "calculationpaper"));
    // 目录本体由 Electron 首次使用时创建，这里不预先落盘。
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
