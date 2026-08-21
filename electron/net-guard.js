// IPv4/IPv6 字面量里的环回、内网、链路本地与保留网段。
// 独立成模块（不 import electron）便于纯 Node 单测。
export function isPrivateOrReservedHost(hostname) {
  const host = String(hostname ?? "").toLowerCase().split("%")[0];
  if (!host) return false;
  if (host.includes(":")) {
    if (host === "::1") return true;
    if (/^fe80:/i.test(host)) return true;
    if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true;
    if (/^::ffff:/i.test(host)) return isPrivateOrReservedHost(host.slice(7));
    return false;
  }
  let dotted = host;
  if (/^\d+$/.test(host)) {
    // 整数形式 IP（https://2130706433 = 127.0.0.1）：不归一化就会被当公网放行。
    const value = Number(host);
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) return false;
    dotted = [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
  } else if (/^0x[0-9a-f]+$/i.test(host)) {
    // 十六进制形式 IP（0x7f000001）：多数浏览器/Node fetch 会按点分十进制解析。
    const value = Number(host);
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) return false;
    dotted = [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
  }
  const parts = dotted.split(".");
  if (parts.length !== 4) return false;
  if (!parts.every((part) => /^\d+$/.test(part))) return false;
  const [a, b, c, d] = parts.map(Number);
  if ([a, b, c, d].some((n) => n < 0 || n > 255)) return false;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}
