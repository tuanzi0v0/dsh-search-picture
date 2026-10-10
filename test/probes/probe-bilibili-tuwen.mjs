/**
 * Bilibili 图文 / 相册入口能不能用？
 *
 * 上一轮探测在限流（-412）下草率下过结论，这次按入口逐个验，并且：
 *   - 每个请求之间固定退避，避免把限流当成「接口不存在」；
 *   - 打印 code/message 与数据形状，而不是只打印条数；
 *   - 同时试「JSON 接口」和「页面 HTML 内嵌数据」两条路（后者常能绕开接口限流）。
 *
 * 目标入口：
 *   1. 专栏 article：search/type=article、x/web-interface/article/list
 *   2. 空间相册：x/space/album/index（B 站「相册」就是图文图片集）
 *   3. 用户动态：x/polymer/web-dynamic/v1/feed/space（图文动态，一条常带多张图）
 *   4. 页面 HTML：search.bilibili.com 的图文/专栏搜索结果页内嵌数据
 */
import { sniffImageMediaType, imageSize } from '../src/image.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 每个请求之间至少间隔这么久，避免触发 -412。 */
const GAP_MS = 3000;
let lastCall = 0;

async function call(label, url, headers = {}, kind = 'json') {
  const wait = GAP_MS - (Date.now() - lastCall);
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': UA,
        accept: kind === 'html' ? 'text/html,application/xhtml+xml' : 'application/json, text/plain, */*',
        'accept-language': 'zh-CN,zh;q=0.9',
        referer: headers.referer ?? 'https://www.bilibili.com/',
        ...headers,
      },
      signal: AbortSignal.timeout(25000),
    });
    const text = await res.text();
    if (kind === 'html') {
      console.log(`  ${label}: HTTP ${String(res.status)} ${String(text.length)}B html`);
      return text;
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      console.log(`  ${label}: HTTP ${String(res.status)} 非 JSON (${text.slice(0, 100)})`);
      return undefined;
    }
    const dataShape = json.data === undefined ? 'undefined' : Array.isArray(json.data) ? `array(${String(json.data.length)})` : `object{${Object.keys(json.data).slice(0, 8).join(',')}}`;
    console.log(`  ${label}: HTTP ${String(res.status)} code=${String(json.code)} msg=${String(json.message ?? '-')} data=${dataShape}`);
    return json;
  } catch (error) {
    console.log(`  ${label}: ERR ${error.message} ${error.cause?.code ?? ''}`);
    return undefined;
  }
}

async function downloadCheck(label, url) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'image/*', referer: 'https://www.bilibili.com/' }, signal: AbortSignal.timeout(15000) });
    const bytes = new Uint8Array(await res.arrayBuffer());
    const type = sniffImageMediaType(bytes);
    const size = type === undefined ? undefined : imageSize(bytes, type);
    console.log(`    ${label}: ${String(res.status)} ${String(bytes.length)}B ${type ?? '未识别'} ${size === undefined ? '' : `${String(size.width)}x${String(size.height)}`}`);
  } catch (error) {
    console.log(`    ${label}: ERR ${error.message}`);
  }
}

console.log('=== 1. 专栏 / 图文 JSON 接口 ===');
await call('search/type=article', `https://api.bilibili.com/x/web-interface/search/type?search_type=article&keyword=${encodeURIComponent('终末地')}&page=1`);
await call('article/list（推荐位）', 'https://api.bilibili.com/x/web-interface/article/list?pn=1&ps=10&sort=0');

console.log('\n=== 2. 空间相册（图文图片集） ===');
// 先拿一个真实 mid：用 view 接口反查 UP 主（该接口不触发搜索限流）。
const view = await call('view 反查 mid', 'https://api.bilibili.com/x/web-interface/view?bvid=BV1fKpP6PEpq');
const mid = view?.data?.owner?.mid;
console.log(`  mid=${String(mid)}`);
if (mid !== undefined) {
  await call('space/album/index', `https://api.bilibili.com/x/space/album/index?mid=${String(mid)}&page=1&pagesize=12`);
  await call('space/album/index（旧域名）', `https://api.vc.bilibili.com/link_draw/v1/doc/doc_list?uid=${String(mid)}&page_num=0&page_size=12&biz=all`);
}

console.log('\n=== 3. 用户动态（图文动态，一条可带多图） ===');
if (mid !== undefined) {
  await call('dynamic feed/space', `https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?offset=&host_mid=${String(mid)}&timezone_offset=-480&features=itemOpusStyle`);
}
await call('dynamic feed/index', 'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/index?type=all&page=1');

console.log('\n=== 4. 页面 HTML 内嵌数据（绕开接口限流） ===');
{
  const html = await call('search 专栏页 HTML', `https://search.bilibili.com/article?keyword=${encodeURIComponent('终末地')}`, {}, 'html');
  if (typeof html === 'string') {
    const initialState = html.includes('__INITIAL_STATE__');
    const picCount = (html.match(/hdslb\.com/g) ?? []).length;
    console.log(`    含 __INITIAL_STATE__ = ${String(initialState)}; HTML 里出现 hdslb.com 次数 = ${String(picCount)}`);
    const urls = [...new Set((html.match(/https?:\/\/[a-z0-9.-]*hdslb\.com\/[^"'\s\\]+/g) ?? []))].slice(0, 6);
    for (const url of urls) console.log(`    候选: ${url.slice(0, 110)}`);
    if (urls.length > 0) await downloadCheck('下载第一个候选', urls[0]);
  }
}

console.log('\n=== 5. 图文动态页 HTML ===');
{
  const html = await call('动态页 HTML', `https://space.bilibili.com/${String(mid ?? 2)}/dynamic`, {}, 'html');
  if (typeof html === 'string') {
    const urls = [...new Set((html.match(/https?:\/\/[a-z0-9.-]*hdslb\.com\/[^"'\s\\]+/g) ?? []))].slice(0, 5);
    console.log(`    HTML 里 hdslb.com 图片候选 ${String(urls.length)} 个`);
    for (const url of urls) console.log(`    候选: ${url.slice(0, 110)}`);
  }
}
