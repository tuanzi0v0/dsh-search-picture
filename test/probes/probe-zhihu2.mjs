/**
 * 知乎 403 能不能绕？以及 search_v3 的 400 是不是参数问题？
 *
 * 已知：zhimg.com 图床无防盗链（可下载），但 zhihu.com 的页面与 API 分别返回
 * 403（反爬墙）和 401（要登录）。逐一试常见的绕法，判定「直连知乎」到底可不可行。
 */
import { BROWSER_UA } from '../src/util.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const keyword = encodeURIComponent('绝区零 千夏');

async function probe(label, url, headers = {}) {
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': BROWSER_UA,
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'zh-CN,zh;q=0.9',
        ...headers,
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(18000),
    });
    const text = await res.text();
    const hasZhimg = /zhimg\.com/.test(text);
    const jsonHint = (() => {
      try {
        const j = JSON.parse(text);
        return `json data=${Array.isArray(j.data) ? `array(${String(j.data.length)})` : typeof j.data}${j.error ? ` err=${j.error.code}` : ''}`;
      } catch {
        return `${String(text.length)}B${hasZhimg ? ' 含zhimg' : ''}`;
      }
    })();
    console.log(`  ${label.padEnd(34)} HTTP ${String(res.status).padEnd(4)} ${jsonHint}`);
    return { status: res.status, text };
  } catch (error) {
    console.log(`  ${label.padEnd(34)} ERR ${error.message.slice(0, 50)}`);
    return undefined;
  }
}

console.log('=== A. 问题页 403 的绕法 ===');
const Q = 'https://www.zhihu.com/question/2019307241644270389';
await probe('裸请求（已试，403）', Q);
await sleep(400);
await probe('常见移动 UA', Q, { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
await sleep(400);
await probe('带 Cookie（伪造 _xsrf）', Q, { cookie: '_xsrf=test; d_c0=test' });
await sleep(400);
await probe('带 X-Requested-With', Q, { 'x-requested-with': 'XMLHttpRequest' });
await sleep(400);
await probe('百度快照式 UA（Baiduspider）', Q, { 'user-agent': 'Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)' });
await sleep(400);
await probe('Googlebot UA', Q, { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' });
await sleep(400);

console.log('\n=== B. search_v3 的 400 是不是缺参数 ===');
const variants = [
  ['原样', `https://www.zhihu.com/api/v4/search_v3?t=general&q=${keyword}&correction=1&offset=0&limit=20`],
  ['加 lc_idx', `https://www.zhihu.com/api/v4/search_v3?t=general&q=${keyword}&correction=1&offset=0&limit=20&lc_idx=0&show_all_topics=0`],
  ['只留 q', `https://www.zhihu.com/api/v4/search_v3?q=${keyword}`],
  ['type=content', `https://www.zhihu.com/api/v4/search_v3?t=content&q=${keyword}&offset=0&limit=20`],
];
for (const [label, url] of variants) {
  await probe(label, url, { accept: 'application/json, text/plain, */*', referer: 'https://www.zhihu.com/search' });
  await sleep(500);
}

console.log('\n=== C. 其他可能免登录的知乎入口 ===');
await probe('专栏/文章 API', 'https://www.zhihu.com/api/v4/articles/123456789', { accept: 'application/json' });
await sleep(400);
await probe('答案 API', 'https://www.zhihu.com/api/v4/answers/123456789', { accept: 'application/json' });
await sleep(400);
await probe('收藏夹 API', 'https://www.zhihu.com/api/v4/collections/12345678/items?offset=0&limit=20', { accept: 'application/json' });
await sleep(400);
await probe('图片搜索（可能无此接口）', `https://www.zhihu.com/api/v4/search_v3?t=image&q=${keyword}`, { accept: 'application/json' });

console.log('\n=== D. 结论所需：zhimg 图床仍然可用吗 ===');
{
  const url = 'https://pic1.zhimg.com/v2-21036586e8e1482459f88855cacdfc7a_r.jpg?source=1def8aca';
  for (const [label, headers] of [['无 referer', {}], ['带 referer', { referer: 'https://www.zhihu.com/' }]]) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': BROWSER_UA, accept: 'image/*', ...headers }, signal: AbortSignal.timeout(15000) });
      const bytes = new Uint8Array(await res.arrayBuffer());
      console.log(`  ${label.padEnd(34)} HTTP ${String(res.status)} ${String(bytes.length)}B`);
    } catch (error) {
      console.log(`  ${label.padEnd(34)} ERR ${error.message.slice(0, 40)}`);
    }
    await sleep(300);
  }
}
