// 双请求协议的测试帮手：把「叙事」与「结构」两个响应拼成一个可用的 LLM mock。
// story/structure 可以是值或函数；省略时退回 MockLlm 的默认实现。

import { MockLlm } from "../../fixtures/mock-llm.js";

const fallback = new MockLlm();

export function dualLlm({ story, structure, ...extra } = {}) {
  return {
    ...extra,
    async generateStory(args) {
      if (story === undefined) return fallback.generateStory(args);
      return typeof story === "function" ? await story(args) : story;
    },
    async generateStructure(args) {
      if (structure === undefined) return fallback.generateStructure(args);
      return typeof structure === "function" ? await structure(args) : structure;
    },
  };
}

// 常见成功路径：叙事一段、结构为空包（delta 空、三个兜底选项）。
export function basicStructure(extra = {}) {
  return {
    delta: {},
    statePatch: {},
    options: [
      { id: "o1", text: "观察", axis: "investigate", approach: "resist", risk: "safe", attribute: "resolve", timeCost: 30 },
      { id: "o2", text: "退开", axis: "exit", approach: "avoid", risk: "safe", attribute: "agility", timeCost: 30 },
      { id: "o3", text: "搭话", axis: "social", approach: "persuade", risk: "safe", attribute: "resolve", timeCost: 30 },
    ],
    openThreads: [],
    retrievalKeywords: [],
    ...extra,
  };
}
