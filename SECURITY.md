# 安全策略

## 报告漏洞

请使用 GitHub 仓库的「Report a vulnerability」（Security 标签页 → Private vulnerability reporting），不要公开开 issue。报告时请包含复现步骤与影响评估，我们会尽快回复。

## 支持版本

开源版本只有最新主线在维护。

## 这个应用的安全模型

- 应用是纯本地桌面程序，不架设任何服务端；你的小说、存档、设置全部保存在本机 userData 目录。
- API Key 经操作系统加密存储（Electron safeStorage），明文不落盘、不出现在日志里。
- 引擎联网只访问两类地址：你配置的 DeepSeek 兼容 API 端点，以及起稿阶段的公开资料搜索（维基百科、百度百科、DuckDuckGo）。搜索只发送书名与题材通用关键词。内置网络守卫会拦截私网与保留地址，防 SSRF。
