/**
 * dsh-search-picture —— 「相关站点」图源（百科类）。
 *
 * 用户要求：除了图片搜索引擎，还能去**与该主题相关联的网站**找图——
 * 「例如动漫可以去萌娘百科这类的网站，其他图片去与它相关联的网站找」。
 *
 * 实测结论（`.work/probe-related-sites*.mjs`）决定了这里怎么写：
 *
 * | 站点 | 结果 |
 * |---|---|
 * | **萌娘百科** `zh.moegirl.org.cn` | ✅ `opensearch` 能精确命中词条（如「千夏(绝区零)」）；`generator=images` 能一次拿到词条的图 + 真实 URL + 尺寸；图床 `storage.moegirl.org.cn` **裸请求可下**（实测 1856x2618 / 895KB） |
 * | 同上，`prop=imageinfo` | ❌ 返回 `action-notallowed: Unauthorized API call`——**必须走 `generator=images`**，这点很容易踩 |
 * | 同上，`list=search` | ❌ 同样是未授权接口，所以词条检索只能用 `opensearch` |
 * | biligame wiki | ⚠️ 首次可用（下载到 1052x1362），随后**所有请求被 Tencent EdgeOne WAF 拦为 HTTP 567**，会随时间/频率触发 → 只作为可选的次要站点，且必须容错 |
 *
 * 「动漫去萌娘百科」这个判断是对的：它的词条图就是作品/角色的官方视觉图与立绘。
 */
import { BROWSER_UA } from './util.js';

/** 只接受位图；SVG 图标（Commons-emblem 之类）一律排除——下载器不处理矢量图。 */
const RASTER = /\.(png|jpe?g|gif|webp)(\?|$)/i;

/**
 * 词条图里混着大量**站点自用素材**（编辑图标、模板图标、logo、横幅），
 * 它们不是「作品图」。按文件名关键词排除——实测「可塑性记忆」13 个图里有 2 个是 SVG 图标，
 * 「千夏(绝区零)」30 个图里也混着界面素材。
 */
const NOISE_PATTERN = /(logo|icon|emblem|symbol|banner|placeholder|stub|disambig|edit|padlock|commons-|nuvola|question_book|wiki|template|flag_of|symbol_)/i;

/**
 * 站点定义：都是 MediaWiki，所以共用一套适配逻辑。
 *
 * `note` 用于在结果里如实说明该站点的可靠性问题。
 */
export const RELATED_SITES = {
  moegirl: {
    label: '萌娘百科',
    api: 'https://zh.moegirl.org.cn/api.php',
    /**
     * 词条页地址模板。`opensearch` 只返回标题，所以详情页要用 `?curid=` 或标题拼。
     * 萌娘百科的条目 URL 是 `/<标题>`（中文标题直接拼，做 URL 编码即可）。
     */
    pageUrl: (title) => `https://zh.moegirl.org.cn/${encodeURIComponent(title)}`,
    referer: 'https://zh.moegirl.org.cn/',
    /** 单次取多少个文件（MediaWiki `gimlimit`）。萌娘百科对 30 无异常。 */
    limit: 30,
    note: undefined,
  },
  biligame: {
    label: 'biligame wiki',
    api: 'https://wiki.biligame.com/zzz/api.php',
    pageUrl: (title) => `https://wiki.biligame.com/zzz/${encodeURIComponent(title)}`,
    referer: 'https://wiki.biligame.com/zzz/',
    limit: 20,
    // 实测会被 EdgeOne WAF 拦（HTTP 567，返回 HTML 而不是 JSON）——调用方必须容错。
    note: '该站点启用了 WAF，请求可能被拦截（HTTP 567）；被拦时本轮就没有它的结果，不影响其他图源。',
    enabledByDefault: false,
  },
};

/** 取 JSON，并识别「返回 HTML」的 WAF 拦截页。 */
async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    headers: {
      'user-agent': BROWSER_UA,
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9',
      ...(options.referer === undefined ? {} : { referer: options.referer }),
    },
    signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 20000),
  });
  const text = await res.text();
  // WAF 拦截页是 HTML；直接 JSON.parse 会抛 `Unexpected token '<'`，那是很难懂的报错。
  if (text.trimStart().startsWith('<') || text.trim() === '') {
    return { blocked: true, status: res.status };
  }
  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch {
    return { blocked: false, status: res.status, parseError: true };
  }
}

/**
 * 用 `opensearch` 找词条（`list=search` 是未授权接口，不能用）。
 *
 * @param site 站点定义。
 * @param query 查询词。
 * @param options `{ signal, timeoutMs }`。
 * @returns 词条标题数组（可能为空）。
 */
export async function searchEntries(site, query, options = {}) {
  const trimmed = String(query ?? '').trim();
  if (trimmed === '') return [];
  // 候选词：整串优先；再按空格/常见分隔符拆开，长词在前（长词更像作品名）。
  const parts = trimmed
    .split(/[\s,，、/|]+/u)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2);
  const ordered = [...new Set([trimmed, ...parts.sort((a, b) => b.length - a.length)])];

  for (const term of ordered) {
    const url = `${site.api}?action=opensearch&search=${encodeURIComponent(term)}&limit=5&format=json`;
    const res = await fetchJson(url, { ...options, referer: site.referer });
    if (res.blocked === true || res.json === undefined) return [];
    // opensearch 的返回是 [query, titles[], descriptions[], urls[]]
    const titles = Array.isArray(res.json) ? res.json[1] : undefined;
    if (!Array.isArray(titles) || titles.length === 0) continue;
    // **相关性校验**：opensearch 是前缀匹配，拆词后容易命中无关词条——
    // 实测搜「洱海 风景」会命中「风景杀」（一个卡牌游戏），那会给风景照带进完全无关的图。
    //
    // 判据（两者满足其一）：
    //   · 标题包含**整串**查询（去空格比较）；
    //   · 标题包含**最长的那个词**——多词查询里最长的通常是「主题/作品名」
    //     （「可塑性记忆 艾拉」→ 可塑性记忆、「千夏 绝区零」→ 绝区零）。
    // 这样「风景杀」因为不含「洱海」而被排除，而作品名/角色名的正常命中都保留。
    const primary = parts.length > 0
      ? [...parts].sort((a, b) => b.length - a.length)[0]
      : trimmed;
    const relevant = titles.filter((title) => {
      if (typeof title !== 'string' || title.trim() === '') return false;
      const flat = title.replace(/\s+/gu, '');
      if (flat.includes(trimmed.replace(/\s+/gu, ''))) return true;
      return primary !== undefined && primary.length >= 2 && title.includes(primary);
    });
    if (relevant.length > 0) return relevant;
  }
  return [];
}

/**
 * 取一个词条的图片（真实 URL + 尺寸）。
 *
 * **必须用 `generator=images`**：直接 `prop=imageinfo` 会被萌娘百科判为未授权
 * （`action-notallowed`），这是实测踩到的坑。
 *
 * @param site 站点定义。
 * @param title 词条标题。
 * @param options `{ signal, timeoutMs }`。
 * @returns `{ images, blocked }`。
 */
export async function entryImages(site, title, options = {}) {
  const url = `${site.api}?action=query&generator=images&titles=${encodeURIComponent(title)}`
    + `&gimlimit=${String(site.limit)}&prop=imageinfo&iiprop=url|size&format=json`;
  const res = await fetchJson(url, { ...options, referer: site.referer });
  if (res.blocked === true) return { images: [], blocked: true };
  const pages = res.json?.query?.pages;
  if (pages === undefined || typeof pages !== 'object') return { images: [], blocked: false };
  const images = [];
  for (const page of Object.values(pages)) {
    const info = page?.imageinfo?.[0];
    const imageUrl = info?.url;
    if (typeof imageUrl !== 'string') continue;
    if (!RASTER.test(imageUrl)) continue; // 排除 SVG 等矢量图标
    const name = String(page.title ?? '').replace(/^File:/, '');
    if (NOISE_PATTERN.test(name) || NOISE_PATTERN.test(imageUrl)) continue; // 排除站点自用素材
    const width = Number(info.width);
    const height = Number(info.height);
    images.push({
      title: name === '' ? undefined : name,
      imageUrl,
      width: Number.isFinite(width) && width > 0 ? width : undefined,
      height: Number.isFinite(height) && height > 0 ? height : undefined,
    });
  }
  return { images, blocked: false };
}

/**
 * 走「相关站点」通路收集候选。
 *
 * @param sites 要查询的站点 id 数组（见 {@link RELATED_SITES}）。
 * @param query 查询词。
 * @param options `{ signal, timeoutMs }`。
 * @returns `{ candidates, errors }`：候选与逐站点的失败原因（如实报告，不静默吞掉）。
 */
export async function collectRelatedCandidates(sites, query, options = {}) {
  const candidates = [];
  const errors = [];
  for (const id of sites) {
    const site = RELATED_SITES[id];
    if (site === undefined) {
      errors.push(`${id}: 未知站点`);
      continue;
    }
    try {
      const titles = await searchEntries(site, query, options);
      if (titles.length === 0) {
        errors.push(`${site.label}: 没有匹配的词条`);
        continue;
      }
      // 取前两个词条的图，既覆盖「作品」与「作品(角色)」两种命名，也不至于请求过多。
      let got = 0;
      let blocked = false;
      for (const title of titles.slice(0, 2)) {
        const { images, blocked: isBlocked } = await entryImages(site, title, options);
        if (isBlocked) {
          blocked = true;
          break;
        }
        for (const image of images) {
          candidates.push({
            engine: 'related',
            imageUrl: image.imageUrl,
            pageUrl: site.pageUrl(title),
            title: image.title === undefined ? site.label : `${site.label}·${image.title}`,
            width: image.width,
            height: image.height,
            sourceSite: site.label,
          });
          got += 1;
        }
      }
      if (blocked) errors.push(`${site.label}: 被 WAF 拦截（HTTP 567），本轮跳过`);
      else if (got === 0) errors.push(`${site.label}: 词条里没有可用图片`);
    } catch (error) {
      errors.push(`${site.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { candidates, errors };
}
