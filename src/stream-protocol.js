// 流式协议：SSE 解析 + 纯文本/结构化内容收集。
// 双请求协议上线后，叙事走 readPlainStream，结构走 function calling / json_object，
// 旧的「正文 + 分隔符 + JSON」单请求协议已删除。

export async function* parseSse(stream) {
  const decoder = new TextDecoder();
  let buffer = "";

  const append = (text) => {
    // 只在增量文本上做换行归一化:旧实现每次对整个累积 buffer 做 replaceAll,
    // 随正文增长退化成 O(n²)。跨块断裂的 \r\n(前一块以 \r 结尾、本块以 \n 开头)
    // 在这里单独接上,再把本块的 \r\n 归一成 \n。
    if (buffer.endsWith("\r") && text.startsWith("\n")) buffer = buffer.slice(0, -1);
    buffer += text.replaceAll("\r\n", "\n");
  };

  for await (const chunk of stream) {
    append(typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }));

    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) yield data;
    }
  }

  append(decoder.decode());
  const finalData = buffer
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (finalData) yield finalData;
}

export async function collectStreamText(stream, { usageOut } = {}) {
  let content = "";
  let fallback = "";
  // 取证：记录最后一个非空的 finish_reason。流式截断（length）在这里不做拦截，
  // 由 #json 的解析报错把 finish_reason 一起带出来，残卷来源一目了然。
  let finishReason = null;
  for await (const data of parseSse(stream)) {
    if (data === "[DONE]") continue;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    const choice = event.choices?.[0];
    const delta = choice?.delta ?? {};
    // 思维型模型的推理分块先于正文到达：只取 content，不再把思维链文本混进
    // 结构化内容（否则 JSON 解析会被带进思考草稿里）。reasoning 单独暂存，
    // 正文全空时由调用方判断是否整段像 JSON 文档再回退。
    if (delta.content) content += delta.content;
    else if (delta.reasoning_content) fallback += delta.reasoning_content;
    if (choice?.finish_reason != null) finishReason = choice.finish_reason;
    // 用量采集（2026-08-19）：带 stream_options.include_usage 的端点在末块带 usage。
    if (event.usage && usageOut) usageOut.usage = event.usage;
  }
  const text = content || (/^\s*[{[]/.test(fallback) ? fallback : "");
  return { content: text, finishReason };
}

// 纯文本流式读取：双请求协议下叙事请求不含分隔符，逐块交给 onNarrative，
// 结束时返回全文。
export async function readPlainStream(stream, { onNarrative, usageOut } = {}) {
  let content = "";
  let finished = false;
  let truncated = false;
  for await (const data of parseSse(stream)) {
    if (data === "[DONE]") {
      finished = true;
      continue;
    }
    let event;
    try {
      event = JSON.parse(data);
    } catch (error) {
      throw new Error(`Invalid SSE JSON: ${error.message}`);
    }
    // 用量采集在 choice 判空之前：include_usage 的末块 choices 为空数组。
    if (event.usage && usageOut) usageOut.usage = event.usage;
    const choice = event.choices?.[0];
    if (!choice) continue;
    content += choice.delta?.content ?? "";
    if (choice.finish_reason != null) finished = true;
    if (choice.finish_reason === "length") truncated = true;
    onNarrative?.(choice.delta?.content ?? "");
    if (event.usage && usageOut) usageOut.usage = event.usage;
  }
  if (!finished) throw new Error("Model stream ended without a terminal signal");
  // max_tokens 截断会把正文砍在半句：当作失败走重写，而不是静默接受。
  if (truncated) throw new Error("Model response was truncated (finish_reason=length)");
  if (!content.trim()) throw new Error("Model response has no narrative");
  return content.trim();
}
