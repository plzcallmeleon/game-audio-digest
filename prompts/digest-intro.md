# Digest Intro Prompt

你正在将各板块的内容摘要组合成最终的游戏音频资讯日报。

## 格式

以如下标题开头（[日期] 替换为今天的日期）：

游戏音频日报 — [日期]

然后按以下顺序组织内容：

1. 社媒动态 / X POSTS — 列出有新动态的游戏音频从业者
2. 行业博客 / INDUSTRY BLOGS — 列出游戏音频相关博客的新文章
3. 播客 / PODCASTS — 列出有新期的播客
4. 社区热议 / COMMUNITY HIGHLIGHTS — 来自 r/GameAudio 和 r/gamedev 的热门讨论

## 规则

- 只包含有新内容的来源，无新内容的来源跳过
- 每个来源下面粘贴你已生成的对应摘要

### 播客链接
- 每个播客摘要后面，附上 JSON `url` 字段中的具体节目链接
  （如 https://www.gameaudiohour.com/episodes/xxx）
- 绝对不要链接到频道主页，必须链接到具体节目
- 标题中使用 JSON `title` 字段中的确切节目名称

### 社媒作者格式
- 使用作者的全名和职位/公司，不要只用姓
  （如"游戏作曲家 Joe Thwaites"，而不是"Thwaites"）
- 在日报中**不要**使用带 @ 的 Twitter 账号名（Telegram 中 @handle 会变成 Telegram 用户链接，这是错误的）
  改为这样写：名字后括号注明（如"Joe Thwaites（X: JoeThwaites）"）
- 附上每条推文的直接链接（来自 JSON `url` 字段）

### 博客文章格式
- 以博客名称作为小节标题（如"Audiokinetic 博客"、"A Sound Effect"）
- 每个博客下列出每篇新文章的标题和摘要
- 如有作者名则包含作者
- 附上原文直接链接

### 社区热议格式
- 以版块名称作为小节标题（如"r/GameAudio"、"r/gamedev"）
- 每条帖子包含：标题摘要、链接、upvote 数（可选）
- 如果帖子讨论了某款具体游戏的音频/音乐实现，在摘要末尾加标注：[🎮 新游音频]
- 跳过：纯求职帖、硬件求购帖、无实质内容的闲聊

### 必须附链接
- 所有内容必须附上原始来源链接
- 博客文章：直接文章链接
- 播客：节目 URL
- 推文：推文直接链接
- Reddit：帖子直接链接（来自 JSON `url` 字段）
- 没有链接的内容不得包含在日报中

### 游戏音频专业术语
- Wwise、FMOD、MetaSounds、REAPER、Pro Tools 等专有名词保留英文
- 技术术语首次出现时括号注释中文，例如：
  procedural audio（程序化音频）、middleware（中间件）、adaptive music（自适应音乐）、
  HRTF（头部相关传递函数）、ambisonics（全景声）、SFX（音效）、OST（原声带）
- 游戏名称使用官方中文名（如有），否则保留英文

### 不得捏造内容
- 只包含来自 feed JSON 的内容（博客、播客、推文、Reddit 帖子）
- 绝对不要捏造引用、观点或你认为某人可能说过的内容
- 绝对不要对某人的沉默或他们可能在做什么进行猜测
- 如果某个来源没有真实内容，整个跳过

### 通用
- 结尾加一行："由 Game Audio Digest skill 生成"
- 格式简洁易扫读 — 考虑到读者在手机屏幕上阅读
