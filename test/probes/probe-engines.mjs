// Probe real response shapes of the Baidu / 360 / Bing image sources so the parsers match reality.
import { writeFileSync } from 'node:fs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const q = encodeURIComponent('可塑性记忆 动漫');

async function get(url, headers) {
  const res = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9', ...headers } });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, text: buf.toString('utf8'), buf };
}

console.log('=== baidu acjson ===');
{
  const { status, text } = await get(
    `https://image.baidu.com/search/acjson?tn=resultjson_com&ipn=rj&ct=201326592&fp=result&word=${q}&pn=0&rn=30&gsm=1e`,
    { referer: 'https://image.baidu.com/' },
  );
  console.log('status', status, 'len', text.length);
  const json = JSON.parse(text);
  console.log('top keys:', Object.keys(json).join(','));
  console.log('data len:', json.data?.length);
  const sample = (json.data ?? []).filter((d) => d && Object.keys(d).length > 0).slice(0, 2);
  console.log(JSON.stringify(sample, null, 1).slice(0, 2500));
}

console.log('\n=== 360 image so.com ===');
{
  const { status, text } = await get(
    `https://image.so.com/j?q=${q}&src=srp&correct=${q}&sn=0&pn=30`,
    { referer: 'https://image.so.com/' },
  );
  console.log('status', status, 'len', text.length);
  const json = JSON.parse(text);
  console.log('top keys:', Object.keys(json).join(','));
  console.log('list len:', json.list?.length, 'total', json.total);
  console.log(JSON.stringify((json.list ?? []).slice(0, 3), null, 1).slice(0, 2200));
}

console.log('\n=== bing iusc sample (first + a few keys) ===');
{
  const { text } = await get(`https://www.bing.com/images/search?q=${q}&form=HDRSC2&first=1&qft=+filterui:imagesize-large`, {
    accept: 'text/html,application/xhtml+xml',
  });
  const matches = [...text.matchAll(/class="iusc"[^>]*?m="([^"]+)"/g)].map((m) => m[1]);
  console.log('iusc count (with imagesize-large):', matches.length);
  const parsed = matches.map((s) => JSON.parse(s.replace(/&quot;/g, '"').replace(/&amp;/g, '&'))).filter(Boolean);
  console.log(JSON.stringify(parsed.slice(0, 2), null, 1).slice(0, 1500));
  writeFileSync('.work/bing-sample.html', text);
}
