/**
 * 决定性验证：官网 HTML 里那些完整图片地址，到底能不能下到大图？
 *
 * 上一轮的 404 是我自己的正则 bug（把地址截断成 `h`），不是官网的问题。
 * 这一轮只用从 HTML 里原样取出的完整地址，逐个下载并量分辨率。
 */
import { httpGet, BROWSER_UA } from '../src/util.js';
import { imageSize, sniffImageMediaType } from '../src/image.js';

const SITES = [
  { label: '国服官网', url: 'https://endfield.hypergryph.com/' },
  { label: '国际站', url: 'https://endfield.gryphline.com/' },
];

/** 用「找 https:// 起点、遇到分隔符停」的方式取完整地址，不做任何截断。 */
function fullImageUrls(html) {
  const out = new Set();
  const re = /https?:\/\/[^\s"'<>()\\,\]]+/gi;
  for (const match of html.matchAll(re)) {
    const raw = match[0].replace(/[.,;:]$/, '');
    if (/\.(png|jpe?g|webp|gif)(\?|$)/i.test(raw)) out.add(raw);
  }
  return [...out];
}

for (const site of SITES) {
  console.log(`\n${'='.repeat(72)}\n${site.label} ${site.url}\n${'='.repeat(72)}`);
  const result = await httpGet(site.url, { headers: { accept: 'text/html,application/xhtml+xml' }, timeoutMs: 25000 });
  const html = new TextDecoder('utf-8').decode(result.bytes);
  const urls = fullImageUrls(html);
  console.log(`完整图片地址 ${String(urls.length)} 条`);

  let big = 0;
  let ok = 0;
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': BROWSER_UA, accept: 'image/*', referer: site.url },
        signal: AbortSignal.timeout(20000),
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      const mediaType = sniffImageMediaType(bytes);
      const size = mediaType === undefined ? undefined : imageSize(bytes, mediaType);
      const pixels = size === undefined ? 0 : size.width * size.height;
      if (response.status === 200) ok += 1;
      if (pixels >= 921600) big += 1;
      console.log(`  ${pixels >= 921600 ? '✅' : response.status === 200 ? '  ' : '❌'} ${String(response.status)} ${String(bytes.length)}B ${size === undefined ? '?' : `${String(size.width)}x${String(size.height)}`}  ${url.split('/').slice(-2).join('/')}`);
    } catch (error) {
      console.log(`  ❌ ERR ${error.message.slice(0, 40)}  ${url.slice(-50)}`);
    }
  }
  console.log(`  → 共 ${String(urls.length)} 条：HTTP 200 的 ${String(ok)} 条，达到 720p 的 ${String(big)} 条`);
}

console.log(`\n${'='.repeat(72)}\n补充：官网是否存在「媒体资源 / 壁纸」入口\n${'='.repeat(72)}`);
for (const path of ['download', 'media', 'wallpaper', 'gallery', 'news', 'character']) {
  const url = `https://endfield.hypergryph.com/${path}`;
  try {
    const result = await httpGet(url, { headers: { accept: 'text/html,application/xhtml+xml' }, timeoutMs: 20000 });
    const html = new TextDecoder('utf-8').decode(result.bytes);
    const images = fullImageUrls(html);
    console.log(`  /${path.padEnd(10)} HTTP ${String(result.status)}  ${String(html.length).padStart(7)} 字符  图片地址 ${String(images.length)} 条`);
  } catch (error) {
    console.log(`  /${path.padEnd(10)} ERR ${error.message.slice(0, 40)}`);
  }
}
