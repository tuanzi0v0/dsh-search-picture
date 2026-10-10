/**
 * 第二步探测：弄清「怎么拿到官网域名」以及「官网 HTML 里到底有没有可用的大图」。
 *
 * 上一轮 Bing 网页搜索返回 200 但正则没命中，先看清它的真实结构；
 * 同时直接测两个已确认的官网域名，验证图片抽取与下载这一环。
 */
import { decodeEntities, httpGet, normalizeUrl, BROWSER_UA } from '../src/util.js';
import { imageSize, sniffImageMediaType } from '../src/image.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchText(url, accept = 'text/html,application/xhtml+xml') {
  const result = await httpGet(url, { headers: { accept }, timeoutMs: 25000 });
  return { status: result.status, html: new TextDecoder('utf-8').decode(result.bytes) };
}

console.log('=== A. Bing 网页搜索结果页的真实结构 ===');
{
  const { status, html } = await fetchText('https://www.bing.com/search?q=%E6%98%8E%E6%97%A5%E6%96%B9%E8%88%9F%E7%BB%88%E6%9C%AB%E5%9C%B0%20%E5%AE%98%E7%BD%91');
  console.log(`  HTTP ${String(status)}，${String(html.length)} 字符`);
  const anchorCount = (html.match(/<a /g) ?? []).length;
  console.log(`  <a> 标签数：${String(anchorCount)}`);
  // 打印所有指向站外的 http(s) 链接的片段，看真实标签长什么样。
  const external = [...html.matchAll(/<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]{0,80}?)<\/a>/g)]
    .filter((m) => !/bing\.com|microsoft|msn\.com|go\.microsoft/.test(m[1]));
  console.log(`  站外链接 ${String(external.length)} 条，前 6 条：`);
  for (const match of external.slice(0, 6)) {
    console.log(`    url=${match[1].slice(0, 72)}`);
    console.log(`      text=${match[2].replace(/<[^>]*>/g, '').trim().slice(0, 50)}`);
  }
  if (external.length === 0) {
    console.log('  ⚠ 页面上没有站外链接——可能是反爬页面，检查开头 300 字符：');
    console.log(`    ${html.slice(0, 300).replace(/\s+/g, ' ')}`);
  }
}

console.log('\n=== B. 百度网页搜索能不能给出官网 ===');
{
  try {
    const { status, html } = await fetchText('https://www.baidu.com/s?wd=' + encodeURIComponent('明日方舟终末地 官网'), 'text/html,application/xhtml+xml');
    console.log(`  HTTP ${String(status)}，${String(html.length)} 字符`);
    const titles = [...html.matchAll(/<h3[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
    console.log(`  结果条数：${String(titles.length)}`);
    for (const match of titles.slice(0, 6)) {
      console.log(`    ${match[2].replace(/<[^>]*>/g, '').trim().slice(0, 44)}  <- ${match[1].slice(0, 60)}`);
    }
    if (titles.length === 0) console.log(`    开头：${html.slice(0, 200).replace(/\s+/g, ' ')}`);
  } catch (error) {
    console.log(`  ERR ${error.message}`);
  }
}

/** 抽图片地址（与上一轮同一套规则）。 */
function extractImageUrls(html, baseUrl) {
  const found = new Map();
  const add = (raw, where) => {
    const url = normalizeUrl(typeof raw === 'string' ? decodeEntities(raw) : undefined, baseUrl);
    if (url === undefined) return;
    if (/\.(js|css|svg|ico|woff2?|ttf)(\?|$)/i.test(url)) return;
    if (!found.has(url)) found.set(url, where);
  };
  for (const match of html.matchAll(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*content=["']([^"']+)["']/gi)) add(match[1], 'og:image');
  for (const match of html.matchAll(/<img[^>]+>/gi)) {
    for (const attribute of ['src', 'data-src', 'data-original', 'data-lazy-src']) {
      const value = new RegExp(`${attribute}=["']([^"']+)["']`, 'i').exec(match[0]);
      if (value) add(value[1], `img@${attribute}`);
    }
    const srcset = /srcset=["']([^"']+)["']/i.exec(match[0]);
    if (srcset) for (const part of srcset[1].split(',')) add(part.trim().split(/\s+/)[0], 'img@srcset');
  }
  for (const match of html.matchAll(/url\((['"]?)([^'")]+\.(?:png|jpe?g|webp|gif)[^'")]*)\1\)/gi)) add(match[2], 'css url()');
  for (const match of html.matchAll(/["']((?:https?:)?\/\/[^"']+\.(?:png|jpe?g|webp|gif)[^"']*)["']/gi)) add(match[1], 'inline');
  return [...found.entries()].map(([url, where]) => ({ url, where }));
}

/** 抓一个站点并统计可用大图。 */
async function crawl(label, url) {
  console.log(`\n=== ${label}：${url} ===`);
  let html;
  try {
    const result = await fetchText(url);
    html = result.html;
    console.log(`  HTTP ${String(result.status)}，${String(html.length)} 字符`);
  } catch (error) {
    console.log(`  ERR ${error.message}`);
    return;
  }
  const images = extractImageUrls(html, url);
  console.log(`  图片候选 ${String(images.length)} 个；来源：${[...new Set(images.map((i) => i.where))].join(', ')}`);
  let usable = 0;
  for (const item of images.slice(0, 10)) {
    try {
      const response = await fetch(item.url, {
        headers: { 'user-agent': BROWSER_UA, accept: 'image/*', referer: url },
        signal: AbortSignal.timeout(15000),
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      const mediaType = sniffImageMediaType(bytes);
      const size = mediaType === undefined ? undefined : imageSize(bytes, mediaType);
      const pixels = size === undefined ? 0 : size.width * size.height;
      if (pixels >= 921600) usable += 1;
      console.log(`    ${pixels >= 921600 ? '✅' : '  '} ${String(response.status)} ${String(bytes.length)}B ${size === undefined ? '?' : `${String(size.width)}x${String(size.height)}`} [${item.where}] ${item.url.slice(0, 66)}`);
    } catch (error) {
      console.log(`    ❌ ${error.message.slice(0, 50)} ${item.url.slice(0, 60)}`);
    }
    await sleep(120);
  }
  console.log(`  → 抽样 ${String(Math.min(10, images.length))} 张，达 720p 的 ${String(usable)} 张`);
}

// 这两个域名是「已知官网」，用来单独验证「官网取图」这一环是否可行。
await crawl('DeepSeek 官网', 'https://www.deepseek.com/');
await crawl('明日方舟终末地 官网（候选域名）', 'https://endfield.hypergryph.com/');
await crawl('明日方舟终末地 国际站（候选域名）', 'https://endfield.gryphline.com/');
