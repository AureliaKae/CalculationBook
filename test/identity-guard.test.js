import assert from "node:assert/strict";
import test from "node:test";

import { isCharacterBoundName, isCharacterBoundRoleName } from "../src/identity-guard.js";

const names = new Set(["韩立", "厉飞雨", "云梦"]);

test("通用判定:包含原著人名即视为绑定", () => {
  assert.equal(isCharacterBoundName("韩立道侣", names), true);
  assert.equal(isCharacterBoundName("云梦泽弟子", names), true, "通用口径保持子串匹配(宁可误报)");
  assert.equal(isCharacterBoundName("散修", names), false);
});

test("目录专用判定:人名后紧跟关系连接词才算绑定", () => {
  assert.equal(isCharacterBoundRoleName("韩立道侣", names), true, "人名+道侣");
  assert.equal(isCharacterBoundRoleName("厉飞雨的师弟", names), true, "人名+的+关系");
  assert.equal(isCharacterBoundRoleName("韩立之妻", names), true, "人名+之+关系");
  assert.equal(isCharacterBoundRoleName("韩立门下弟子", names), true, "人名+门下");
  assert.equal(isCharacterBoundRoleName("韩立", names), true, "整体即人名");
});

test("目录专用判定:与人名撞前缀的地名/门派来路不再误杀", () => {
  // 人物「云梦」与地名「云梦泽」撞名:云梦泽弟子是通用来路,不是绑定云梦的身份。
  // 旧实现的纯子串匹配会把它静默从身份目录里删掉。
  assert.equal(isCharacterBoundRoleName("云梦泽弟子", names), false);
  assert.equal(isCharacterBoundRoleName("云梦泽渔夫", names), false);
  assert.equal(isCharacterBoundRoleName("散修", names), false);
  assert.equal(isCharacterBoundRoleName("无名之辈", names), false);
});

test("目录专用判定:叙述标签仍然拦截", () => {
  assert.equal(isCharacterBoundRoleName("主角", names), true);
  assert.equal(isCharacterBoundRoleName("反派", names), true);
  assert.equal(isCharacterBoundRoleName("", names), false);
});
