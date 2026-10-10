/**
 * 可行性实测：「先找官网、再去官网取图」这条路在我的网络下走不走得通？
 *
 * 三个必须验证的环节，缺一个这功能就不值得做：
 *   1. 能不能从搜索引擎结果里认出「官网」并拿到它的域名；
 *   2. 官网首页的 HTML 里有没有可用的图片（og:image / <img> / 内联脚本里的地址）；
 *   3. 那些图下载后是不是真的高清（还是只有 logo 和按钮图标）。
 *
 * 不预设结论：每一条都打印真实数据。
 */
import { decodeEntities, httpGet, normalizeUrl, BROWSER_UA } from '../src/util.js';
import { imageSize, sniffImageMediaType } from '../src/image.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 已知的「第三方聚合站」：命中就不算官网。 */
const THIRD_PARTY = [
  'bilibili.com', 'taptap.cn', 'taptap.com', '4399.cn', '9game.cn', 'gamersky.com',
  'zhihu.com', 'baidu.com', 'sohu.com', 'sina.com.cn', 'qq.com', '163.com',
  'acfun.cn', 'xiaohongshu.com', 'douyin.com', 'weibo.com', 'huya.com', 'douyu.com',
  'gcores.com', 'ali213.net', '3dmgame.com', 'yxdown.com', 'kuaibao.qq.com',
  'qianlong.com', 'aixifan.com', 'img4399.com', 'wandoujia.com', 'bilibili.cn',
];

/** 判断一个结果页地址像不像「官方网站」。 */
function looksOfficial(url, title) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { official: false, reason: 'unparsable' };
  }
  const host = parsed.hostname.toLowerCase();
  if (THIRD_PARTY.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
    return { official: false, reason: `third-party host ${host}` };
  }
  const text = String(title ?? '');
  const officialWord = /(官网|官方网站|official\s*site|官方网站)/i.test(text);
  // 官网常见的路径/域名特征。
  const pathHint = /^\/(index\.html?)?$/i.test(parsed.pathname) && parsed.search === '';
  const domainHint = /(^|\.)(com|cn|net|jp|co\.jp|game)$/.test(host) && host.split('.').length <= 3;
  return {
    official: officialWord || (domainHint && pathHint),
    reason: `host=${host} officialWord=${String(officialWord)} domainHint=${String(domainHint)}`,
  };
}

/** 从 HTML 里抽取候选图片地址（含 og:image、img 标签、懒加载属性、内联脚本）。 */
function extractImageUrls(html, baseUrl) {
  const found = new Map();
  const add = (raw, where) => {
    const url = normalizeUrl(typeof raw === 'string' ? decodeEntities(raw) : undefined, baseUrl);
    if (url === undefined) return;
    if (/\.(js|css|svg|ico|woff2?|ttf)(\?|$)/i.test(url)) return;
    if (!found.has(url)) found.set(url, where);
  };
  for (const match of html.matchAll(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/gi)) add(match[1], 'og:image');
  for (const match of html.matchAll(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image["']/gi)) add(match[1], 'og:image');
  for (const match of html.matchAll(/<img[^>]+>/gi)) {
    const tag = match[0];
    for (const attribute of ['src', 'data-src', 'data-original', 'data-lazy-src', 'data-echo']) {
      const value = new RegExp(`${attribute}=["']([^"']+)["']`, 'i').exec(tag);
      if (value) add(value[1], `img@${attribute}`);
    }
    const srcset = /srcset=["']([^"']+)["']/i.exec(tag);
    if (srcset) {
      for (const part of srcset[1].split(',')) add(part.trim().split(/\s+/)[0], 'img@srcset');
    }
  }
  // 样式背景图与内联脚本里的字符串。
  for (const match of html.matchAll(/url\((['"]?)([^'")]+\.(?:png|jpe?g|webp|gif)[^'")]*)\1\)/gi)) add(match[2], 'css url()');
  for (const match of html.matchAll(/["']((?:https?:)?\/\/[^"']+\.(?:png|jpe?g|webp|gif)[^"']*)["']/gi)) add(match[1], 'inline script');
  return [...found.entries()].map(([url, where]) => ({ url, where }));
}

async function probe(label, query) {
  console.log(`\n${'='.repeat(72)}\n${label}  （查询词：${query}）\n${'='.repeat(72)}`);

  // 环节 1：用 Bing 搜索「<实体> 官网」，挑出像官网的结果。
  const searchUrl = `https://www.bing.com/images/search?q=${encodeURIComponent(`${query} 官网`)}&form=HDRSC2`;
  const textSearchUrl = `https://www.bing.com/search?q=${encodeURIComponent(`${query} 官网`)}`;
  let candidates = [];
  try {
    const result = await httpGet(textSearchUrl, { headers: { accept: 'text/html,application/xhtml+xml' } });
    const html = new TextDecoder('utf-8').decode(result.bytes);
    for (const match of html.matchAll(/<h2><a href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>/g)) {
      candidates.push({ url: match[1], title: match[2].replace(/<[^>]*>/g, '') });
    }
    console.log(`  Bing 网页搜索命中 ${String(candidates.length)} 条结果（textSearchUrl 有效=${String(result.status === 200)}）`);
  } catch (error) {
    console.log(`  Bing 网页搜索失败：${error.message}`);
  }
  void searchUrl;

  const judged = candidates.map((entry) => ({ ...entry, ...looksOfficial(entry.url, entry.title) }));
  const official = judged.filter((entry) => entry.official);
  console.log(`  判定为官网的：${String(official.length)} 条`);
  for (const entry of judged.slice(0, 8)) {
    console.log(`    ${entry.official ? '★官网' : '  第三方'} ${entry.url.slice(0, 70)}  [${entry.reason}]  ${entry.title.slice(0, 30)}`);
  }
  if (official.length === 0) {
    console.log('  → 没有认出官网，后续步骤跳过');
    return;
  }

  // 环节 2：抓官网 HTML，抽图片地址。
  for (const entry of official.slice(0, 2)) {
    console.log(`\n  --- 抓取 ${entry.url}`);
    let html;
    try {
      const result = await httpGet(entry.url, { headers: { accept: 'text/html,application/xhtml+xml' }, timeoutMs: 25000 });
      html = new TextDecoder('utf-8').decode(result.bytes);
      console.log(`      HTTP ${String(result.status)}，${String(html.length)} 字符`);
    } catch (error) {
      console.log(`      ERR ${error.message}`);
      continue;
    }
    const images = extractImageUrls(html, entry.url);
    console.log(`      抽出图片候选 ${String(images.length)} 个（按来源分类：${[...new Set(images.map((i) => i.where))].join(', ')}）`);

    // 环节 3：真的下载几张，量一下分辨率。
    const sample = images.slice(0, 8);
    let usable = 0;
    for (const item of sample) {
      try {
        const response = await fetch(item.url, {
          headers: { 'user-agent': BROWSER_UA, accept: 'image/*', referer: entry.url },
          signal: AbortSignal.timeout(15000),
        });
        const bytes = new Uint8Array(await response.arrayBuffer());
        const mediaType = sniffImageMediaType(bytes);
        const size = mediaType === undefined ? undefined : imageSize(bytes, mediaType);
        const dim = size === undefined ? '?' : `${String(size.width)}x${String(size.height)}`;
        const pixels = size === undefined ? 0 : size.width * size.height;
        if (pixels >= 921600) usable += 1;
        console.log(`      ${pixels >= 921600 ? '✅' : '  '} ${String(response.status)} ${String(bytes.length)}B ${dim} [${item.where}] ${item.url.slice(0, 62)}`);
      } catch (error) {
        console.log(`      ❌ ERR ${error.message} ${item.url.slice(0, 60)}`);
      }
      await sleep(150);
    }
    console.log(`      → 抽样 ${String(sample.length)} 张中，达到 720p 门槛的有 ${String(usable)} 张`);
  }
}

await probe('游戏（明日方舟：终末地）', '明日方舟 终末地');
await sleep(1500);
await probe('公司产品（DeepSeek）', 'DeepSeek');
