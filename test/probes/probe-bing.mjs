// Isolate the Bing leg: check the search HTML and the iusc JSON extraction.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const q = encodeURIComponent('可塑性记忆 动漫');

for (const url of [
  `https://www.bing.com/images/search?q=${q}&form=HDRSC2&first=1&qft=+filterui:imagesize-large`,
  `https://www.bing.com/images/search?q=${q}&form=HDRSC2&first=1`,
  `https://cn.bing.com/images/search?q=${q}&form=HDRSC2&first=1`,
]) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml', 'accept-language': 'zh-CN,zh;q=0.9' } });
    const text = Buffer.from(await res.arrayBuffer()).toString('utf8');
    const matches = [...text.matchAll(/class="iusc"[^>]*?m="([^"]+)"/g)].map((m) => m[1]);
    const alt = [...text.matchAll(/m="(\{[^"]*?murl[^"]*?\})"/g)].map((m) => m[1]);
    console.log(url.slice(0, 78), '->', res.status, 'len', text.length, 'iusc', matches.length, 'alt', alt.length);
    if (matches.length > 0) {
      const item = JSON.parse(matches[0].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
      console.log('  sample:', JSON.stringify(item).slice(0, 300));
    }
  } catch (e) {
    console.log(url.slice(0, 78), '-> ERR', e.message, e.cause?.code);
  }
}
