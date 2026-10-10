/**
 * 那个知乎问题页到底有多少张千夏的图？—— 直接实测，不再靠搜索引擎喂。
 *
 * 已知（`.work/probe-zhihu2.mjs`）：zhihu.com 的页面与 API 在不同请求头下曾返回 403/401。
 * 但同批实测里 `pic*.zhimg.com` 图床是通的。这轮要弄清两件事：
 *   1. 问题页 / 答案页现在还能不能抓到 HTML；能抓到就能直接抽出页面里的全部图片地址；
 *   2. 若页面封死，能否用常见入口（答案 API、移动端页面）拿到图片列表。
 *
 * 用户的质疑是对的：搜索引擎索引的只是页面里的一部分图，直接抓页面才可能拿全。
 */
import { httpGet, BROWSER_UA } from '../src/util.js';
import { imageSize, sniffImageMediaType } from '../src/image.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 抽出页面里的 zhimg 图片地址（含处理参数）。 */
function zhimgUrls(html) {
  const out = new Set();
  for (const match of html.matchAll(/https?:\/\/[a-z0-9.-]*zhimg\.com\/[^\s"'\\<>()]+/gi)) {
    const raw = match[0].replace(/[.,;:]+$/, '');
    if (/\.(jpg|jpeg|png|webp|gif)/i.test(raw)) out.add(raw);
  }
  return [...out];
}

const QUESTION = '2019307241644270389';
const ANSWER = '2019307763935749094';

const TARGETS = [
  ['问题页（PC）', `https://www.zhihu.com/question/${QUESTION}`, 'text/html,application/xhtml+xml'],
  ['问题页（移动 UA）', `https://www.zhihu.com/question/${QUESTION}`, 'text/html,application/xhtml+xml', 'mobile'],
  ['答案页', `https://www.zhihu.com/question/${QUESTION}/answer/${ANSWER}`, 'text/html,application/xhtml+xml'],
  ['答案 API（v4）', `https://www.zhihu.com/api/v4/answers/${ANSWER}?include=content`, 'application/json, text/plain, */*'],
  ['答案 API（含 relations）', `https://www.zhihu.com/api/v4/answers/${ANSWER}?include=content%2Cvoteup_count%2Ccomment_count`, 'application/json, text/plain, */*'],
  ['问题 API（含答案）', `https://www.zhihu.com/api/v4/questions/${QUESTION}/answers?include=content&limit=20&offset=0`, 'application/json, text/plain, */*'],
  ['问题 API（不带 include）', `https://www.zhihu.com/api/v4/questions/${QUESTION}`, 'application/json, text/plain, */*'],
];

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const found = new Map();

for (const [label, url, accept, mode] of TARGETS) {
  const headers = {
    accept,
    ...(mode === 'mobile' ? { 'user-agent': MOBILE_UA } : {}),
  };
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': BROWSER_UA,
        'accept-language': 'zh-CN,zh;q=0.9',
        referer: `https://www.zhihu.com/question/${QUESTION}`,
        ...headers,
      },
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    const images = zhimgUrls(text);
    let note = `${String(text.length)}B`;
    if (accept.includes('json')) {
      try {
        const j = JSON.parse(text);
        note = `json data=${Array.isArray(j.data) ? `array(${String(j.data.length)})` : typeof j.data}${j.error ? ` err=${String(j.error.code)} ${String(j.error.message).slice(0, 20)}` : ''}`;
      } catch {
        note = `非 JSON「${text.slice(0, 50).replace(/\s+/g, ' ')}」`;
      }
    }
    console.log(`  ${label.padEnd(22)} HTTP ${String(res.status).padEnd(4)} ${note}`);
    if (images.length > 0) {
      console.log(`      ↳ 页面内 zhimg 图片 ${String(images.length)} 个`);
      for (const img of images) if (!found.has(img)) found.set(img, label);
    }
  } catch (error) {
    console.log(`  ${label.padEnd(22)} ERR ${error.message} ${error.cause?.code ?? ''}`);
  }
  await sleep(500);
}

console.log(`\n=== 汇总：共发现 ${String(found.size)} 个不同的 zhimg 图片地址（来自 ${String(new Set(found.values()).size)} 个入口） ===`);
for (const [url, from] of found) console.log(`  [${from}] ${url.slice(0, 110)}`);

if (found.size === 0) {
  console.log('\n所有入口都没拿到图片地址 → 需要换别的办法（见结论）。');
} else {
  console.log('\n=== 验证这些地址能否作为图片下载 ===');
  let ok = 0;
  let big = 0;
  for (const url of [...found.keys()].slice(0, 20)) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': BROWSER_UA, accept: 'image/*', referer: `https://www.zhihu.com/question/${QUESTION}` },
        signal: AbortSignal.timeout(20000),
      });
      const bytes = new Uint8Array(await res.arrayBuffer());
      const mediaType = sniffImageMediaType(bytes);
      const size = mediaType === undefined ? undefined : imageSize(bytes, mediaType);
      const pixels = size === undefined ? 0 : size.width * size.height;
      if (res.status === 200 && mediaType !== undefined) ok += 1;
      if (pixels >= 921600) big += 1;
      console.log(`  ${pixels >= 921600 ? '✅' : mediaType === undefined ? '❌' : '⚠️'} HTTP ${String(res.status)} ${size === undefined ? '?' : `${String(size.width)}x${String(size.height)}`}  ${url.slice(-46)}`);
    } catch (error) {
      console.log(`  ❌ ERR ${error.message.slice(0, 40)}`);
    }
    await sleep(200);
  }
  console.log(`  → ${String(ok)} 张可下载，其中 ≥720p 的 ${String(big)} 张`);
}
