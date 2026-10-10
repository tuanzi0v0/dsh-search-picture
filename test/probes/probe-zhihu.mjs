/**
 * 知乎直连可行性实测。
 *
 * 现在的「知乎图」其实是搭百度的便车（百度索引了 zhimg.com 的图），不是直接检索知乎。
 * 用户要求「优先去知乎找」，所以要验证知乎自身有哪些入口在**匿名**状态下能拿到图片地址。
 *
 * 要试的入口（由易到难）：
 *   1. 搜索结果页 HTML 里是否直接嵌了 `pic*.zhimg.com` 图片地址；
 *   2. 问题页 HTML（用户实际贴图的页面，百度那两张就来自这里）；
 *   3. 官方 API（`api/v4/search_v3`）是否要求登录；
 *   4. 热榜（`api/v3/feed/topstory/hot-lists/total`）——不需要关键词，作为兜底图源。
 */
import { httpGet, BROWSER_UA } from '../src/util.js';
import { imageSize, sniffImageMediaType } from '../src/image.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 从 HTML 里抽出 zhimg 图片地址（含处理参数后缀）。 */
function zhimgUrls(html) {
  const out = new Set();
  for (const match of html.matchAll(/https?:\/\/[a-z0-9.-]*zhimg\.com\/[^\s"'\\<>()]+/gi)) {
    const raw = match[0].replace(/[.,;:]+$/, '');
    if (/\.(jpg|jpeg|png|webp|gif)/i.test(raw)) out.add(raw);
  }
  return [...out];
}

async function probe(label, url, accept = 'text/html,application/xhtml+xml') {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': BROWSER_UA,
        accept,
        'accept-language': 'zh-CN,zh;q=0.9',
        referer: 'https://www.zhihu.com/',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    const images = zhimgUrls(text);
    let note = `${String(text.length)}B`;
    if (accept.includes('json')) {
      try {
        const json = JSON.parse(text);
        note = `json keys=${Object.keys(json).slice(0, 6).join(',')}`;
        if (json.error) note += ` error=${JSON.stringify(json.error).slice(0, 80)}`;
      } catch {
        note = `非 JSON「${text.slice(0, 60).replace(/\s+/g, ' ')}」`;
      }
    }
    console.log(`  ${label.padEnd(30)} HTTP ${String(res.status).padEnd(4)} ${String(Date.now() - started).padStart(6)}ms  ${note}`);
    if (images.length > 0) console.log(`      ↳ HTML 里 zhimg 图片 ${String(images.length)} 个，例：${images[0].slice(0, 96)}`);
    return { status: res.status, text, images };
  } catch (error) {
    console.log(`  ${label.padEnd(30)} ERR ${String(Date.now() - started).padStart(6)}ms  ${error.message} ${error.cause?.code ?? ''}`);
    return undefined;
  }
}

const keyword = encodeURIComponent('绝区零 千夏');

console.log('=== 1. 搜索页 / 问题页 HTML ===');
await probe('搜索页 HTML', `https://www.zhihu.com/search?type=content&q=${keyword}`);
await sleep(600);
// 那两张千夏图的来源问题页
await probe('千夏来源问题页', 'https://www.zhihu.com/question/2019307241644270389');
await sleep(600);

console.log('\n=== 2. 官方 API ===');
await probe('search_v3', `https://www.zhihu.com/api/v4/search_v3?t=general&q=${keyword}&correction=1&offset=0&limit=20`, 'application/json, text/plain, */*');
await sleep(600);
await probe('search_v3 (无 referer)', `https://www.zhihu.com/api/v4/search_v3?t=general&q=${keyword}&offset=0&limit=20`, 'application/json, text/plain, */*');
await sleep(600);
await probe('热榜 total', 'https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=20', 'application/json, text/plain, */*');
await sleep(600);
await probe('推荐 feed', 'https://www.zhihu.com/api/v3/feed/topstory/recommend?limit=10', 'application/json, text/plain, */*');

console.log('\n=== 3. 对「来源问题页」里抽到的图做下载验证 ===');
{
  const page = await httpGet('https://www.zhihu.com/question/2019307241644270389', {
    headers: { accept: 'text/html,application/xhtml+xml' },
    timeoutMs: 25000,
  });
  const html = new TextDecoder('utf-8').decode(page.bytes);
  const urls = zhimgUrls(html);
  console.log(`  页面里共 ${String(urls.length)} 个 zhimg 图片地址`);
  let ok = 0;
  let big = 0;
  for (const url of urls.slice(0, 8)) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': BROWSER_UA, accept: 'image/*', referer: 'https://www.zhihu.com/' },
        signal: AbortSignal.timeout(15000),
      });
      const bytes = new Uint8Array(await res.arrayBuffer());
      const mediaType = sniffImageMediaType(bytes);
      const size = mediaType === undefined ? undefined : imageSize(bytes, mediaType);
      const pixels = size === undefined ? 0 : size.width * size.height;
      if (res.status === 200) ok += 1;
      if (pixels >= 921600) big += 1;
      console.log(`    ${pixels >= 921600 ? '✅' : res.status === 200 ? '  ' : '❌'} ${String(res.status)} ${String(bytes.length)}B ${size === undefined ? '?' : `${String(size.width)}x${String(size.height)}`}  ${url.slice(-40)}`);
    } catch (error) {
      console.log(`    ❌ ERR ${error.message.slice(0, 40)}`);
    }
    await sleep(250);
  }
  console.log(`  → 抽样 ${String(Math.min(8, urls.length))} 张：HTTP 200 的 ${String(ok)} 张，≥720p 的 ${String(big)} 张`);
}
