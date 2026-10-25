# dsh-search-picture

DSH（DeepSeek Harness）插件：**让智能体上网找图 → 你先看预览 → 满意的才写进相册。**

工作流是两步的，这一点很重要：

1. 你说「帮我找几张 XX 的图片」，智能体调 `search_picture`：多图源搜索 → 按清晰度筛选 → 下载到**预览区** → 把图片本身读进上下文，逐张告诉你「这是哪张、哪些建议留」。
2. 你说「第 1、3 张满意」，智能体调 `save_pictures`：只把这几张**平铺写入相册**（默认 `%USERPROFILE%\Pictures\dsh-search-picture\`），其余从预览区删除。

**在你确认之前，相册里不会出现任何东西。**

## 目录约定

```
downloads/                              下载根目录（配置里的 directory），只放预览区
└── .staging/<批次 id>/                 预览区：候选先落这里，随时可整批丢弃
    ├── STAGING.md                      本批清单（人可读：分辨率/来源/直链）
    └── 查询词-01.jpg                   候选文件（文件名 = 查询词 + 序号）

%USERPROFILE%\Pictures\dsh-search-picture\     相册：图片**平铺**，不建任何子文件夹
├── 查询词-01.jpg
└── 查询词-03.jpg
```

- **相册是一个固定目录、图片平铺**，不按每次要求建子文件夹（`folder` 参数已弃用）。
- 写入是**复制而非移动**：确认过的图仍留在预览区，方便你改主意时再要一次。
- 相册内重名会自动追加 `-2`、`-3`，**绝不覆盖**已有图片。
- **预览区在下次搜索时自动清理**：新搜索开始前会删掉上一次留下的批次（`autoCleanPreview: false` 可关闭）。**当前批次永不删除**；只清「批次 id」形态的目录，其他名字的目录一律保留，避免误删。
- 确认后若预览区已空，`downloads/.staging/<批次 id>/` 会被整个移除，不留空壳。
- ⚠️ **相册在工作区之外**，而会话沙箱默认是 `workspace-write`：写入需要一次「放宽到完全访问」的批准（`ask` 授权策略下会弹给你确认；没有可用应答方时该次写入会失败）。这是刻意的——宁可让你点一次授权，也不静默往工作区外写文件。

## 功能

| 环节 | 行为 |
|---|---|
| 官方素材 | **默认关闭**（`officialSite: true` 可开启）。官网首页按活动批次展示横幅与联动广告，实测**不含用户点名的角色**（拿到的多是活动主视觉，甚至别的角色的立绘）——对「找某个具体角色」这个主要用途，官网素材是噪声 |
| 相关站点 | **萌娘百科默认开启**（`relatedSites`）：去与主题关联的百科站找图。动漫类的**作品视觉图/立绘**主要靠它——实测某作品词条一次可拿到 8 张位图（含 1856×2618 等大图），且图床裸请求可下。另可选 `biligame`，但它**启用了 WAF**、实测会返回 HTTP 567 拦截页，故默认关闭 |
| 水印过滤 | 用户要求「不要自动添加水印的图片」。插件没有视觉模型，**无法通用判断一张图有没有水印**；但图库站的水印是产品行为，所以按**域名黑名单**（58pic/699pic/gettyimages…）＋**地址含 `watermark`/`水印` 标记**两条确定性判据排除，结果里会报告排除了几张（`watermarkHosts` 可追加域名） |
| 插画源 | **Safebooru**（`tags` 参数启用）：画师同人插画，能拿到超大原图（实测 850×1328 ~ **5039×7874**、11 MB），无防盗链。但它**只做标签字面匹配**——带空格的自然语言查不到，必须用下划线连接的标签形式（见下方 `tags` 说明），因此中文/自然语言查询不会去查它（避免引入不相关噪声）。**新推出的角色往往还没有标签**（实测多个新角色为 0 条） |
| 搜索 | 并发查询 **Bing 图片**、**百度图片**、**360 图片**、**哔哩哔哩图文** 四个免 key 图源，按图片地址去重合并 |
| 来源偏好 | **知乎与哔哩哔哩优先**（用户指定）。按**站点**判定而非引擎——百度和必应都会索引知乎/B 站的图，用户在意的是图最终来自哪个站。偏好**只在质量相当时**起并列作用，绝不越级（历史教训：曾让官网升到最高档，结果横幅挤掉了全部插画） |
| 可直贴标记 | `hotlinkFriendly` 标出「图床无防盗链、直链可安全嵌入回复显示」的图（`zhimg.com` / `hdslb.com` / `safebooru.org`）。回复正文只认 `http(s)` 图片源，本地路径会被渲染成文字占位符 |
| 清晰度 | **保底 720p**（默认门槛 921600 px² = 1280×720），1080p 以上自然排前；下载后按**实际解码尺寸**三重校验：像素面积、长边 ≥1000、长宽比 ≤2.6，不达标直接淘汰并记录原因 |
| 原图优先 | 百度优先取明文原图（`replaceUrl`）或解码后的 `objURL`；拿不到原图才退化到百度 CDN 的受限代理图，且排序降到第二档 |
| B 站 | 站内没有图片搜索，因此引擎**只调用** `search/type=article`（专栏正文配图）与 `link_draw`（图文图片集）；**不使用视频封面**（那是 UP 主给视频做的标题图，不是「这张图」本身）。宁可返回「无结果」——原本的「视频封面兜底」解析器已按此要求**移除** |
| 排序 | 先降档受限代理图与标题图，其余按像素面积降序；面积相同时**知乎/B 站优先**，再相同则官网素材优先 |
| 防盗链 | 先**不带 Referer** 请求（多数图床带第三方 Referer 才拒绝），失败再带来源页 Referer，最后退化到搜索结果里的缩略图地址 |
| 限流 | B 站搜索对匿名连发请求会返回 `HTTP 412` 或 `-412 request was banned`；实测约 4 秒恢复，因此按 2.5s/5s/7.5s 递增退避重试 |
| 展示 | 同一批字节提交为 DSH 附件 → 模型收到真正的图片块；同时写入 `tool/result.meta`，Client 半据此渲染缩略图画廊与「保存结果」卡片（工具卡片**默认折叠**，展开后可见缩略图） |

### 相关站点（百科类）与它的坑

用户要求「动漫可以去**萌娘百科**这类的网站，其他图片去与它相关联的网站找」。实测（[test/probes/probe-related-sites*.mjs](test/probes/)）确定了几件事：

| 站点 / 接口 | 结果 |
|---|---|
| 萌娘百科 `opensearch` | ✅ 能精确命中词条，含消歧义名（搜角色名会列出「角色名」/「角色名(作品名)」等同名项） |
| 萌娘百科 **`list=search`** | ❌ `action-notallowed: Unauthorized API call`——**词条检索只能用 `opensearch`** |
| 萌娘百科 **`prop=imageinfo`** | ❌ 同样是未授权接口！**必须用 `generator=images` 才能拿到图与真实 URL** |
| 萌娘百科图床 `storage.moegirl.org.cn` | ✅ **裸请求可下**（实测 1856×2618 / 895KB） |
| biligame wiki | ⚠️ 首次可用（下载到 1052×1362），随后**全部请求被 Tencent EdgeOne WAF 拦为 HTTP 567**（返回 HTML 而非 JSON）→ 默认关闭，且代码里必须容错 |

实现要点（见 [src/related.js](src/related.js)）：

- 只用 MediaWiki 的 `opensearch`（找词条）＋ `generator=images`（取图 + `iiprop=url|size`），一次请求就能拿到「图 + 真实 URL + 尺寸」；
- **过滤掉 SVG 与站点自用素材**：词条图里混着编辑图标、模板 logo、Commons 徽章，按文件名关键词（`logo|icon|emblem|commons-|nuvola|…`）排除；
- **WAF 拦截要能被识别**：拦截页是 HTML，直接 `JSON.parse` 会抛 `Unexpected token '<'` 这种难懂的错，所以先判首字符，命中就报「被 WAF 拦截（HTTP 567），本轮跳过」，不影响其他图源。

### 关于「不要带水印的图片」

这是用户明确要求，但要**如实说明能力边界**：本插件没有视觉模型，**无法通用地判断一张图里有没有水印**（那需要看图）。所以实现的是两条**确定性**判据：

1. **域名黑名单**：图库/素材站（`58pic.com`、`699pic.com`、`ibaotu.com`、`gettyimages.com`、`shutterstock.com` …）给预览图统一加水印，这是**产品行为**，按域名排除可靠；配置项 `watermarkHosts` 可追加。
2. **地址/文件名标记**：URL 或文件名里带 `watermark`、`水印` 等字样。

命中的候选在下载前就被剔除，并在结果里报告「已按不带水印要求排除 N 张」。**做不到的**：那些把水印压在画面里的普通站点图——这需要逐张看图，插件层面做不到，只能靠模型在预览时用眼睛判断。

### 知乎：为什么是「搭搜索引擎的便车」而不是直连
用户要求优先用知乎的图。实测（[test/probes/probe-zhihu.mjs](test/probes/probe-zhihu.mjs)、[probe-zhihu2.mjs](test/probes/probe-zhihu2.mjs)）表明**知乎站内完全进不去**：

| 入口 | 结果 |
|---|---|
| 搜索页 / 问题页 HTML | **HTTP 403**（移动 UA、伪造 cookie、`Baiduspider`/`Googlebot` UA 全都是 403） |
| `api/v4/search_v3` | **HTTP 400**（各种参数组合均 400） |
| 热榜 / 推荐 feed | **HTTP 401** `身份未经过验证` |
| 文章 API / 答案 API | 403（err 10003 / 40353）、收藏夹 401 |
| **`pic*.zhimg.com` 图床** | **HTTP 200**，无 referer 与带 referer 都能下 |

所以正确做法是：**走百度（对知乎收录最好）命中 `zhimg.com` 的图，直接从图床取原图**。因为图床无防盗链，这些直链还能**直接嵌进回复显示**——这是本插件唯一被验证能在回复正文里显示图片的形式。


### 官网图源的边界（实测记录）

对象为某游戏官网与某产品官网，脚本见 [test/selftest-official.mjs](test/selftest-official.mjs)：

- **找官网稳**：Bing 网页搜索结果的站外链接里第一条就是国服官网（标题自带「官方网站」），可稳定识别，第三方站（bilibili / 4399 / taptap / 百科…）会被排除；
- **取图成**：国服与国际站首页各抽出 21 条图片地址，HTTP 200 **全部可下**，其中 **20 条 ≥720p**；
- **但拿不到「指定角色」的图**：官网是 Next.js 客户端渲染，初始 HTML 里**没有任何站内 `<a href>`**，无法顺着链接进入角色页；图片目录按「日期 + 哈希」组织，从 URL 也看不出对应关系。所以官网图源只能作为**权威高分的补充**，不能宣称「帮你找到了那个角色的官图」。

> 踩坑记录：图片地址抽取**不能把 `,` 或 `&` 当分隔符**——`?x-oss-process=image/resize,w_1920&v=2` 这类地址被削掉尾段后就变成 404。这个 bug 曾让我把官网 20 张可下载的大图误判成「官网取不到图」。


## 工具

### `search_picture`（搜索到预览区）

| 参数 | 必填 | 说明 |
|---|---|---|
| `query` | 是 | 图片内容描述，中英文均可 |
| `count` | 否 | 搜索张数，默认取配置 `count`，不得超过它 |
| `page` | 否 | 结果页码（0 起）；第一页没有满意结果时翻页 |
| `folder` | 否 | 已弃用：现在图片平铺写入相册，不再按请求建子文件夹，该参数会被忽略 |
| `tags` | 否 | **Safebooru 插画站**的检索标签，英文 romaji 形式、**下划线连接**，例如 `character_name_(series_name)`、`series_name`。多个标签用空格表示「同时满足」。想要画师同人插画就填它；**纯中文查询不要填**（该站只认标签字面匹配，中文会得到 0 结果） |

返回里包含 `sourceFolder`（下载根目录）、`previewFolder`（预览区）、`targetFolder`（**相册目录**）、`officialSites`（找到的官网）、每张图的 `path`/`width`/`height`/`bytes`/`sourceUrl`/`pageUrl`/`hotlinkFriendly`，以及图片块本身。

> `targetFolder` 指向的是**相册**（默认 `%USERPROFILE%\Pictures\dsh-search-picture`），不是工作区里的目录——这是「不建文件夹、直接进相册」这个要求的结果。

> `hotlinkFriendly` 标出「图床无防盗链、直链可直接嵌进回复显示」的图（`zhimg.com` / `hdslb.com` / `safebooru.org`）。**回复正文只认 `http(s)` 图片源**，本地路径会被渲染成文字占位符——这一条是实测踩坑后写进代码注释的。

### `save_pictures`（确认后写入相册）

| 参数 | 必填 | 说明 |
|---|---|---|
| `keep` | 是 | 要写入相册的图片：预览清单里的**序号**（`"2"`、`"#5"`）或**文件名** |
| `folder` | 否 | 已弃用（仅为兼容旧调用保留），会被忽略 |
| `discard` | 否 | 明确不要的图片（序号或文件名），会从预览区删除 |
| `previewFolder` | 否 | 预览区绝对路径或批次 id；默认用下载根目录下的预览区 |
| `sourceFolder` | 否 | 下载根目录；默认用配置里的 `directory` |

**只有用户明确表示满意之后才应该调用它**（工具描述里写明了这一点）。

## 安装

**给使用者：从 GitHub 安装（推荐）**

直接指向仓库（需要安装机器上有 `git`，DSH 会先用 `git ls-remote` 检查可达性）：

```
plugin_manager  action: install_bundle  target: https://github.com/tuanzi0v0/dsh-search-picture
```

> ⚠️ **不要用 `releases/latest/download/...tgz` 那种直链**：本仓库目前**没有发布任何 GitHub Release**，
> 这类链接会返回 404。等真发布 Release 之后，直链必须写成**实际资产的文件名**
> （形如 `.../releases/latest/download/<文件名>.tgz`）——`latest` 只是把「版本号」这段
> 重定向到最新 tag，它**不会**替你补上文件名，所以链接里必须出现具体文件名。
> 这也正是 `test/selftest-readme.mjs` 用 `/\d+\.\d+\.\d+\.tgz/` 断言「README 不得写死版本号」的原因。

```
plugin_manager  action: install_bundle  target: https://github.com/tuanzi0v0/dsh-search-picture
```

安装后 **重启 DSH** 生效（Host 半的 JS 模块只在启动时加载）。Client 半由 `/plugins/<包名>/client.js` 动态提供，不需要重建前端。

**给开发者：从本地目录安装**

包必须能被 profile 解析到，因此需要装进 profile（`~/.dsh/profiles/<profile>`）。官方插件管理器（GUI 的 Plugins 页面，或 Creator 模式下的 `plugin_manager`）：

```
plugin_manager  action: install_bundle  target: <本包绝对目录>
```

命令行等价做法（在本包目录下）：

```bash
dsh plugin --profile desktop add "$(pwd)"
```

或先打包再用 tarball：

```bash
npm pack
dsh plugin --profile desktop add ./dsh-search-picture-<version>.tgz
```

（把 `<version>` 换成 `package.json` 里的版本号。**每次改动后必须加版本号再打包**，原因见下方「开发循环」。）


## 配置

在 profile 的 `cordis.patch.yml` 里按行 id 覆盖（patch 替换整份 `config`，要改的键都要写上）：

```yaml
- id: dsh-search-picture
  name: dsh-search-picture
  config:
    directory: downloads      # 下载根目录（只放预览区）；相对路径按会话工作区解析
    count: 6                  # 每次默认搜索张数（也是 count 参数的上限）
    album: ''                # 相册根目录；留空 = %USERPROFILE%\Pictures
    albumName: dsh-search-picture   # 相册内的固定子目录名（图片平铺其中）
    autoCleanPreview: true    # 下次搜索时自动清理上次的预览批次（当前批次永不删）
    officialSite: false       # 是否先去官网取官方素材（默认关闭，理由见上表）
    relatedSites: [moegirl]   # 相关站点（百科类）；[moegirl, biligame] 可加站点，[] 整体关掉
    watermarkHosts: []        # 额外要按「水印风险」排除的域名（内置了一份图库站黑名单）
    safebooru: true           # 是否启用 Safebooru 插画源（仅在给了 tags 时才会真的查询）
    minPixels: 921600         # 清晰度门槛（像素面积）；921600 = 1280x720，即保底 720p
    minLongEdge: 1000         # 长边下限；挡掉「面积够但很窄」的裁切条
    maxAspectRatio: 2.6       # 长宽比上限；挡掉专栏/网页里的超宽横幅与拼图条
    minBytes: 4096            # 低于此字节数直接淘汰
    maxBytes: 12582912        # 单个响应的字节上限，超限截断
    concurrency: 6            # 同时下载数
    fetchTimeoutMs: 30000     # 单张图下载超时
    searchTimeoutMs: 20000    # 图源搜索超时
```

上面的键与代码里的 `Config` **一一对应**（共 17 个）。`album` / `albumName` / `autoCleanPreview` / `relatedSites` / `watermarkHosts` 是后加的，旧版配置文件里没有它们也能正常跑（有默认值兜底）。

### 怎么用「相关站点」和「水印过滤」

**相关站点的触发方式与 Safebooru 不同，这点最容易搞错：**

| 图源 | 用什么检索 | 什么时候生效 |
|---|---|---|
| Safebooru 插画 | **`tags` 参数**（英文 booru 标签） | 只有你给了 `tags` 才查它 |
| **相关站点（萌娘百科）** | **`query` 查询词**（中文即可） | `relatedSites` 非空时**每轮都会查** |

所以「动漫去萌娘百科」不需要你做任何额外操作，直接说需求就行：

> 「给我找几张 **XX 作品** 的图」→ 自动带上萌娘百科词条的视觉图/立绘
> 「找 **XX 作品** 的图片」+ 同时给出对应 booru 标签 → **再叠加** Safebooru 的同人插画

结果里会标明来源：「其中 N 张来自相关站点（萌娘百科）——这类百科站的图多是作品官方视觉图与立绘」，`searched[]` 里也会出现 `related=<命中数>`。

**还想加别的站点？** 在 [src/related.js](src/related.js) 的 `RELATED_SITES` 里加一项即可（只要是 MediaWiki 站点就复用同一套逻辑）：

```js
export const RELATED_SITES = {
  // …已有的 moegirl / biligame
  你的站点: {
    label: '显示名',
    api: 'https://<站点>/api.php',
    pageUrl: (title) => `https://<站点>/${encodeURIComponent(title)}`,
    referer: 'https://<站点>/',
    limit: 30,
  },
};
```

**水印过滤怎么调？** 默认已内置图库站黑名单，`watermarkHosts` 用来**追加**你遇到的站点：

```yaml
watermarkHosts: [example-watermark-site.com]
```

被排除的张数会写在 `notes` 里。⚠️ 注意作用范围：这个过滤**只对「候选图片地址」生效**，**不影响**你自己放进工作区的图片。

想**关掉整个相关站点通路**：`relatedSites: []`。

想更严格（只要 1080p 起）把 `minPixels` 改成 `2073600`（1920×1080）即可。

> 建议**只写你要改的键**：patch 会替换整份 `config`，把默认值再抄一遍只会让默认值难以维护——本项目就曾因为随包 patch 里抄了旧的 `minPixels: 720000`，让「保底 720p」的门槛悄悄失效。

## 排障

先打开下载明细日志（Host 进程的 stderr）：

```bash
DSH_SEARCH_PICTURE_TRACE=1
```

每个候选的请求 URL、Referer 策略、HTTP 状态、字节数与耗时都会打印。

- **某个图源在结果里报 `error`**：`searched[]` 逐条写明（`HTTP 403`、超时、`no parsable results`、`rate limited`）。单个图源失败不影响其余。
- **只想凑到 1~2 张**：结果文本的 `notes` 会说明「仅找到 N 张满足清晰度要求」，并附上当前门槛。可调低 `minPixels`，或换更具体的 `query`。
- **图片在预览区但模型看不到**：该图的 `attachmentError` 写明原因（多为超出本部署的 `attachments.imageLimits.maxImageBytes`，通常 20 MiB）。这只影响「模型能否看到」，**不影响写入相册**。
- **聊天里没有缩略图卡片**：Client 半没加载。检查 `/plugins/dsh-search-picture/client.js` 是否可访问，以及 `tool.call.toolview` 里是否注册了 `search_picture` 与 `save_pictures`。
- **B 站一直报 `rate limited`**：匿名限流，退避后仍失败属正常，其余三个图源不受影响。
- **相关站点没结果 / 报「没有匹配的词条」**：说明查询词没命中百科条目。萌娘百科的 `opensearch` 是**词条名前缀匹配**，用**作品名或角色名**最容易命中（会列出「角色名(作品名)」这类消歧义项）；**描述性长句会落空**。复合查询词（作品名 + 角色名）会先整串试、失败再拆词重试。
- **相关站点报「被 WAF 拦截（HTTP 567）」**：该站点启用了腾讯 EdgeOne 防护（biligame 实测如此）。被拦时**本轮就没有它的结果，其他图源不受影响**；隔一段时间再试或换站点。
- **候选数量比预期少**：先看 `notes` 里有没有「已按不带水印要求排除 N 张」——那是水印过滤生效了；再确认 `searched[]` 里各图源是否报错。要放宽就调低 `minPixels`，或给 `tags` 让 Safebooru 也参与。

## 修改后如何生效（开发循环）

- **Host 半**（`index.js` / `src/`）：重新安装并**重启 DSH**。
- **Client 半**（`client.js`）：重新安装后**刷新页面**。只有 `pnpm run dev:web` 在跑时才免刷新热更新。

把「打包 + 安装 + 校验」串成一步的脚本（在本仓库的工作副本里）：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .work\repack-install.ps1
```

它的作用：`npm pack` → 用 `dsh plugin --profile <profile> add <tgz>` 装进 profile → 打印安装副本的文件哈希用于核对。

**每次重新安装前必须把 `package.json` 的 `version` 加一。** pnpm 按内容摘要缓存 tarball，同一版本号重新安装会静默保留旧副本。

## 自测

不依赖 DSH 运行时的自测脚本在 [`test/`](test/)，**从仓库根目录**执行：

```bash
node test/selftest.mjs                        # 图源解析（含权威样例）+ 端到端下载
node test/selftest-host.mjs                   # 预览→确认→写相册 全流程、目录约定、输出形状
node test/selftest-client.mjs                 # Client 半注册与各种渲染输入
node test/selftest-bilibili.mjs                # B 站图源专项（含限流观察）
node test/selftest-official.mjs               # 官网通路专项（判定/抽取/端到端）
node test/selftest-safebooru.mjs              # Safebooru 解析边界 + 标签 + 端到端
node test/selftest-safebooru-e2e.mjs          # Safebooru 下载→落盘→写入相册（逐字节校验）
node test/selftest-schema.mjs                 # 真实输出 vs 声明 schema（防 INVALID_TOOL_OUTPUT）
node test/selftest-prune.mjs                  # 预览区自动清理（含「当前批次不删」等安全边界）
node test/selftest-related.mjs                # 相关站点（萌娘百科）+ 水印过滤 + 端到端
node test/selftest-readme.mjs                 # README 与代码一致性（配置/默认值/行为逐条断言）
```

需要联网用例指定别的关键词时，可以传参：`node test/selftest.mjs "你的查询词" 4`。

每个脚本结尾打印「断言失败数：N」并以退出码表示结果（`0` = 全过）。细节见 [test/README.md](test/README.md)。

> 部分用例依赖真实网络，图源波动（B 站限流、偶发超时）会让个别断言失败，重跑即可；`selftest-readme` 与 `selftest-schema` 是纯本地检查，最稳定。

## 关于 Pixiv（实测结论：本机不可用）

曾评估接入 Pixiv，实测**在没有任何代理的情况下拿不到它的任何内容**，原因不是实现问题：

| 域名 | 系统 DNS | 真实 IP | TCP 443 | TLS |
|---|---|---|---|---|
| `pixiv.net` | 114.43.24.59（无关 IP） | 210.140.139.x（经国内 DoH） | ✅ 106ms | ❌ **ECONNRESET 146ms** |
| `i.pximg.net` | 31.13.83.34（**Meta 的 IP**） | — | ❌ 超时 | — |
| `app-api.pixiv.net` | 199.59.148.89（Twitter 的 IP） | 172.64.145.17（Cloudflare） | ✅ | ❌ **ECONNRESET 119ms** |

即 DNS 被污染，且**连接放行后在 TLS 握手阶段被 RST**（SNI 阻断）。换 DNS 无效（已用 `doh.pub` 取到真实 IP 直连）、加密 DNS 本身也被 RST（Cloudflare/Google DoH 全断），本机也没有任何代理（11 个常见代理端口均 `ECONNREFUSED`，环境变量里无 `*_PROXY`）。

所以 Pixiv 只有在**你提供代理**后才有意义：届时可加 `src/pixiv.js`，让 Pixiv 走代理、其余源直连。在此之前用 **Safebooru** 覆盖「画师同人插画 + 标签检索」这个需求。

不可用的同类站点（同批实测）：Konachan（Cloudflare 拦截）、Danbooru / Yande.re / Gelbooru（连接超时）。

## 实现说明

- **Host 半**（`index.js` + `src/`）：`defineTool` 注册 `search_picture` 与 `save_pictures`，注入 `tools` / `systemPrompt` / `fs` / `attachments`。
- **Client 半**（`client.js`）：`window.__ModuleLoader__.load` 注册惰性工厂（id 必须等于包名），注册两个 `tool.call.toolview`（`search_picture` / `save_pictures`）。只依赖基线 `react`，不 import 任何 Client 包，样式只用主题 token；`dsh.client` 里因此**不需要也不应该**写 `external`。

刻意**不走 `ctx.web.fetch`**：该 seam 的 body 是 `{kind:'html'|'text'}` 闭合联合，图片的 Content-Type 会被 provider 以 `WEB_UNSUPPORTED_CONTENT_TYPE` 拒绝，所以图片字节由插件自己取；下载路径上的安全约束（HTTPS 图源、字节上限、超时、不携带任何 cookie/凭据）也由本插件自己保证。

## 兼容性

- DSH `0.1.0-rc.6` 时代（依赖 `tools` / `systemPrompt` / `fs` / `attachments` 服务，以及 `tool.call.toolview` 槽位）
- Linux / Windows（文件名清洗按 Windows 规则，两个平台都安全）

## 免责与合规

本插件直接抓取公开搜索结果页，只下载公开可见的图片，**不携带任何账号凭据**（全部匿名请求）。请自行确认下载与使用这些图片不侵犯著作权；不要用于批量抓取或再分发受版权保护的素材。B 站图源还请求了站内的专栏接口，请遵守其使用条款与速率限制。

## License

MIT
