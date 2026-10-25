/**
 * dsh-search-picture —— 图源适配器（Bing / 百度 / 360 / 哔哩哔哩）。
 *
 * 前四家都是「公开搜索页 + 免 key」的取图方式，各自有稳定的结构化载荷：
 *   - Bing：搜索页 HTML 里每个结果的 `<a class="iusc" m="{...}">` 内嵌 JSON。
 *   - 百度：`image.baidu.com/search/acjson` 直接返回 JSON（缩略图与原始地址分离）。
 *   - 360 ：`image.so.com/j` 直接返回 JSON。
 *   - B 站：站内没有图片搜索，但「图文/专栏」是图片内容的主力，因此走两个入口：
 *       · `search/type=article` 按关键词搜专栏，每条带 `image_urls`（正文配图）；
 *       · `link_draw` 取图文图片集（`pictures[]`，一次多张）。
 *     两者都失败时再退化到视频搜索的封面 `pic`（1200x675 级，价值低但稳定）。
 *
 * 每个引擎只负责「查询词 → 候选列表」，不做下载、不做落盘，便于离线单测。
 * 候选统一形状：
 *   { imageUrl, pageUrl?, title?, width?, height?, thumbnailUrl?, engine, proxied?, tier? }
 *   `proxied === true` 表示这是受限的代理/缩略图（排序时靠后）；
 *   `tier: 'cover'` 表示「标题图」而非图片本体（排序时进一步靠后）。
 *
 * 需要高清图：Bing 用 `qft=+filterui:imagesize-wallpaper` 过滤，百度/360 在
 * 候选里带上真实宽高，由上层按面积排序筛选。
 */
import { decodeEntities, httpGet, normalizeUrl, BROWSER_UA } from './util.js';

/**
 * 参与并发查询的**图源引擎**。
 *
 * `official`（官网）不在这个列表里：它走的是「先找官网、再抓官网页面」的另一条通路，
 * 由 `official.js` 负责，但产出与图源同构的候选，因此共用同一套去重、筛选与排序。
 *
 * `safebooru` 也不在：它只按 **booru 标签**检索（`isla_(plastic_memories)` 这种形式），
 * 中文与自然语言查询在它这里恒为 0 结果，因此由调用方在「有标签可给」时才单独调用。
 */
export const ENGINES = ['bing', 'baidu', 'so360', 'bilibili'];

/**
 * Wikimedia Commons 的专用 User-Agent。
 *
 * **不能沿用 {@link BROWSER_UA}**：Wikimedia 的图片服务器按 UA 判定客户端类型，
 * 实测浏览器 UA 反而会被拦，返回 HTML 错误页而不是图片字节。
 * 官方要求 (https://meta.wikimedia.org/wiki/User-Agent_policy) UA 里带工具名与联系方式。
 */
const COMMONS_UA = 'dsh-search-picture/0.4.8 (DSH picture search plugin; +https://github.com/tuanzi0v0/dsh-search-picture)';

/** Commons 文件名前缀里常见的行政噪音，去掉后标题更适合显示。 */
const COMMONS_TITLE_PREFIXES = [
  /^File:/i,
  /^[0-9]+\s*[-–]\s*/,
];

/**
 * 解析 Wikimedia Commons `action=query&generator=search` 的响应。
 *
 * 与其余引擎的本质差别：Commons 的每条结果都带 **`extmetadata`**，里面有
 * `LicenseShortName`（如 `CC BY 4.0` / `Public domain` / `CC0`）与 `Artist`。
 * 这正是商业频道最需要的信息，因此**原样带到候选上**，供上层写进清单与笔记——
 * 丢了它，用户就得自己回站点翻授权，等于没加这个源。
 *
 * 三个必须知道的事实（实测）：
 *   1. `iiurlwidth` 返回的 `thumburl` 走 `thumb.wikimedia.org`，**实测被拒**（HTML 错误页）；
 *      而 `upload.wikimedia.org` 的原图直链可正常下载。所以这里**只用原图 `url`**，
 *      不把缩略图当作主图（单张 1~5 MB，靠上层 `maxBytes` 兜住）。
 *   2. 搜索是全文匹配，**会混进年代久远、主题无关的老图片**（实测搜「乌克兰前线」混进
 *      1934 年纳粹明信片）。这类图靠宽高与上层清晰度门槛淘汰；这里不过滤宽高以外的内容，
 *      以免误杀——相关性最终由模型看预览图判断。
 *   3. 结果里常见的 `File:` 前缀与编号要从标题里剥掉，否则预览清单很难读。
 *
 * @param text API 响应文本。
 * @returns 候选列表（带 `license` / `artist`）。
 */
export function parseCommonsJson(text) {
  if (typeof text !== 'string' || text.trim() === '') return [];
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  const pages = json?.query?.pages;
  if (pages === null || typeof pages !== 'object') return [];
  const candidates = [];
  // pages 是对象（按 pageid 索引），顺序不可靠 → 按 index 排回来保证稳定。
  const rows = Object.values(pages)
    .filter((page) => page !== null && typeof page === 'object')
    .sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0));
  for (const row of rows) {
    const info = Array.isArray(row.imageinfo) ? row.imageinfo[0] : undefined;
    if (info === undefined || typeof info !== 'object') continue;
    const imageUrl = normalizeUrl(info.url);
    if (imageUrl === undefined) continue;
    const width = Number(info.width);
    const height = Number(info.height);
    // 矢量图与动图不适合作视频底图：只收位图。
    if (typeof info.mime === 'string' && !info.mime.startsWith('image/')) continue;
    if (typeof info.mime === 'string' && /svg|gif|tiff|webp/.test(info.mime)) continue;
    const meta = info.extmetadata ?? {};
    const pick = (key) => {
      const raw = meta[key]?.value;
      if (raw === undefined || raw === null) return undefined;
      // extmetadata 的值是 HTML 片段（可能是链接），去标签留文本。
      const plain = String(raw).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      return plain === '' ? undefined : plain;
    };
    let title = pick('ObjectName') ?? String(row.title ?? '');
    for (const prefix of COMMONS_TITLE_PREFIXES) title = title.replace(prefix, '');
    // 标题里偶尔还有 .jpg 后缀，去掉。
    title = title.replace(/\.(jpe?g|png|webp)$/i, '').trim();
    // 描述页地址：拿不到 `descriptionurl` 时用文件名拼一个合法地址。
    const pageUrl = normalizeUrl(info.descriptionurl)
      ?? `https://commons.wikimedia.org/wiki/${encodeURIComponent(String(row.title ?? ''))}`;
    const artist = pick('Artist');
    candidates.push({
      engine: 'commons',
      imageUrl,
      pageUrl,
      title: title === '' ? undefined : title.slice(0, 120),
      width: Number.isFinite(width) && width > 0 ? width : undefined,
      height: Number.isFinite(height) && height > 0 ? height : undefined,
      // 授权与作者：商业频道选图的第一判据，不能丢。
      license: pick('LicenseShortName'),
      artist: artist === undefined ? undefined : artist.slice(0, 80),
    });
  }
  return candidates;
}

/**
 * 百度 `objURL` 的字符置换对照表：**编码字符 → 明文字符**。
 *
 * 表是双射（`a-z0-9` 之间的一个置换），因此表外字符（大写字母、`$`、`&`、`_` 等）
 * 原样保留。权威实现见 https://www.cnblogs.com/zoe233/p/8335065.html 。
 */
const BAIDU_OBJURL_MAP = {
  w: 'a', k: 'b', v: 'c', '1': 'd', j: 'e', u: 'f', '2': 'g', i: 'h', t: 'i',
  '3': 'j', h: 'k', s: 'l', '4': 'm', g: 'n', '5': 'o', r: 'p', q: 'q', '6': 'r',
  f: 's', p: 't', '7': 'u', e: 'v', o: 'w', '8': '1', d: '2', n: '3', '9': '4',
  c: '5', m: '6', '0': '7', b: '8', l: '9', a: '0',
};

/**
 * 百度 `objURL` 里的多字符串替换表，必须在字符表替换**之前**应用。
 * 顺序反了会把 `_z2C$q` 这类串里的字符先换掉，再也匹配不上。
 */
const BAIDU_OBJURL_SEQUENCES = [
  ['_z2C$q', ':'],
  ['_z&e3B', '.'],
  ['AzdH3F', '/'],
];

/**
 * 解码百度 `objURL`（形如 `ippr_z2C$qAzdH3FAzdH3F...`）与同样编码的来源页字段。
 *
 * 载荷有两种历史写法，靠观察无法可靠区分，因此这里生成几个候选、逐个解码后只接受
 * 能解析成绝对 http(s) 地址的那个：
 *   - 2018 年前后的写法：`ippr` 本身就是 `http`，其后的 `_z2C$q` 解开是 `://`，
 *     所以**不能**剥掉 `ippr`，否则协议头会缺一节。
 *   - 较新的写法：`ippr` / `ipprf` 是口令前缀，剥掉后剩下的 `_z2C$q` 提供 `://`。
 *
 * 候选全部失败时返回 undefined——绝不把半截串拼到某个兜底域名上，
 * 那样结果里会出现一个看似合法、实则打不开的假地址。
 *
 * @param encoded 编码后的地址。
 * @returns 解码后的 http(s) 地址，或 undefined。
 */
export function decodeBaiduObjUrl(encoded) {
  if (typeof encoded !== 'string' || encoded === '') return undefined;
  // 已经是明文地址时直接规范化返回。
  if (encoded.startsWith('http://') || encoded.startsWith('https://')) return normalizeUrl(encoded);
  const candidates = [encoded];
  if (encoded.startsWith('ipprf')) candidates.push(encoded.slice(5));
  if (encoded.startsWith('ippr')) candidates.push(encoded.slice(4));
  for (const candidate of candidates) {
    let text = candidate;
    for (const [sequence, plain] of BAIDU_OBJURL_SEQUENCES) text = text.split(sequence).join(plain);
    let out = '';
    for (const char of text) out += BAIDU_OBJURL_MAP[char] ?? char;
    if (/^https?:\/\//u.test(out)) {
      const url = normalizeUrl(out);
      if (url !== undefined) return url;
    }
  }
  return undefined;
}

/**
 * 从 URL 里探测「已经写死的尺寸后缀」，用来提前淘汰明显的小图。
 * 例：`...-bkimg-process,v=1.2,enable,size,640`、`..._300x300.jpg`、`...?w=500&h=400`。
 * @param url 图片地址。
 * @returns 最大边长（像素），或 undefined（URL 里没有尺寸信息）。
 */
export function sizeHintOf(url) {
  if (typeof url !== 'string') return undefined;
  let hint;
  const consider = (value) => {
    if (Number.isFinite(value) && value > 0 && (hint === undefined || value > hint)) hint = value;
  };
  // 路径/查询里的 `WxH`（如 _300x300、/320/240/）。
  for (const match of url.matchAll(/[_/\-.](?:sdr[_/]?_?)?(\d{2,4})x(\d{2,4})(?![\d])/g)) {
    consider(Number(match[1]));
    consider(Number(match[2]));
  }
  // 查询参数 w/h/width/height/size。
  for (const match of url.matchAll(/[?&](?:w|h|width|height|size)=(\d{2,5})(?![\d])/g)) consider(Number(match[1]));
  // 百度百科图床的 `...,size,640` 形式。
  for (const match of url.matchAll(/[,_](?:size)[,_](\d{2,5})(?![\d])/g)) consider(Number(match[1]));
  return hint;
}

/**
 * 解析 Bing 结果页里的 `iusc` JSON 载荷。
 * @param html Bing 搜索页 HTML。
 * @returns 候选列表。
 */
export function parseBingHtml(html) {
  const candidates = [];
  const pattern = /class="iusc"[^>]*?m="([^"]+)"/g;
  for (const match of html.matchAll(pattern)) {
    let parsed;
    try {
      parsed = JSON.parse(decodeEntities(match[1]));
    } catch {
      continue;
    }
    const imageUrl = normalizeUrl(parsed.murl);
    if (imageUrl === undefined) continue;
    candidates.push({
      engine: 'bing',
      imageUrl,
      thumbnailUrl: normalizeUrl(parsed.turl),
      pageUrl: normalizeUrl(parsed.purl),
      title: typeof parsed.t === 'string' && parsed.t !== '' ? parsed.t : undefined,
      width: undefined,
      height: undefined,
      // Bing 结果页不携带原图尺寸，但不少原图 URL 带 `...,size,640` 之类写死的
      // 尺寸后缀；这类是同图源里的小图版本，标成低优先，避免挤掉原图。
      proxied: sizeHintOf(imageUrl) !== undefined && sizeHintOf(imageUrl) < 1024,
    });
  }
  return candidates;
}

/**
 * 解析百度响应里的来源页字段。
 *
 * 百度的 `fromJumpUrl` / `FromURL` 与 `objURL` 用同一套编码（`ippr` 口令 + 字符置换），
 * 但也会直接给明文地址，所以两条路都要走。解不出来时返回 undefined，而不是把
 * 一个 base 兜底的假地址写进结果。
 *
 * @param raw 原始字段值。
 * @returns 规范化后的 http(s) 地址，或 undefined。
 */
export function decodeBaiduPageUrl(raw) {
  if (typeof raw !== 'string' || raw === '') return undefined;
  if (raw.startsWith('http://') || raw.startsWith('https://')) return normalizeUrl(raw);
  return decodeBaiduObjUrl(raw);
}

/**
 * 解析百度 `acjson` 响应体。
 * @param text 响应 JSON 文本。
 * @returns 候选列表。
 */
export function parseBaiduJson(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  const rows = Array.isArray(json?.data) ? json.data : [];
  const candidates = [];
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    // 原始地址优先：replaceUrl 是明文原图，objURL 解码后也是原图；
    // middleURL/thumbURL 只是百度 CDN 的受限代理图（实测恒定 ~667x500 webp），
    // 所以只在两者都拿不到时才退化使用。
    const replaced = Array.isArray(row.replaceUrl) && row.replaceUrl.length > 0 ? row.replaceUrl[0] : undefined;
    const original = normalizeUrl(replaced?.ObjURL ?? replaced?.ObjUrl) ?? decodeBaiduObjUrl(row.objURL);
    const proxied = normalizeUrl(row.middleURL) ?? normalizeUrl(row.thumbURL);
    const imageUrl = original ?? proxied;
    if (imageUrl === undefined) continue;
    const width = Number(row.width);
    const height = Number(row.height);
    const title = typeof row.fromPageTitleEnc === 'string' && row.fromPageTitleEnc !== ''
      ? row.fromPageTitleEnc
      : typeof row.fromPageTitle === 'string'
        ? row.fromPageTitle.replace(/<[^>]*>/g, '')
        : undefined;
    candidates.push({
      engine: 'baidu',
      imageUrl,
      thumbnailUrl: normalizeUrl(row.thumbURL) ?? normalizeUrl(row.middleURL),
      pageUrl: decodeBaiduPageUrl(row.fromJumpUrl) ?? decodeBaiduPageUrl(replaced?.FromURL),
      title: title === undefined || title === '' ? undefined : title,
      width: Number.isFinite(width) && width > 0 ? width : undefined,
      height: Number.isFinite(height) && height > 0 ? height : undefined,
      proxied: original === undefined,
    });
  }
  return candidates;
}

/**
 * 解析 360 图片 `image.so.com/j` 响应体。
 * @param text 响应 JSON 文本。
 * @returns 候选列表。
 */
export function parseSo360Json(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  const rows = Array.isArray(json?.list) ? json.list : [];
  const candidates = [];
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    const imageUrl = normalizeUrl(row.img) ?? normalizeUrl(row.thumb_bak) ?? normalizeUrl(row.thumb);
    if (imageUrl === undefined) continue;
    const width = Number(row.width);
    const height = Number(row.height);
    candidates.push({
      engine: 'so360',
      imageUrl,
      thumbnailUrl: normalizeUrl(row.thumb) ?? normalizeUrl(row.thumb_bak),
      pageUrl: normalizeUrl(row.link),
      title: typeof row.title === 'string' && row.title !== '' ? row.title : undefined,
      width: Number.isFinite(width) && width > 0 ? width : undefined,
      height: Number.isFinite(height) && height > 0 ? height : undefined,
    });
  }
  return candidates;
}

/**
 * 解析 B 站专栏搜索 `search/type=article` 响应体。
 *
 * 每条结果的 `image_urls` 是正文配图（可能多张），比封面更有价值；没有
 * `image_urls` 时退回 `cover`。标题里带 `<em>` 高亮标签，要清掉。
 *
 * @param text 响应 JSON 文本。
 * @returns 候选列表。
 */
export function parseBilibiliArticleJson(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  const rows = Array.isArray(json?.data?.result) ? json.data.result : [];
  const candidates = [];
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    const id = row.id;
    const pageUrl = Number.isFinite(Number(id)) && Number(id) > 0
      ? `https://www.bilibili.com/read/cv${String(id)}`
      : undefined;
    const title = typeof row.title === 'string' ? row.title.replace(/<[^>]*>/g, '').trim() : '';
    const images = Array.isArray(row.image_urls) ? row.image_urls : [];
    const covers = Array.isArray(row.cover) ? row.cover : row.cover === undefined || row.cover === null ? [] : [row.cover];
    const urls = [...images, ...covers];
    for (const raw of urls) {
      const imageUrl = normalizeUrl(typeof raw === 'string' ? raw : undefined);
      if (imageUrl === undefined) continue;
      candidates.push({
        engine: 'bilibili',
        imageUrl,
        pageUrl,
        title: title === '' ? undefined : title,
        width: undefined,
        height: undefined,
      });
    }
  }
  return candidates;
}

/**
 * 解析 B 站图文图片集 `link_draw` 响应体。
 *
 * 一个图文条目通常带多张图（`pictures[].img_src`），因此同一个 `doc_id` 会产出
 * 多条候选，`pageUrl` 统一指向该条动态。
 *
 * @param text 响应 JSON 文本。
 * @returns 候选列表。
 */
export function parseBilibiliDrawJson(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  const items = Array.isArray(json?.data?.items) ? json.data.items : [];
  const candidates = [];
  for (const item of items) {
    if (item === null || typeof item !== 'object') continue;
    const pictures = Array.isArray(item.pictures) ? item.pictures : [];
    const pageUrl = item.dyn_id === undefined
      ? undefined
      : `https://t.bilibili.com/${String(item.dyn_id)}`;
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    for (const picture of pictures) {
      if (picture === null || typeof picture !== 'object') continue;
      const imageUrl = normalizeUrl(picture.img_src ?? picture.img_url);
      if (imageUrl === undefined) continue;
      const width = Number(picture.img_width);
      const height = Number(picture.img_height);
      candidates.push({
        engine: 'bilibili',
        imageUrl,
        pageUrl,
        title: title === '' ? undefined : title,
        width: Number.isFinite(width) && width > 0 ? width : undefined,
        height: Number.isFinite(height) && height > 0 ? height : undefined,
      });
    }
  }
  return candidates;
}

/**
 * 解析 Safebooru（`safebooru.org/index.php?page=dapi&s=post&q=index&json=1`）响应体。
 *
 * 两个实测出来的坑：
 *   1. **无结果时返回 `HTTP 200` + 空 body**（不是 `[]`），JSON.parse 会抛错——
 *      必须当成「零结果」而不是「解析失败」，否则会误报 `no parsable results`；
 *   2. 它只按**标签**匹配：`Plastic Memories Isla` 这种带空格的自然语言查不到
 *      （0 结果），必须用 `isla_(plastic_memories)` 这样的 booru 标签形式。
 *
 * 图片取 `file_url`（原图，实测 1240x1754 ~ 3000x6000）；`sample_url` 只有 850px 宽，
 * 达不到 720p 门槛，因此仅作缩略图字段，不作主图。
 *
 * @param text 响应文本。
 * @returns 候选列表。
 */
export function parseSafebooruJson(text) {
  if (text.trim() === '') return [];
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(json)) return [];
  const candidates = [];
  for (const row of json) {
    if (row === null || typeof row !== 'object') continue;
    const fileUrl = normalizeUrl(row.file_url);
    if (fileUrl === undefined) continue;
    const width = Number(row.width);
    const height = Number(row.height);
    // 标签串里含大量下划线/括号，标题里只取前几个空格分隔的标签，避免噪声过长。
    const tags = typeof row.tags === 'string' ? row.tags.split(/\s+/).filter(Boolean) : [];
    const title = tags.slice(0, 6).join(' ');
    candidates.push({
      engine: 'safebooru',
      imageUrl: fileUrl,
      thumbnailUrl: normalizeUrl(row.sample_url),
      // 图片直链没有稳定的「页面」概念，用图片详情页地址最有用。
      pageUrl: Number.isFinite(Number(row.id)) ? `https://safebooru.org/index.php?page=post&s=view&id=${String(row.id)}` : undefined,
      title: title === '' ? undefined : title,
      width: Number.isFinite(width) && width > 0 ? width : undefined,
      height: Number.isFinite(height) && height > 0 ? height : undefined,
    });
  }
  return candidates;
}

/** 各引擎的请求构造：搜索 URL、请求头、解析函数，以及可选的兜底 URL。 */
const ENGINE_SPECS = {
  bing: {
    label: 'Bing 图片',
    request(query, page) {
      const first = page * 35 + 1;
      const base = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&form=HDRSC2&first=${String(first)}`;
      // 实测：`imagesize-large` 仍会混进 500px 级缩略图，`imagesize-wallpaper`
      // 才稳定给出 1080p 以上的图；后者偶尔命中过少时退回首者。
      return {
        url: `${base}&qft=+filterui:imagesize-wallpaper`,
        fallbackUrl: `${base}&qft=+filterui:imagesize-large`,
        headers: { accept: 'text/html,application/xhtml+xml,text/html;q=0.9', 'user-agent': BROWSER_UA },
        parse: (body) => parseBingHtml(body),
      };
    },
  },
  baidu: {
    label: '百度图片',
    request(query, page) {
      const pn = page * 30;
      return {
        url:
          'https://image.baidu.com/search/acjson?tn=resultjson_com&ipn=rj&ct=201326592&fp=result' +
          `&word=${encodeURIComponent(query)}&pn=${String(pn)}&rn=30&gsm=${(pn + 1).toString(16)}`,
        headers: { accept: 'application/json, text/plain, */*', referer: 'https://image.baidu.com/' },
        parse: (body) => parseBaiduJson(body),
      };
    },
  },
  so360: {
    label: '360 图片',
    request(query, page) {
      const sn = page * 30;
      return {
        url:
          'https://image.so.com/j?' +
          `q=${encodeURIComponent(query)}&src=srp&sn=${String(sn)}&pn=30`,
        headers: { accept: 'application/json, text/plain, */*', referer: 'https://image.so.com/' },
        parse: (body) => parseSo360Json(body),
      };
    },
  },
  safebooru: {
    label: 'Safebooru 插画',
    // 注意：这里收到的 query 必须是 **booru 标签**（如 `isla_(plastic_memories)`），
    // 由调用方保证——中文/自然语言查询会被上游拦掉，不会走到这里。
    request(query, page) {
      const pid = page;
      return {
        url:
          'https://safebooru.org/index.php?page=dapi&s=post&q=index&json=1' +
          `&limit=100&pid=${String(pid)}&tags=${encodeURIComponent(query)}`,
        headers: { accept: 'application/json, text/plain, */*', referer: 'https://safebooru.org/' },
        parse: (body) => parseSafebooruJson(body),
      };
    },
  },
  commons: {
    label: 'Wikimedia Commons（CC 授权）',
    // 只在 `query` 是自然语言/关键词时可用；检索范围限定 **File 命名空间（6）**，
    // 否则会混进词条与分类页。`iiprop` 必须带 `extmetadata`——授权信息全在那里。
    request(query, page) {
      const offset = page * 30;
      const params = new URLSearchParams({
        action: 'query',
        format: 'json',
        formatversion: '2',
        generator: 'search',
        gsrsearch: `${query} filetype:bitmap`,
        gsrnamespace: '6',
        gsrlimit: '30',
        gsroffset: String(offset),
        prop: 'imageinfo',
        // 只取原图：缩略图域名实测被拒（见 parseCommonsJson 的说明）。
        iiprop: 'url|size|extmetadata|mime',
      });
      return {
        url: `https://commons.wikimedia.org/w/api.php?${params.toString()}`,
        headers: {
          accept: 'application/json',
          // 专用 UA：浏览器 UA 会被图片服务器当成滥用请求。
          'user-agent': COMMONS_UA,
        },
        parse: (body) => parseCommonsJson(body),
      };
    },
  },
  bilibili: {
    label: '哔哩哔哩图文',
    // 站内没有图片搜索。**只取专栏正文配图 / 图文图片集**：视频封面是 UP 主给视频做的
    // 标题图，不是「这张图」本身，按用户要求不作为结果（宁可返回「无结果」）。
    legs: [
      {
        name: 'article',
        url: (query, page) =>
          `https://api.bilibili.com/x/web-interface/search/type?search_type=article&keyword=${encodeURIComponent(query)}&page=${String(page + 1)}`,
        headers: { accept: 'application/json, text/plain, */*', referer: 'https://search.bilibili.com/' },
        parse: (body) => parseBilibiliArticleJson(body),
      },
    ],
  },
};

/**
 * 运行单个引擎的一次查询。
 *
 * 支持两种引擎形态：
 *   - `request`：单次请求 + 可选兜底 URL（Bing 的尺寸过滤用到这条路径）；
 *   - `legs`：按顺序尝试的多个入口，第一个解析出候选即返回。
 *     **B 站目前只用 `legs` 表达单一入口**（`search/type=article`）；曾经有过的
 *     「视频封面兜底」已按用户要求移除——封面是 UP 主给视频做的标题图，不是
 *     「这张图」本身，宁可返回「无结果」。
 *
 * **限流处理**：B 站搜索在无 cookie 时对连发请求返回 `-412 request was banned`。
 * 实测（.work/probe-bili-ratelimit.mjs）：连发第 2 次就中招，但等 ~4 秒即恢复
 * （等 2 秒仍失败、等 4 秒成功）。因此遇到它按 2.5s/5s/7.5s 递增等待重试，最多
 * 4 次尝试——这样插件不会把「暂时被限流」误报成「该图源不可用」。
 *
 * @param engine 引擎 id（{@link ENGINES} 之一）。
 * @param query 查询词。
 * @param options `{ signal, page, timeoutMs }`。
 * @returns `{ engine, candidates, error? }`。
 */
export async function runEngine(engine, query, options = {}) {
  const spec = ENGINE_SPECS[engine];
  if (spec === undefined) return { engine, candidates: [], error: `unknown engine "${String(engine)}"` };
  const page = options.page ?? 0;
  const timeoutMs = options.timeoutMs ?? 20000;
  /** 限流时的退避阶梯（毫秒）。 */
  const backoffMs = [2500, 5000, 7500];

  /**
   * 取一次并解析；限流时按阶梯退避后重试。
   *
   * 限流有两种表现，必须都识别：**HTTP 412**（无 body）与 **HTTP 200 + body 里的
   * `-412 request was banned`**。实测两种都会出现，只认其中一种就会漏掉退避。
   */
  const attempt = async (url, headers, parse) => {
    let lastError = 'no parsable results';
    for (let round = 0; round <= backoffMs.length; round += 1) {
      const response = await httpGet(url, { signal: options.signal, timeoutMs, headers });
      const body = response.status >= 200 && response.status < 300 ? new TextDecoder('utf-8').decode(response.bytes) : '';
      const banned = response.status === 412 || body.includes('-412') || body.includes('request was banned');
      if (banned) {
        lastError = `rate limited (HTTP ${String(response.status)}${body.includes('request was banned') ? ' request was banned' : ''})`;
      } else if (response.status < 200 || response.status >= 300) {
        // 非限流的 HTTP 错误是硬失败，不重试。
        throw new Error(`HTTP ${String(response.status)}`);
      } else {
        const candidates = parse(body);
        if (candidates.length > 0) return candidates;
        lastError = 'no parsable results';
      }
      if (!banned || options.signal?.aborted === true || round === backoffMs.length) break;
      await new Promise((resolve) => setTimeout(resolve, backoffMs[round]));
    }
    throw new Error(lastError);
  };

  try {
    if (Array.isArray(spec.legs)) {
      let lastError = 'no parsable results';
      for (const leg of spec.legs) {
        try {
          const candidates = await attempt(leg.url(query, page), leg.headers, leg.parse);
          if (candidates.length > 0) return { engine, candidates };
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
      }
      return { engine, candidates: [], error: lastError };
    }

    const request = spec.request(query, page);
    let candidates = await attempt(request.url, request.headers, request.parse);
    if (candidates.length === 0 && typeof request.fallbackUrl === 'string') {
      candidates = await attempt(request.fallbackUrl, request.headers, request.parse);
    }
    if (candidates.length === 0) return { engine, candidates: [], error: 'no parsable results' };
    return { engine, candidates };
  } catch (error) {
    return { engine, candidates: [], error: error instanceof Error ? error.message : String(error) };
  }
}

/** 引擎显示名。 */
export function engineLabel(engine) {
  if (engine === 'official') return '官方网站';
  if (engine === 'safebooru') return 'Safebooru 插画';
  if (engine === 'related') return '相关站点（百科）';
  if (engine === 'commons') return 'Wikimedia Commons（CC 授权）';
  return ENGINE_SPECS[engine]?.label ?? engine;
}
