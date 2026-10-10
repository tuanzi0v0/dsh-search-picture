/**
 * Pixiv 可行性实测。它与前面几个图源不同，有三道已知门槛，必须逐个验证：
 *   1. 网络可达性（这里不是所有境外站都通）；
 *   2. 未登录能否搜索（现在的 Pixiv AJAX 接口大多要登录）；
 *   3. `i.pximg.net` 的防盗链——图片必须带 `Referer: https://www.pixiv.net/` 才给。
 */
import { sniffImageMediaType, imageSize } from '../src/image.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function probe(label, url, headers = {}, parse = 'json') {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: parse === 'json' ? 'application/json' : 'text/html,application/xhtml+xml', 'accept-language': 'zh-CN,zh;q=0.9', ...headers },
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    const body = parse === 'json' ? (() => { try { return JSON.parse(text); } catch { return undefined; } })() : undefined;
    const shape = body === undefined
      ? `${text.length} chars "${text.slice(0, 80).replace(/\s+/g, ' ')}"`
      : `json keys=${Object.keys(body).slice(0, 8).join(',')}`;
    console.log(`  ${label.padEnd(30)} HTTP ${String(res.status).padEnd(4)} ${String(Date.now() - started).padStart(6)}ms  ${shape}`);
    return { status: res.status, text, body };
  } catch (error) {
    console.log(`  ${label.padEnd(30)} ERR ${String(Date.now() - started).padStart(6)}ms  ${error.message} ${error.cause?.code ?? ''}`);
    return undefined;
  }
}

const keyword = encodeURIComponent('アークナイツ エンドフィールド');

console.log('=== 1. 网络可达性与接口形态 ===');
await probe('pixiv.net 首页', 'https://www.pixiv.net/', {}, 'html');
await sleep(400);
// 旧的公开搜索接口（历史上未登录可用）
await probe('touch ajax search', `https://www.pixiv.net/touch/ajax/search/illusts?keyword=${keyword}&type=all&lang=zh`, {}, 'json');
await sleep(400);
// 现在的站内搜索接口（据称需要登录）
await probe('ajax/search/illustrations', `https://www.pixiv.net/ajax/search/illustrations/${keyword}?word=${keyword}&order=date_d&mode=all&p=1&s_mode=s_tag&lang=zh`, { referer: 'https://www.pixiv.net/' }, 'json');
await sleep(400);
// 排行榜接口（历史上未登录可用，且是「按热度」的高质量入口）
await probe('rank illust (daily)', 'https://www.pixiv.net/ranking.php?mode=daily&content=illust&format=json&p=1', { referer: 'https://www.pixiv.net/' }, 'json');
await sleep(400);
// 公开的「插画详情」接口
await probe('ajax/illust 详情', 'https://www.pixiv.net/ajax/illust/100000000?lang=zh', { referer: 'https://www.pixiv.net/' }, 'json');

console.log('\n=== 2. 图片防盗链（i.pximg.net） ===');
// 用一张长期存在的公开作品图（Pixiv 官方说明里有引用过该 CDN）。
const sampleImages = [
  'https://i.pximg.net/c/540x540_70/img-master/img/2015/01/01/00/00/00/48197800_p0_master1200.jpg',
  'https://i.pximg.net/img-master/img/2015/01/01/00/00/00/48197800_p0_master1200.jpg',
];
for (const url of sampleImages) {
  console.log(`  ${url.slice(0, 70)}`);
  for (const [mode, headers] of [['裸请求', {}], ['带 Referer', { referer: 'https://www.pixiv.net/' }]]) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'image/*', ...headers }, signal: AbortSignal.timeout(20000) });
      const bytes = new Uint8Array(await res.arrayBuffer());
      const mediaType = sniffImageMediaType(bytes);
      const size = mediaType === undefined ? undefined : imageSize(bytes, mediaType);
      console.log(`    [${mode}] HTTP ${String(res.status)} ${String(bytes.length)}B ${mediaType ?? '未识别'} ${size === undefined ? '' : `${String(size.width)}x${String(size.height)}`}`);
    } catch (error) {
      console.log(`    [${mode}] ERR ${error.message} ${error.cause?.code ?? ''}`);
    }
    await sleep(300);
  }
}

console.log('\n=== 3. 是否有免登录的「按标签」入口 ===');
// Pixiv 的标签页在未登录时可能仍返回首屏数据（内嵌 __NEXT_DATA__）。
const tag = await probe('tags 页面 HTML', `https://www.pixiv.net/tags/${keyword}/artworks`, { referer: 'https://www.pixiv.net/' }, 'html');
if (tag?.text) {
  const hasNextData = tag.text.includes('__NEXT_DATA__');
  const pximgCount = (tag.text.match(/i\.pximg\.net/g) ?? []).length;
  console.log(`    含 __NEXT_DATA__=${String(hasNextData)}  HTML 里 i.pximg.net 出现 ${String(pximgCount)} 次`);
  const urls = [...new Set((tag.text.match(/https:\/\/i\.pximg\.net\/[^"'\\\s]+/g) ?? []))].slice(0, 4);
  for (const url of urls) console.log(`    候选：${url.slice(0, 110)}`);
}

console.log('\n=== 4. 结论所需的关键信息 ===');
console.log('  （见上文各行的 HTTP 状态与耗时；403/超时/需要登录会直接体现在这里）');
