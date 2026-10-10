/**
 * 补两点：
 *   1. biligame 词条里的**实际图片尺寸**（前面只验证了能下载，没统计 ≥720p 的数量）；
 *   2. 「不下载自动添加水印的图片」在匿名、无视觉模型的前提下，能靠什么判据实现。
 *      —— 探测已知「水印站」的图床域名特征，为过滤规则提供依据。
 */
import { BROWSER_UA } from '../src/util.js';
import { imageSize, sniffImageMediaType } from '../src/image.js';
import { runEngine } from '../src/providers.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RASTER = /\.(png|jpe?g|gif|webp)$/i;

async function apiJson(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': BROWSER_UA, accept: 'application/json', 'accept-language': 'zh-CN,zh;q=0.9' },
    signal: AbortSignal.timeout(20000),
  });
  return res.json();
}

console.log('=== 1. biligame zzz：千夏页面的图片尺寸分布 ===');
{
  const BILI = 'https://wiki.biligame.com/zzz/api.php';
  const url = `${BILI}?action=query&generator=images&titles=${encodeURIComponent('千夏')}`
    + '&gimlimit=50&prop=imageinfo&iiprop=url|size&format=json';
  const json = await apiJson(url);
  const pages = json?.query?.pages ?? {};
  const images = [];
  for (const page of Object.values(pages)) {
    const ii = page.imageinfo?.[0];
    if (ii?.url === undefined || !RASTER.test(ii.url)) continue;
    images.push({ title: page.title, url: ii.url, width: ii.width, height: ii.height });
  }
  const big = images.filter((i) => (i.width ?? 0) * (i.height ?? 0) >= 921600);
  console.log(`  位图 ${String(images.length)} 张，≥720p 的 ${String(big.length)} 张`);
  for (const item of images.sort((a, b) => b.width * b.height - a.width * a.height).slice(0, 8)) {
    console.log(`      ${String(item.width).padStart(5)}x${String(item.height).padEnd(5)}  ${item.title.replace(/^File:/, '')}`);
  }
  // 下载最大的那张验证
  const top = images[0];
  if (top !== undefined) {
    const res = await fetch(top.url, { headers: { 'user-agent': BROWSER_UA, accept: 'image/*' }, signal: AbortSignal.timeout(20000) });
    const bytes = new Uint8Array(await res.arrayBuffer());
    const mediaType = sniffImageMediaType(bytes);
    const size = mediaType === undefined ? undefined : imageSize(bytes, mediaType);
    console.log(`  → 下载验证：HTTP ${String(res.status)} ${size === undefined ? '?' : `${String(size.width)}x${String(size.height)}`} ${String(Math.round(bytes.length / 1024))}KB`);
  }
}

console.log('\n=== 2. 「水印站」判据：看看现有图源里出现过哪些图床 ===');
{
  // 跑几个关键词，统计候选的图床域名分布 —— 用来确定黑名单该包含哪些域名。
  const hosts = new Map();
  for (const [engine, query] of [['baidu', '动漫 壁纸'], ['baidu', '风景 图片 下载'], ['so360', '动漫 立绘'], ['bing', 'anime wallpaper']]) {
    const result = await runEngine(engine, query, { timeoutMs: 20000 });
    for (const candidate of result.candidates) {
      try {
        const host = new URL(candidate.imageUrl).hostname.toLowerCase();
        hosts.set(host, (hosts.get(host) ?? 0) + 1);
      } catch { /* 忽略 */ }
    }
    await sleep(400);
  }
  const sorted = [...hosts.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`  共 ${String(sorted.length)} 个不同图床，出现最多的 15 个：`);
  for (const [host, count] of sorted.slice(0, 15)) {
    const known = /58pic|699pic|ibaotu|51miz|tukuppt|zhituwang|veer|gettyimages|shutterstock|dreamstime|123rf|depositphotos|zcool/.test(host) ? '  ← 已知水印/图库站' : '';
    console.log(`    ${String(count).padStart(3)} 次  ${host}${known}`);
  }
}

console.log('\n=== 3. 文件名含「水印」字样的候选多不多 ===');
{
  // 有些图源直接在 URL/文件名里带 watermark 标记，可以据此过滤。
  let hit = 0;
  let total = 0;
  for (const query of ['动漫 壁纸', '女仆 图片']) {
    const result = await runEngine('baidu', query, { timeoutMs: 20000 });
    for (const candidate of result.candidates) {
      total += 1;
      if (/watermark|shuiyin|水印/i.test(candidate.imageUrl) || /watermark|水印/i.test(String(candidate.title))) hit += 1;
    }
    await sleep(400);
  }
  console.log(`  候选 ${String(total)} 条，URL/标题里带水印标记的 ${String(hit)} 条`);
}
