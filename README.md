# 推演书

> 入书为客，落笔成命。

[![CI](https://github.com/AureliaKae/CalculationBook/actions/workflows/ci.yml/badge.svg)](https://github.com/AureliaKae/CalculationBook/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/AureliaKae/CalculationBook)](https://github.com/AureliaKae/CalculationBook/releases)
[![License: MIT](https://img.shields.io/github/license/AureliaKae/CalculationBook)](LICENSE)

![案头书库](docs/screenshots/desk.png)

把你读过的一本小说变成能住进去的世界。导入 TXT 或 EPUB，引擎通读全书：学文风，给人物建档，理清时间线。然后你造一个书里不存在的人，从开篇走进去。原著剧情照常发生，你写下一刻想做什么，暗骰落定。成卷的世界可导出 `.cpworld` 发给朋友（[格式说明](docs/WORLD-FORMAT.md)）。

数据都在你机器上。出去的只有两样：你自备的 API 密钥，和起稿时按书名做的公开资料搜索（维基百科、百度百科、DuckDuckGo）。

## 功能实现（设计机制）

- **三层意图**：此刻意图、中期谋算、此世之志，分开写、分开改，注入选项生成、叙事和结构的不同阶段。意图明确就严格围绕它；写得模糊，就按心性底色落成具体行事。
- **记忆**：分层记忆加 BM25 检索，每回合只带最相关的几条事实和回忆进上下文。人物行踪笔记有新鲜度窗口，过期就丢，行踪权威始终在实体状态账上。
- **正典账本**：原著此刻、将至、伏笔、已发生四段对照，事件按故事时钟到期投递。选项不得与原著现状矛盾，将至之事也改不得提前。
- **暗骰判定**：选完即骰，判定结果驱动叙事。全程没有数值面板，一切只在文字里透出。
- **关系记账**：信任、利益、恐惧、敌意都悄悄记账。合作、说服、欺瞒、威吓、抗拒、回避六种行事取向，由代码解释成关系变化。
- **心性养成**：大五人格随每次落笔漂移。心性不设门槛，只影响模糊意图的落法和叙事措辞。
- **涌现**：新故事、新人物、同行者随叙事长出来。玩家经营的营生登记为基业线，影响力逐手累计。
- **改命**：铺垫期攒势能，攒够才能发动最终改写，顶替原著事件。势能耗尽有天命反弹。已发生的过去，谁也改不动。
- **身位成长**：具名行囊、技能习得、境界逐阶突破、身份进阶路径。进阶可以拒绝，拒绝也有代价。
- **终局与转世**：墓志铭写成一条世界事实。转世时心性全额带走，肉身清零，历世痕迹留在世界里。
- **世界扩建**：门派、身份、地点、物品、人物五类原创实体写进世界档案，和原著实体同权参与演算，跨转世存续。

## 下载

[最新 Release](https://github.com/AureliaKae/CalculationBook/releases)，Windows 安装包与便携版都有。

## 开始之前

引擎不自带模型。配一把你自己的 DeepSeek 或阿里千问（百炼）API 密钥，在文房里填入，本地加密保存。

## 授权

代码以 MIT 授权。
