/**
 * dsh-search-picture —— 「官方网站」图源。
 *
 * 思路（用户建议）：先判断用户提到的实体有没有官网，有就去官网取图——官网素材的
 * 权威性与分辨率都远胜第三方转载。
 *
 * 实测（.work/probe-official-site*.mjs，对象为《明日方舟：终末地》与 DeepSeek 官网）：
 *   - 找官网：Bing 网页搜索结果的**站外链接**里第一条就是国服官网，稳定可得；
 *   - 官网首页 HTML 里直接嵌着完整图片地址（`web.hycdn.cn/upload/image/<日期>/<哈希>.png`），
 *     国服/国际站各 21 条，HTTP 200 全部可下，其中 20 条 ≥720p（1600x900 ~ 1920x1080，
 *     单张 1~3.5 MB）；
 *   - 但**只能拿到首页那一批**：官网是 Next.js 客户端渲染，初始 HTML 里没有任何站内
 *     `<a href>`，所以无法顺着链接去找角色页；而且图片目录按日期+哈希组织，
 *     从 URL 看不出与哪个角色对应。
 *
 * 因此本模块的定位是**正大光明地标注为「官方素材」的补充图源**，而不是「帮你找到那个
 * 角色的官图」。调用方必须把「不保证包含指定角色」如实写进结果。
 */
import { decodeEntities, httpGet, normalizeUrl } from './util.js';

/**
 * 第三方聚合站：命中即判定「不是官网」。
 * 这份名单同时承担反例作用——避免把 bilibili/4399/taptap 之类当成官网去抓。
 */
const THIRD_PARTY_HOSTS = [
  'bilibili.com', 'bilibili.cn', 'taptap.cn', 'taptap.com', '4399.cn', '9game.cn',
  'gamersky.com', 'zhihu.com', 'baidu.com', 'sohu.com', 'sina.com.cn', 'qq.com',
  '163.com', 'acfun.cn', 'xiaohongshu.com', 'douyin.com', 'weibo.com', 'huya.com',
  'douyu.com', 'gcores.com', 'ali213.net', '3dmgame.com', 'yxdown.com',
  'qianlong.com', 'aixifan.com', 'wandoujia.com', 'fz.wiki', 'apple.com',
  'microsoft.com', 'google.com', 'bing.com', 'wikipedia.org', 'steampowered.com',
];

/** 结果页标题里出现这些词，基本就是官网。 */
const OFFICIAL_TITLE = /(官网|官方网站|official\s*(site|website))/i;

/** 搜索请求头：Bing 网页搜索需要浏览器 UA。 */
const SEARCH_HEADERS = { accept: 'text/html,application/xhtml+xml', 'accept-language': 'zh-CN,zh;q=0.9' };

/** 页面请求头。 */
const PAGE_HEADERS = { accept: 'text/html,application/xhtml+xml' };

/**
 * 判断一个结果是否像「官网」。
 * @param url 结果地址。
 * @param title 结果标题。
 * @returns `{ official, reason }`。
 */
export function looksOfficial(url, title) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { official: false, reason: '地址无法解析' };
  }
  const host = parsed.hostname.toLowerCase();
  if (THIRD_PARTY_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
    return { official: false, reason: `第三方站点 ${host}` };
  }
  const saidOfficial = OFFICIAL_TITLE.test(String(title ?? ''));
  if (saidOfficial) return { official: true, reason: `标题自称官网（${host}）` };
  // 域名层级浅 + 路径是根路径，作为弱信号。
  const shallow = host.split('.').length <= 3;
  const rootPath = parsed.pathname === '/' || /^\/index\.html?$/i.test(parsed.pathname);
  if (shallow && rootPath) return { official: true, reason: `根路径 + 浅域名（${host}）` };
  return { official: false, reason: `无官网特征（${host}）` };
}

/**
 * 从 Bing 网页搜索结果页里抽取「站外链接 + 标题」。
 *
 * 不能用 `<h2><a href>` 这种精确结构：实测 Bing 会给结果包一层跳转，标题与链接的
 * 嵌套关系不稳定。这里退一步——先取所有站外 `<a>`，再用标题文字判断——实测能稳定
 * 命中国服官网那条。
 *
 * @param html 结果页 HTML。
 * @returns `{ url, title }[]`。
 */
export function extractSearchResults(html) {
  const results = [];
  const seen = new Set();
  for (const match of html.matchAll(/<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]{0,120}?)<\/a>/g)) {
    const url = decodeEntities(match[1]);
    if (/bing\.com|microsoft|msn\.com|go\.microsoft|live\.com/i.test(url)) continue;
    const title = decodeEntities(match[2].replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
    const key = `${url}\n${title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ url, title });
  }
  return results;
}

/**
 * 从 HTML 里抽取完整图片地址。
 *
 * 两个坑都必须避开，否则会把**能下载的大图误判成 404**（都实际踩过）：
 *   1. 不能把 `&` 当分隔符 —— `?x-oss-process=image/resize,w_1920&v=2` 会被截断；
 *   2. 不能要求地址以 `http` 开头 —— 页面里也有 `//cdn.example.com/a.png` 这种
 *      协议相对写法，要补上协议再返回。
 *
 * @param html 页面 HTML。
 * @param baseUrl 协议相对地址的解析基准（可选）。
 * @returns 图片地址数组（去重）。
 */
export function extractImageUrls(html, baseUrl) {
  const out = new Set();
  const add = (raw) => {
    // 只削掉「明确的句读收尾」：可选的右括号/引号，然后是句末的 `.` `;` `:`。
    // **绝不能把 `,` 或 `&` 当收尾**——`?x-oss-process=image/resize,w_1920&v=2`
    // 正是靠它们才完整，削掉就变成一个 404 的地址（实测踩过两次）。
    let cleaned = raw.replace(/[)\]}"']+$/, '').replace(/[;:.]+$/, '');
    // 收尾的 `,` 只在不像是参数分隔符时才算句读（后面应当还有内容）。
    while (cleaned.endsWith(',') || cleaned.endsWith('&') || cleaned.endsWith('=')) cleaned = cleaned.slice(0, -1);
    if (!/\.(png|jpe?g|webp|gif)(\?|$)/i.test(cleaned)) return;
    const url = normalizeUrl(cleaned, baseUrl);
    if (url !== undefined) out.add(url);
  };
  // 绝对地址。分隔符只取真正会终止 URL 的字符：空白、各种引号、尖括号、括号、反斜杠、方括号。
  // 刻意**不含** `,` `&` `=` `?` —— 它们是查询串的一部分。
  for (const match of html.matchAll(/https?:\/\/[^\s"'<>()\\\[\]]+/gi)) add(match[0]);
  // 协议相对地址：需要基准才能解析成绝对地址。
  if (typeof baseUrl === 'string' && baseUrl !== '') {
    for (const match of html.matchAll(/["'(](\/\/[^\s"'<>()\\\[\]]+)/g)) add(match[1]);
  }
  return [...out];
}

/**
 * 搜索一个实体的官网。
 *
 * @param entity 用户提到的实体（游戏名、产品名等）。
 * @param options `{ signal, timeoutMs }`。
 * @returns `{ site, reason, error? }`；`site` 为官网地址，未找到时 undefined。
 */
export async function findOfficialSite(entity, options = {}) {
  const query = `${entity} 官网`;
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
  let html;
  try {
    const response = await httpGet(url, {
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? 20000,
      headers: SEARCH_HEADERS,
    });
    if (response.status < 200 || response.status >= 300) {
      return { site: undefined, reason: '', error: `搜索返回 HTTP ${String(response.status)}` };
    }
    html = new TextDecoder('utf-8').decode(response.bytes);
  } catch (error) {
    return { site: undefined, reason: '', error: `搜索失败：${error instanceof Error ? error.message : String(error)}` };
  }

  const results = extractSearchResults(html);
  for (const result of results) {
    const judged = looksOfficial(result.url, result.title);
    if (judged.official) return { site: result.url, reason: judged.reason };
  }
  // 标题自称官网的优先，其次看域名里是否包含实体的英文/数字片段。
  return { site: undefined, reason: `已检查 ${String(results.length)} 条结果，无官网特征` };
}

/**
 * 抓一个官网页面并抽出可用的图片候选。
 *
 * @param site 官网地址（也接受站点根路径）。
 * @param options `{ signal, timeoutMs, limit }`。
 * @returns `{ candidates, pageUrl, status, error? }`；候选的 `tier` 标为 `official`。
 */
export async function collectOfficialImages(site, options = {}) {
  const limit = options.limit ?? 24;
  let pageUrl = site;
  let html;
  try {
    const response = await httpGet(pageUrl, {
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? 25000,
      headers: PAGE_HEADERS,
    });
    if (response.status < 200 || response.status >= 300) {
      return { candidates: [], pageUrl, status: response.status, error: `官网返回 HTTP ${String(response.status)}` };
    }
    html = new TextDecoder('utf-8').decode(response.bytes);
  } catch (error) {
    return { candidates: [], pageUrl, status: 0, error: `抓取官网失败：${error instanceof Error ? error.message : String(error)}` };
  }

  const candidates = extractImageUrls(html, pageUrl).slice(0, limit).map((imageUrl) => ({
    engine: 'official',
    imageUrl,
    pageUrl,
    title: undefined,
    width: undefined,
    height: undefined,
    // 官方素材：来源权威，但**不保证与用户点名的角色对应**，因此不算「角色匹配」，
    // 只在排序里享有第二档优先（仅次于非代理的图源原图）。
    tier: 'official',
  }));
  return { candidates, pageUrl, status: 200 };
}
