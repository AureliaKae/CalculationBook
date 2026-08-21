import assert from "node:assert/strict";
import test from "node:test";

import { isPrivateOrReservedHost } from "../electron/net-guard.js";

test("点分 IPv4 保留网段识别", () => {
  assert.equal(isPrivateOrReservedHost("127.0.0.1"), true, "环回");
  assert.equal(isPrivateOrReservedHost("10.1.2.3"), true, "10/8");
  assert.equal(isPrivateOrReservedHost("172.16.0.1"), true, "172.16/12 起点");
  assert.equal(isPrivateOrReservedHost("172.31.255.255"), true, "172.16/12 终点");
  assert.equal(isPrivateOrReservedHost("192.168.1.1"), true, "192.168/16");
  assert.equal(isPrivateOrReservedHost("169.254.1.1"), true, "链路本地");
  assert.equal(isPrivateOrReservedHost("0.0.0.0"), true, "本网络");
  assert.equal(isPrivateOrReservedHost("224.0.0.1"), true, "组播及以上");
  assert.equal(isPrivateOrReservedHost("8.8.8.8"), false, "公网 DNS");
  assert.equal(isPrivateOrReservedHost("1.1.1.1"), false, "公网");
});

test("整数/十六进制 IP 字面量不再绕过内网判定", () => {
  // 2130706433 = 127.0.0.1 的整数写法,0x7f000001 是十六进制写法。
  // 旧实现按点分四段解析,这两种写法会被当成公网主机放行。
  assert.equal(isPrivateOrReservedHost("2130706433"), true, "整数形式的环回");
  assert.equal(isPrivateOrReservedHost("0x7f000001"), true, "十六进制形式的环回");
  assert.equal(isPrivateOrReservedHost("0x0a000001"), true, "十六进制形式的 10/8");
  assert.equal(isPrivateOrReservedHost("3232235521"), true, "整数形式的 192.168.1.1");
  assert.equal(isPrivateOrReservedHost("134744072"), false, "整数形式的 8.8.8.8");
  assert.equal(isPrivateOrReservedHost("99999999999999999999"), false, "越界整数不算保留地址");
});

test("IPv6 字面量识别", () => {
  assert.equal(isPrivateOrReservedHost("::1"), true, "IPv6 环回");
  assert.equal(isPrivateOrReservedHost("fe80::1"), true, "链路本地");
  assert.equal(isPrivateOrReservedHost("fd12::1"), true, "ULA");
  assert.equal(isPrivateOrReservedHost("::ffff:127.0.0.1"), true, "IPv4 映射地址");
  assert.equal(isPrivateOrReservedHost("2001:db8::1"), false, "公网文档段");
});

test("主机名(非 IP 字面量)不误判", () => {
  assert.equal(isPrivateOrReservedHost("api.deepseek.com"), false);
  assert.equal(isPrivateOrReservedHost(""), false);
  assert.equal(isPrivateOrReservedHost(null), false);
});
