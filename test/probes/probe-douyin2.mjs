/**
 * 抖音的两个关键问题：
 *   A. 现有图源（Bing/百度/360）里已经出现 douyinpic.com 的图（26 条 / 12 条）——
 *      这些 URL **能不能真的下载**？抖音图床带 x-expires 签名，过期就 403。
 *   B. 抖音站内搜索接口返回 `{"status_code":0,"data":[]}`——是「没有签名」还是「真的没内容」？
 *      对比一下带/不带常见反爬头，以及图文类搜索频道。
 */
import { sniffImageMediaType, imageSize } from '../src/image.js';
import { runEngine } from '../src/providers.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

console.log('=== A. 现有图源里的抖音图能不能下载 ===');
{
  const found = [];
  for (const engine of ['bing', 'baidu', 'so360']) {
    const result = await runEngine(engine, '抖音 终末地', { timeoutMs: 20000 });
    for (const candidate of result.candidates) {
      if (/douyinpic\.com|douyinstatic\.com/i.test(candidate.imageUrl)) found.push({ engine, url: candidate.imageUrl });
    }
    await sleep(400);
  }
  console.log(`  收集到 ${String(found.length)} 条抖音域名候选`);
  let ok = 0;
  let big = 0;
  for (const item of found.slice(0, 8)) {
    const hasSign = /x-expires|x-signature|signature=|\?a=/i.test(item.url);
    try {
      const res = await fetch(item.url, { headers: { 'user-agent': UA, accept: 'image/*', referer: 'https://www.douyin.com/' }, signal: AbortSignal.timeout(15000) });
      const bytes = new Uint8Array(await res.arrayBuffer());
      const mediaType = sniffImageMediaType(bytes);
      const size = mediaType === undefined ? undefined : imageSize(bytes, mediaType);
      const pixels = size === undefined ? 0 : size.width * size.height;
      if (res.status === 200) ok += 1;
      if (pixels >= 921600) big += 1;
      console.log(`  ${pixels >= 921600 ? '✅' : res.status === 200 ? '⚠️' : '❌'} HTTP ${String(res.status)} ${String(bytes.length)}B ${size === undefined ? '未识别' : `${String(size.width)}x${String(size.height)}`} [${item.engine}] 带签名=${String(hasSign)}`);
      console.log(`      ${item.url.slice(0, 130)}`);
    } catch (error) {
      console.log(`  ❌ ERR ${error.message.slice(0, 40)} [${item.engine}]`);
    }
    await sleep(300);
  }
  console.log(`  → 抽样中 HTTP 200 的 ${String(ok)} 条，达 720p 的 ${String(big)} 条`);

  console.log('\n  参考：其他关键词里的抖音图（看是否普遍）');
  const other = await runEngine('bing', '抖音 壁纸 4k', { timeoutMs: 20000 });
  const douyinInOther = other.candidates.filter((c) => /douyinpic\.com|douyinstatic\.com/i.test(c.imageUrl));
  console.log(`  "抖音 壁纸 4k"：候选 ${String(other.candidates.length)} 条，抖音域名 ${String(douyinInOther.length)} 条`);
}

console.log('\n=== B. 抖音站内搜索接口：为什么 data 是空的 ===');
{
  const variants = [
    ['裸请求', {}],
    ['带 referer+origin', { referer: 'https://www.douyin.com/', origin: 'https://www.douyin.com' }],
    ['带 cookie（伪造 ttwid）', { referer: 'https://www.douyin.com/', cookie: 'ttwid=1%7Ctest' }],
    ['加 msToken/verifyFp 参数', { referer: 'https://www.douyin.com/' }],
  ];
  for (const [label, headers] of variants) {
    const extra = label.startsWith('加 msToken') ? '&msToken=test&verifyFp=verify_test&fp=verify_test' : '';
    const url = `https://www.douyin.com/aweme/v1/web/general/search/single/?keyword=${encodeURIComponent('终末地')}&search_channel=aweme_general&count=10&offset=0&device_platform=webapp&aid=6383${extra}`;
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, accept: 'application/json, text/plain, */*', 'accept-language': 'zh-CN,zh;q=0.9', ...headers },
        signal: AbortSignal.timeout(20000),
      });
      const text = await res.text();
      let note = text.slice(0, 110).replace(/\s+/g, ' ');
      try {
        const json = JSON.parse(text);
        note = `status_code=${String(json.status_code)} data=${Array.isArray(json.data) ? `array(${String(json.data.length)})` : typeof json.data}${json.status_msg === undefined ? '' : ` msg=${json.status_msg}`}`;
      } catch {
        /* 保留原文 */
      }
      console.log(`  ${label.padEnd(24)} HTTP ${String(res.status)} → ${note}`);
    } catch (error) {
      console.log(`  ${label.padEnd(24)} ERR ${error.message} ${error.cause?.code ?? ''}`);
    }
    await sleep(700);
  }

  console.log('\n  再试「图文」频道（抖音图集主要落在这里）');
  for (const channel of ['aweme_general', 'aweme_image', 'aweme_pic']) {
    const url = `https://www.douyin.com/aweme/v1/web/general/search/single/?keyword=${encodeURIComponent('终末地')}&search_channel=${channel}&count=10&offset=0&device_platform=webapp&aid=6383`;
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, accept: 'application/json', referer: 'https://www.douyin.com/' },
        signal: AbortSignal.timeout(20000),
      });
      const json = JSON.parse(await res.text());
      console.log(`    search_channel=${channel.padEnd(14)} status_code=${String(json.status_code)} data=${Array.isArray(json.data) ? json.data.length : typeof json.data}`);
    } catch (error) {
      console.log(`    search_channel=${channel.padEnd(14)} ERR ${error.message.slice(0, 40)}`);
    }
    await sleep(700);
  }
}
