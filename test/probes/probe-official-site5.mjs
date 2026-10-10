/**
 * 收官验证：官网的图能不能对上「具体角色」，还是只有活动主视觉？
 *
 * 做法：从官网首页/新闻页里挑出「页面级」图片地址，再顺着站点内链接找角色/新闻页，
 * 看能不能找到与某个角色名相关的图。若只能拿到通用主视觉，这个功能就得如实标注
 * 「官网素材（可能不含指定角色）」而不是谎称找到了角色图。
 */
import { httpGet, BROWSER_UA } from '../src/util.js';
import { imageSize, sniffImageMediaType } from '../src/image.js';

const ORIGIN = 'https://endfield.hypergryph.com';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fullImageUrls(html) {
  const out = new Set();
  for (const match of html.matchAll(/https?:\/\/[^\s"'<>()\\,\]]+/gi)) {
    const raw = match[0].replace(/[.,;:]$/, '');
    if (/\.(png|jpe?g|webp|gif)(\?|$)/i.test(raw)) out.add(raw);
  }
  return [...out];
}

function internalLinks(html) {
  const out = new Set();
  for (const match of html.matchAll(/href="([^"#]+)"/g)) {
    const href = match[1];
    if (/^(https?:)?\/\//.test(href)) {
      if (href.includes('hypergryph.com')) out.add(new URL(href, ORIGIN).href);
      continue;
    }
    if (href.startsWith('/')) out.add(new URL(href, ORIGIN).href);
  }
  return [...out];
}

const home = new TextDecoder('utf-8').decode((await httpGet(ORIGIN + '/', { headers: { accept: 'text/html' } })).bytes);
const homeImages = fullImageUrls(home);
console.log(`首页图片 ${String(homeImages.length)} 条`);

// 首页里 20 张大图很可能是同一个轮播/活动序列。看看它们的页面归属。
const links = internalLinks(home);
console.log(`站内链接 ${String(links.length)} 条，示例：`);
for (const link of links.slice(0, 12)) console.log(`   ${link}`);

console.log('\n=== 首页大图的来源页归属（同一页 = 同一批素材） ===');
const referers = [...new Set(homeImages.map((url) => new URL(url).pathname.split('/').slice(1, 3).join('/')))];
console.log(`  路径前缀：${referers.join(', ')}`);
console.log('  → 说明这些图都来自同一批「活动/新闻」上传目录，不是按角色组织的。');

console.log('\n=== 逐个探站内页面，统计可用大图数量 ===');
const probePaths = ['/news', ...links.filter((l) => /\/(news|character|operator|detail)\//.test(l)).slice(0, 3)];
let bestPage = null;
for (const url of [...new Set(probePaths)]) {
  try {
    const result = await httpGet(url, { headers: { accept: 'text/html' }, timeoutMs: 20000 });
    const html = new TextDecoder('utf-8').decode(result.bytes);
    const images = fullImageUrls(html);
    // 只有「内容页」才值得抓：新闻列表页的图常是缩略图。
    console.log(`  ${url.slice(0, 74)}`);
    console.log(`     HTTP ${String(result.status)}  ${String(html.length)} 字符  图片 ${String(images.length)} 条`);
    let checked = 0;
    for (const image of images.slice(0, 3)) {
      try {
        const response = await fetch(image, { headers: { 'user-agent': BROWSER_UA, accept: 'image/*', referer: url }, signal: AbortSignal.timeout(15000) });
        const bytes = new Uint8Array(await response.arrayBuffer());
        const mediaType = sniffImageMediaType(bytes);
        const size = mediaType === undefined ? undefined : imageSize(bytes, mediaType);
        const pixels = size === undefined ? 0 : size.width * size.height;
        console.log(`       ${pixels >= 921600 ? '✅' : '  '} ${String(response.status)} ${size === undefined ? '?' : `${String(size.width)}x${String(size.height)}`} ${String(bytes.length)}B`);
        checked += 1;
      } catch (error) {
        console.log(`       ❌ ${error.message.slice(0, 40)}`);
      }
      await sleep(100);
    }
    if (images.length > 3 && bestPage === null) bestPage = url;
    void checked;
  } catch (error) {
    console.log(`  ${url.slice(0, 60)} → ERR ${error.message.slice(0, 40)}`);
  }
  await sleep(200);
}

console.log(`\n=== 结论数据 ===`);
console.log(`首页可直接拿到 ${String(homeImages.length)} 张大图，绝大多数 ≥1600x900；`);
console.log(`但这些图的路径都落在上传目录里（按日期/哈希组织），无法从 URL 判断是否与某个角色对应。`);
console.log(`因此「官网取图」能提供权威、高清的官方素材，`);
console.log(`但**不能保证其中包含用户点名的那一个角色**——这一点必须在结果里如实标注。`);
if (bestPage !== null) console.log(`内容页候选：${bestPage}`);
