/**
 * 抖音可行性实测。它与前面几个源的关键差别：
 *   1. 图片直链带**签名参数**（`x-expires` / `x-signature` 之类），过期即 403；
 *   2. 搜索接口要 `a_bogus`/`X-Bogus`/`msToken` 等 JS 计算出来的签名，服务器直连基本被风控；
 *   3. 图文（图集）是抖音少见的「一条多图」内容，值得看能不能拿。
 *
 * 因此要分开验证：域名通不通、图床能不能下、搜索接口是否可用、搜索结果是否落在别的引擎里。
 */
import { lookup } from 'node:dns/promises';
import { connect } from 'node:net';
import { sniffImageMediaType, imageSize } from '../src/image.js';
import { httpGet, BROWSER_UA } from '../src/util.js';
import { runEngine } from '../src/providers.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const HOSTS = [
  'www.douyin.com', 'douyin.com', 'www.iesdouyin.com', 'p3-sign.douyinpic.com',
  'p9-sign.douyinpic.com', 'p26-sign.douyinpic.com', 'sf3-cdn-tos.douyinstatic.com',
];

function tcpProbe(host, port = 443, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = connect({ host, port });
    const done = (r) => {
      socket.destroy();
      resolve(`${r} ${String(Date.now() - started)}ms`);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done('TCP OK'));
    socket.once('timeout', () => done('TIMEOUT'));
    socket.once('error', (error) => done(error.code ?? 'ERR'));
  });
}

console.log('=== 1. DNS 与 TCP 可达性 ===');
for (const host of HOSTS) {
  let dns = '';
  try {
    const addresses = await lookup(host, { all: true });
    dns = addresses.map((a) => a.address).join(', ');
  } catch (error) {
    dns = `DNS ${error.code ?? error.message}`;
  }
  const tcp = dns.startsWith('DNS') ? '-' : await tcpProbe(host);
  console.log(`  ${host.padEnd(28)} ${dns.padEnd(34)} ${tcp}`);
}

console.log('\n=== 2. 抖音网页与公开接口 ===');
const ENDPOINTS = [
  ['首页', 'https://www.douyin.com/', 'html'],
  ['搜索页', 'https://www.douyin.com/search/%E7%BB%88%E6%9C%AB%E5%9C%B0', 'html'],
  ['素材接口（旧）', 'https://www.iesdouyin.com/web/api/v2/aweme/iteminfo/?item_ids=1', 'json'],
  ['搜索接口（需签名）', 'https://www.douyin.com/aweme/v1/web/general/search/single/?keyword=%E7%BB%88%E6%9C%AB%E5%9C%B0&search_channel=aweme_general&count=10', 'json'],
];
for (const [label, url, kind] of ENDPOINTS) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': BROWSER_UA, accept: kind === 'json' ? 'application/json' : 'text/html,application/xhtml+xml', 'accept-language': 'zh-CN,zh;q=0.9', referer: 'https://www.douyin.com/' },
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    console.log(`  ${label.padEnd(20)} HTTP ${String(res.status)} ${String(text.length)}B ${String(Date.now() - started)}ms`);
    console.log(`      ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
    if (kind === 'html') {
      const picCount = (htmlCount(text, 'douyinpic.com'));
      console.log(`      HTML 里 douyinpic.com 出现 ${String(picCount)} 次；含 verify/captcha=${String(/verify|captcha|滑动验证/i.test(text))}`);
    }
  } catch (error) {
    console.log(`  ${label.padEnd(20)} ERR ${error.message} ${error.cause?.code ?? ''} ${String(Date.now() - started)}ms`);
  }
  await sleep(600);
}

function htmlCount(text, needle) {
  return (text.match(new RegExp(needle.replace(/\./g, '\\.'), 'g')) ?? []).length;
}

console.log('\n=== 3. 抖音图床能否直接下载（找一个真实图片 URL） ===');
{
  // 从抖音首页 HTML 里找 douyinpic 链接，验证「图床是否可下」以及是否需签名。
  try {
    const res = await httpGet('https://www.douyin.com/', { headers: { accept: 'text/html,application/xhtml+xml' }, timeoutMs: 25000 });
    const html = new TextDecoder('utf-8').decode(res.bytes);
    const urls = [...new Set(html.match(/https?:\/\/[a-z0-9.-]*douyinpic\.com\/[^\s"'\\<>]+/gi) ?? [])].slice(0, 5);
    console.log(`  首页里找到 douyinpic 图片地址 ${String(urls.length)} 个`);
    for (const url of urls) {
      try {
        const imageRes = await fetch(url, { headers: { 'user-agent': BROWSER_UA, accept: 'image/*', referer: 'https://www.douyin.com/' }, signal: AbortSignal.timeout(15000) });
        const bytes = new Uint8Array(await imageRes.arrayBuffer());
        const mediaType = sniffImageMediaType(bytes);
        const size = mediaType === undefined ? undefined : imageSize(bytes, mediaType);
        console.log(`    HTTP ${String(imageRes.status)} ${String(bytes.length)}B ${mediaType ?? '未识别'} ${size === undefined ? '' : `${String(size.width)}x${String(size.height)}`}`);
        console.log(`      ${url.slice(0, 120)}`);
        console.log(`      含签名参数=${String(/x-expires|x-signature|a_bogus|signature=/i.test(url))}`);
      } catch (error) {
        console.log(`    ERR ${error.message.slice(0, 50)}  ${url.slice(0, 90)}`);
      }
      await sleep(300);
    }
    if (urls.length === 0) {
      console.log('  ⚠ 首页 HTML 里没有 douyinpic 地址（可能是纯前端渲染或被风控页替代）');
      console.log(`    页面片段：${html.slice(0, 200).replace(/\s+/g, ' ')}`);
    }
  } catch (error) {
    console.log(`  ERR ${error.message}`);
  }
}

console.log('\n=== 4. 抖音的图会不会已经出现在现有图源里 ===');
{
  // 抖音内容常被转载到站外；看看 Bing/百度/360 的关键词结果里有没有 douyinpic 域名。
  for (const query of ['抖音 终末地 图片', '抖音 图文 壁纸']) {
    let hit = 0;
    let total = 0;
    for (const engine of ['bing', 'baidu', 'so360']) {
      const result = await runEngine(engine, query, { timeoutMs: 20000 });
      total += result.candidates.length;
      for (const candidate of result.candidates) {
        if (/douyinpic\.com|douyinstatic\.com|douyin\.com/i.test(candidate.imageUrl)) hit += 1;
      }
      await sleep(400);
    }
    console.log(`  "${query}"：候选共 ${String(total)} 条，其中抖音域名的 ${String(hit)} 条`);
  }
}
