/**
 * 修正版探测：biligame 对「批量取图」有 WAF 限制（gimlimit=50 → HTTP 567 拦截页）。
 * 这里改成小 limit、带重试与退避，并确认稳定可用的参数上限。
 */
import { BROWSER_UA } from '../src/util.js';
import { imageSize, sniffImageMediaType } from '../src/image.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RASTER = /\.(png|jpe?g|gif|webp)$/i;

/** 安全取 JSON：非 JSON（WAF 拦截页）时返回 undefined 而不是抛错。 */
async function apiJson(url) {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': BROWSER_UA, accept: 'application/json', 'accept-language': 'zh-CN,zh;q=0.9' },
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    if (!text.startsWith('{') && !text.startsWith('[')) {
      return { __notJson: true, status: res.status };
    }
    return { status: res.status, json: JSON.parse(text) };
  } catch (error) {
    return { __error: error.message };
  }
}

console.log('=== biligame：不同 gimlimit 的可用性（找安全上限） ===');
const BILI = 'https://wiki.biligame.com/zzz/api.php';
for (const limit of [10, 20, 30, 50]) {
  const url = `${BILI}?action=query&generator=images&titles=${encodeURIComponent('千夏')}`
    + `&gimlimit=${String(limit)}&prop=imageinfo&iiprop=url|size&format=json`;
  const res = await apiJson(url);
  if (res.__notJson) {
    console.log(`  gimlimit=${String(limit).padStart(2)}  ✗ 被 WAF 拦截（HTTP ${String(res.status)}，返回 HTML）`);
  } else if (res.__error) {
    console.log(`  gimlimit=${String(limit).padStart(2)}  ERR ${res.__error.slice(0, 40)}`);
  } else {
    const pages = res.json?.query?.pages ?? {};
    const images = Object.values(pages).filter((p) => RASTER.test(p.imageinfo?.[0]?.url ?? ''));
    const big = images.filter((p) => (p.imageinfo[0].width ?? 0) * (p.imageinfo[0].height ?? 0) >= 921600);
    console.log(`  gimlimit=${String(limit).padStart(2)}  ✓ HTTP ${String(res.status)}  返回 ${String(images.length)} 张位图，其中 ≥720p ${String(big.length)} 张`);
    if (limit === 10) {
      for (const p of images.sort((a, b) => b.imageinfo[0].width * b.imageinfo[0].height - a.imageinfo[0].width * a.imageinfo[0].height).slice(0, 6)) {
        const ii = p.imageinfo[0];
        console.log(`        ${String(ii.width).padStart(5)}x${String(ii.height).padEnd(5)}  ${p.title.replace(/^File:/, '')}`);
      }
    }
  }
  await sleep(1200);
}

console.log('\n=== 现有图源里出现过的图床域名（用于定「水印站」黑名单） ===');
{
  const { runEngine } = await import('../src/providers.js');
  const hosts = new Map();
  for (const [engine, query] of [['baidu', '动漫 壁纸'], ['baidu', '风景 图片'], ['so360', '动漫 立绘'], ['bing', 'anime wallpaper']]) {
    const result = await runEngine(engine, query, { timeoutMs: 20000 });
    for (const candidate of result.candidates) {
      try {
        const host = new URL(candidate.imageUrl).hostname.toLowerCase();
        hosts.set(host, (hosts.get(host) ?? 0) + 1);
      } catch { /* 忽略 */ }
    }
    await sleep(500);
  }
  const sorted = [...hosts.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`  共 ${String(sorted.length)} 个图床。出现最多的 12 个：`);
  for (const [host, count] of sorted.slice(0, 12)) {
    const known = /58pic|699pic|ibaotu|51miz|tukuppt|zhituwang|veer|gettyimages|shutterstock|dreamstime|123rf|depositphotos|zcool|huitu|tupian/.test(host) ? '   ← 图库/水印站' : '';
    console.log(`    ${String(count).padStart(3)} 次  ${host}${known}`);
  }
}
