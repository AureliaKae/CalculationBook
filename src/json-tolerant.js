// 模型时常写出「差一个逗号」的 JSON：数组元素之间漏逗号、结尾多一个逗号、夹一行注释、
// 前后带几句解释。这里只做保守修补——不猜语义，只补分隔符——修不动就照实抛错。

function stripFences(text) {
  return text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
}

// 字符串里的括号不算层级，所以扫描时要认转义。
function stringEnd(text, start) {
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === "\\") index += 2;
    else if (text[index] === '"') return index + 1;
    else index += 1;
  }
  return text.length;
}

// 定位下一个真正的结构起点：跳过字符串、成对的中文引号与注释，
// 前言里引号/注释里的 {、[ 都不是结构，误认了会把一段旁白当 JSON 解析。
function structureStart(text, from = 0) {
  let index = from;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      index = stringEnd(text, index);
      continue;
    }
    if (char === "“" || char === "‘") {
      const close = char === "“" ? "”" : "’";
      const end = text.indexOf(close, index + 1);
      index = end < 0 ? text.length : end + 1;
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      const line = text.indexOf("\n", index);
      index = line < 0 ? text.length : line;
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      const close = text.indexOf("*/", index);
      index = close < 0 ? text.length : close + 2;
      continue;
    }
    if (char === "{" || char === "[") return index;
    index += 1;
  }
  return -1;
}

// 从给定结构起点取最外层配平的对象或数组。
function balancedSlice(text, start) {
  let depth = 0;
  let index = start;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      index = stringEnd(text, index);
      continue;
    }
    if (char === "{" || char === "[") depth += 1;
    if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
    index += 1;
  }
  return text.slice(start);
}

function nextNonSpace(text, from) {
  const rest = text.slice(from).replace(/^\s+/, "");
  return rest[0] ?? "";
}

// 上一个有意义的字符收尾于一个值，而下一个字符又要开启新值，中间就少了逗号。
function endsValue(char) {
  return char === '"' || char === "}" || char === "]" || char === "b";
}

// 模型常在字符串里直接敲回车，JSON 不允许裸控制字符，得转成转义写法。
function escapeControls(literal) {
  return literal.replace(/[\u0000-\u001f]/g, (char) => {
    if (char === "\n") return "\\n";
    if (char === "\r") return "\\r";
    if (char === "\t") return "\\t";
    return "";
  });
}

function repair(text) {
  let out = "";
  let last = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      const end = stringEnd(text, index);
      if (endsValue(last)) out += ",";
      out += escapeControls(text.slice(index, end));
      last = '"';
      index = end;
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      const line = text.indexOf("\n", index);
      index = line < 0 ? text.length : line;
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      const close = text.indexOf("*/", index);
      index = close < 0 ? text.length : close + 2;
      continue;
    }
    if (/\s/.test(char)) {
      out += char;
      index += 1;
      continue;
    }
    if (char === ",") {
      const next = nextNonSpace(text, index + 1);
      // 尾逗号：后面直接就是收尾括号。
      if (next === "}" || next === "]" || next === "," || next === "") {
        index += 1;
        continue;
      }
      out += char;
      last = ",";
      index += 1;
      continue;
    }
    if (char === "{" || char === "[") {
      if (endsValue(last)) out += ",";
      out += char;
      last = char;
      index += 1;
      continue;
    }
    if (char === "}" || char === "]" || char === ":") {
      out += char;
      last = char;
      index += 1;
      continue;
    }
    // 裸值：数字、true/false/null，或模型写秃了的词。
    const token = /^[^\s,{}[\]:"]+/.exec(text.slice(index))[0];
    if (endsValue(last)) out += ",";
    out += token;
    last = "b";
    index += token.length;
  }
  return out;
}

export function tolerantParse(text) {
  const source = stripFences(String(text ?? ""));
  let from = 0;
  let firstError;
  // 模型常在正文前写带裸括号的旁白（如「[注意] 下面是结果」），这类旁白本身
  // 可能是合法 JSON 数组（如 ["注意"]）。真正的结构化结果几乎都是对象，
  // 所以优先接受「对象」候选；只有当只剩数组时，才把第一个数组作为后备返回，
  // 避免把旁白数组当成结果、把后面的对象正文丢掉。
  let arrayFallback;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const start = structureStart(source, from);
    if (start < 0) break;
    const candidate = balancedSlice(source, start);
    if (!candidate) break;
    from = start + candidate.length;
    for (const raw of [candidate, repair(candidate)]) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
        // null 不进后备:调用方一律把「非异常返回」当成功,null 会被原样写进
        // 检查点/批次,断点续烧对这一批永远收敛不了。
        if (parsed !== null && arrayFallback === undefined) arrayFallback = parsed;
      } catch (error) {
        firstError ??= error;
      }
    }
  }
  if (arrayFallback !== undefined) return arrayFallback;
  if (firstError) throw firstError;
  const whole = JSON.parse(source);
  // 整篇是合法 JSON 但既不是对象也不是数组(字面 null/数字/字符串):按解析失败
  // 抛出,同上——返回 null 会被调用方当成功存档。
  if (whole === null || typeof whole !== "object") {
    throw new SyntaxError("Response is valid JSON but not an object or array");
  }
  return whole;
}
