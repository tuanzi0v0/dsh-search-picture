/**
 * 抖音图床能不能要更大的尺寸？
 *
 * 现象：站外图源里的抖音图都是 960x540 / 720x540 这种「视频预览图」尺寸，
 * 7/8 能下载但**没有一张 ≥720p**。URL 里带 `~tplv-...:q75.webp` 这类图片处理模板，
 * 所以要验证两件事：
 *   1. 去掉/替换模板后缀能不能拿到原图；
 *   2. 带签名的 URL 是不是尺寸被签名锁死（换参数即 403）。
 */
import { sniffImageMediaType, imageSize } from '../src/image.js';
import { runEngine } from '../src/providers.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function probe(label, url) {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'image/*', referer: 'https://www.douyin.com/' },
      signal: AbortSignal.timeout(15000),
    });
    const bytes = new Uint8Array(await res.arrayBuffer());
    const mediaType = sniffImageMediaType(bytes);
    const size = mediaType === undefined ? undefined : imageSize(bytes, mediaType);
    const pixels = size === undefined ? 0 : size.width * size.height;
    console.log(`    ${pixels >= 921600 ? '✅' : res.status === 200 ? '  ' : '❌'} ${label.padEnd(26)} HTTP ${String(res.status)} ${String(bytes.length)}B ${size === undefined ? '未识别' : `${String(size.width)}x${String(size.height)}`}`);
    return pixels;
  } catch (error) {
    console.log(`    ❌ ${label.padEnd(26)} ERR ${error.message.slice(0, 40)}`);
    return 0;
  }
}

// 收集一批抖音域名候选，分成「带处理模板」和「带签名」两类。
const found = [];
for (const engine of ['bing', 'baidu', 'so360']) {
  const result = await runEngine(engine, '抖音 图文', { timeoutMs: 20000 });
  for (const candidate of result.candidates) {
    if (/douyinpic\.com|douyinstatic\.com/i.test(candidate.imageUrl)) found.push(candidate.imageUrl);
  }
  await sleep(400);
}
console.log(`抖音域名候选 ${String(found.length)} 条`);

const templated = found.filter((url) => /~tplv-/.test(url));
const signed = found.filter((url) => /x-expires=/.test(url));
console.log(`  带处理模板（~tplv-）的 ${String(templated.length)} 条；带签名的 ${String(signed.length)} 条`);

console.log('\n=== 1. 去掉 ~tplv 模板后缀（尝试拿原图） ===');
for (const url of templated.slice(0, 2)) {
  console.log(`  原始：${url.slice(0, 110)}`);
  await probe('原样', url);
  await probe('去掉 ~tplv 段', url.replace(/~tplv-[^/]*$/, ''));
  await probe('换成无水印模板', url.replace(/~tplv-[^/]*$/, '~tplv-dy-aweme-images:q75.avif'));
  await probe('去掉 .webp 后缀', url.replace(/\.webp$/, ''));
  await sleep(300);
}

console.log('\n=== 2. 带签名的 URL 改尺寸参数会不会被拒 ===');
for (const url of signed.slice(0, 2)) {
  console.log(`  原始：${url.slice(0, 110)}`);
  await probe('原样', url);
  // 签名锁死了路径与参数，改任何一个都会失配；这里只验证「加了额外参数是否仍可下」。
  await probe('追加 &w=1920', `${url}&w=1920`);
  await probe('追加 ?x-oss-process', url.includes('?') ? `${url}&x-oss-process=image/resize,w_1920` : `${url}?x-oss-process=image/resize,w_1920`);
  await sleep(300);
}

console.log('\n=== 3. 统计：站外图源里抖音图的尺寸分布 ===');
{
  const sizes = [];
  for (const url of found.slice(0, 12)) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'image/*', referer: 'https://www.douyin.com/' }, signal: AbortSignal.timeout(12000) });
      const bytes = new Uint8Array(await res.arrayBuffer());
      const mediaType = sniffImageMediaType(bytes);
      const size = mediaType === undefined ? undefined : imageSize(bytes, mediaType);
      if (size !== undefined && res.status === 200) sizes.push(size.width * size.height);
    } catch {
      /* 忽略单张失败 */
    }
    await sleep(200);
  }
  if (sizes.length === 0) {
    console.log('  没有可统计的样本');
  } else {
    const sorted = sizes.sort((a, b) => b - a);
    console.log(`  可下载样本 ${String(sizes.length)} 张，最大 ${String(sorted[0])} 像素（${String(Math.round(Math.sqrt(sorted[0] * 16 / 9)))}x${String(Math.round(Math.sqrt(sorted[0] * 9 / 16)))} 量级）`);
    console.log(`  达到 720p(921600) 的：${String(sizes.filter((p) => p >= 921600).length)} 张`);
  }
}
