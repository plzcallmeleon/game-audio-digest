# Game Audio Digest

面向游戏音频从业者和爱好者的资讯日报 Skill。追踪全球游戏音频领域的播客、行业博客、从业者 X 动态和 Reddit 社区热帖，每日自动整理成中文摘要推送。

**理念：** 关注真正在做事的人——音效设计师、游戏作曲家、音频工程师、中间件开发者——而不是二手转发。

## 你能获得什么

每日或每周的游戏音频资讯日报，推送到你常用的 IM（Telegram、Discord 等），包含：

- 播客新期精华（Game Audio Hour、Twenty Thousand Hertz 等）
- 行业博客新文章（Audiokinetic、A Sound Effect、Designing Sound 等）
- 游戏音频从业者的 X 动态
- Reddit 社区热议（r/GameAudio 热帖，含新游音频亮点标注）
- 所有原文链接
- 默认中文输出，也支持英文和中英双语

## 快速开始

1. 在你的 agent（OpenClaw 或 Claude Code）中安装 skill
2. 说"设置游戏音频日报"或输入 `/GA`
3. Agent 会通过对话引导你完成配置，无需编辑任何文件

配置过程中 agent 会询问：
- 推送频率（每天或每周）和时间
- 语言偏好（中文 / 英文 / 双语）
- 推送方式（Telegram、邮件或直接在聊天界面）

无需 API key——所有内容通过中央 feed 获取。设置完成后立即发送第一份日报。

## 修改设置

所有设置都可以通过对话修改：

- "改为每周推送，周一早上"
- "语言改为双语"
- "摘要写短一点"
- "查看我的当前设置"

信息源（播客、博客）由中央维护，自动更新，无需手动操作。

## 自定义摘要风格

Skill 使用纯文本 prompt 文件来控制内容摘要方式，可以自定义：

**通过对话（推荐）：**
直接告诉 agent——"摘要更简洁一点"、"重点关注音频实现技术"、"语气随意一点"。Agent 帮你修改。

**直接编辑（高级用户）：**
编辑 `prompts/` 目录中的文件：
- `summarize-podcast.md` — 播客摘要方式
- `summarize-tweets.md` — X/Twitter 摘要方式
- `summarize-blogs.md` — 博客文章摘要方式
- `summarize-reddit.md` — Reddit 帖子摘要方式（含新游音频亮点识别）
- `digest-intro.md` — 日报整体格式和语气
- `translate.md` — 翻译规则和专业术语对照

这些都是纯文本说明，不是代码。修改后下一次运行即生效。

## 默认信息源

### 播客（6 个）
- [Game Audio Hour](https://www.gameaudiohour.com)
- [Soundworks Collection Podcast](https://soundworkscollection.com/podcast)
- [Twenty Thousand Hertz](https://www.20k.org)
- [A Sound Effect Podcast](https://www.asoundeffect.com/category/podcast/)
- [The Sound Architect Podcast](https://www.thesoundarchitect.co.uk/podcast/)
- [Tonebenders Podcast](https://tonebenderspodcast.com)

### 行业博客（4 个）
- [Audiokinetic Blog](https://blog.audiokinetic.com) — Wwise 官方技术博客
- [A Sound Effect Blog](https://www.asoundeffect.com/blog/) — 综合性游戏音频资讯
- [Designing Sound](https://designingsound.org) — 音效设计深度博客
- [Game Developer Audio](https://www.gamedeveloper.com/audio) — GDC 官方媒体音频频道

### Reddit 社区
- r/GameAudio — 游戏音频专业社区热帖（upvote ≥ 30）
- r/gamedev — 游戏开发者社区中的音频相关讨论（关键词过滤 + upvote ≥ 50）

### X/Twitter 账号（初始种子）
[Joe Thwaites](https://x.com/JoeThwaites)、[Danny Hey](https://x.com/dannyryanhey)、[Akash Thakkar](https://x.com/akashthakkar)

> X 账号列表可持续扩充，欢迎提交你关注的游戏音频从业者账号。

## 安装

### OpenClaw
```bash
# 手动安装
git clone https://github.com/YOUR_USERNAME/game-audio-digest.git ~/skills/game-audio-digest
cd ~/skills/game-audio-digest/scripts && npm install
```

### Claude Code
```bash
git clone https://github.com/YOUR_USERNAME/game-audio-digest.git ~/.claude/skills/game-audio-digest
cd ~/.claude/skills/game-audio-digest/scripts && npm install
```

## 环境要求

- AI agent（OpenClaw、Claude Code 等）
- 网络连接（用于拉取中央 feed）

不需要任何 API key。所有内容（博客文章、播客字幕、X 推文、Reddit 帖子）均通过中央 feed 集中获取，每日更新。

## 工作原理

1. 中央 feed 每日自动更新（博客文章通过网页抓取，播客通过 RSS + pod2txt 转字幕，X 通过官方 API，Reddit 通过免费 JSON API）
2. 你的 agent 拉取 feed——一次 HTTP 请求，无需 API key
3. Agent 按照你的偏好将原始内容 remix 成可读摘要
4. 日报推送到你的 IM（或在聊天界面直接显示）

查看 [examples/sample-digest.md](examples/sample-digest.md) 了解输出示例。

## 隐私

- 不向任何外部服务发送你的 API key——所有内容通过中央 feed 获取
- 如果你使用 Telegram/邮件推送，对应的 key 仅存储在本地 `~/.game-audio-digest/.env`
- Skill 只读取公开内容（公开博客、公开播客、公开 X 推文、公开 Reddit 帖子）
- 你的配置、偏好和历史记录全部保留在本机

## License

MIT
