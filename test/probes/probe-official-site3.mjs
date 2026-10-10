/**
 * 官网取图的关键一问：404 是因为「我的 URL 正则截断了查询串」，还是因为「官网图本来就取不到」？
 *
 * 做法：直接用官方站点 HTML 里出现的**完整**地址（含查询串）去下载，逐个看真实结果。
 * 如果补全后能下到大图，说明这条路只是实现细节问题；如果仍然取不到，就得换入口
 * （官网的新闻页 / 媒体资源页 / 静态资源目录）。
 */
import { httpGet, BROWSER_UA } from '../src/util.js';
import { imageSize, sniffImageMediaType } from '../src/image.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SITES = [
  { label: '国服官网', url: 'https://endfield.hypergryph.com/' },
  { label: '国际站', url: 'https://endfield.gryphline.com/' },
];

for (const site of SITES) {
  console.log(`\n${'='.repeat(70)}\n${site.label} ${site.url}\n${'='.repeat(70)}`);
  let html;
  try {
    const result = await httpGet(site.url, { headers: { accept: 'text/html,application/xhtml+xml' }, timeoutMs: 25000 });
    html = new TextDecoder('utf-8').decode(result.bytes);
    console.log(`HTML ${String(html.length)} 字符`);
  } catch (error) {
    console.log(`ERR ${error.message}`);
    continue;
  }

  // 1) HTML 里出现的**完整**图片地址（允许查询串，不截断）。
  console.log('\n--- 1. 完整图片地址（含查询串） ---');
  const full = [...new Set([
    ...(html.matchAll(/https?:\/\/[^\s"'<>()\\]+?\.(?:png|jpe?g|webp|gif)(?:\?[^\s"'<>()\\]*)?/gi) ?? []),
  ].map((m) => m[0]))];
  console.log(`找到 ${String(full.length)} 条`);
  for (const url of full.slice(0, 12)) console.log(`    ${url.slice(0, 150)}`);

  // 2) 关键：Next.js 图片优化端点（/_next/image?url=...）。它正是官网的大图入口。
  console.log('\n--- 2. Next.js 图片优化端点 ---');
  const nextImages = [...new Set([
    ...(html.matchAll(/["'`](\/_next\/image\?url=[^"'`\\]+)["'`]/g) ?? []),
    ...(html.matchAll(/["'`](https?:\/\/[^"'`]+?\/_next\/image\?url=[^"'`\\]+)["'`]/g) ?? []),
  ].map((m) => m[1]))];
  console.log(`找到 ${String(nextImages.length)} 条`);
  for (const url of nextImages.slice(0, 6)) {
    try {
      const absolute = url.startsWith('http') ? url : new URL(url, site.url).href;
      const response = await fetch(absolute, { headers: { 'user-agent': BROWSER_UA, accept: 'image/*', referer: site.url }, signal: AbortSignal.timeout(15000) });
      const bytes = new Uint8Array(await response.arrayBuffer());
      const mediaType = sniffImageMediaType(bytes);
      const size = mediaType === undefined ? undefined : imageSize(bytes, mediaType);
      console.log(`    ${String(response.status)} ${String(bytes.length)}B ${size === undefined ? '?' : `${String(size.width)}x${String(size.height)}`} <- ${url.slice(0, 90)}`);
    } catch (error) {
      console.log(`    ERR ${error.message.slice(0, 60)} <- ${url.slice(0, 80)}`);
    }
    await sleep(120);
  }

  // 3) 静态资源清单：Next.js 的 buildManifest / 页面数据里常列出全部媒体文件。
  console.log('\n--- 3. 页面数据里的媒体文件（_next/data 或 buildManifest） ---');
  const buildId = /"buildId":"([^"]+)"/.exec(html)?.[1];
  console.log(`buildId=${String(buildId)}`);
  const mediaPaths = [...new Set((html.match(/\/_next\/static\/media\/[^"'`\s\\]+/g) ?? []))];
  console.log(`/_next/static/media/ 下的引用 ${String(mediaPaths.length)} 条，前 8 条：`);
  for (const path of mediaPaths.slice(0, 8)) console.log(`    ${path}`);
  for (const path of mediaPaths.slice(0, 4)) {
    try {
      const response = await fetch(new URL(path, site.url).href, { headers: { 'user-agent': BROWSER_UA, accept: 'image/*' }, signal: AbortSignal.timeout(15000) });
      const bytes = new Uint8Array(await response.arrayBuffer());
      const mediaType = sniffImageMediaType(bytes);
      const size = mediaType === undefined ? undefined : imageSize(bytes, mediaType);
      console.log(`    → ${String(response.status)} ${String(bytes.length)}B ${size === undefined ? '?' : `${String(size.width)}x${String(size.height)}`} ${path.slice(0, 80)}`);
    } catch (error) {
      console.log(`    → ERR ${error.message.slice(0, 50)}`);
    }
    await sleep(120);
  }

  // 4) 与角色相关的大图入口：官网新闻列表页（公告里通常带高清立绘）。
  console.log('\n--- 4. 新闻/公告页是否带高清图 ---');
  const newsUrl = new URL(site.url + 'news', site.url).href;
  try {
    const result = await httpGet(newsUrl, { headers: { accept: 'text/html,application/xhtml+xml' }, timeoutMs: 25000 });
    const newsHtml = new TextDecoder('utf-8').decode(result.bytes);
    const newsImages = [...new Set((newsHtml.match(/https?:\/\/[^\s"'<>()\\]+?\.(?:png|jpe?g|webp)(?:\?[^\s"'<>()\\]*)?/gi) ?? []).map((m) => m[0]))];
    console.log(`    ${newsUrl} → HTTP ${String(result.status)}，${String(newsHtml.length)} 字符，图片地址 ${String(newsImages.length)} 条`);
    for (const url of newsImages.slice(0, 5)) {
      try {
        const response = await fetch(url, { headers: { 'user-agent': BROWSER_UA, accept: 'image/*', referer: newsUrl }, signal: AbortSignal.timeout(15000) });
        const bytes = new Uint8Array(await response.arrayBuffer());
        const mediaType = sniffImageMediaType(bytes);
        const size = mediaType === undefined ? undefined : imageSize(bytes, mediaType);
        console.log(`      ${String(response.status)} ${String(bytes.length)}B ${size === undefined ? '?' : `${String(size.width)}x${String(size.height)}`} ${url.slice(0, 90)}`);
      } catch (error) {
        console.log(`      ERR ${error.message.slice(0, 50)}`);
      }
      await sleep(120);
    }
  } catch (error) {
    console.log(`    ERR ${error.message}`);
  }
}
