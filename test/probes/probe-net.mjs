// Probe outbound network reachability from a plain Node process for candidate image sources.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const targets = [
  ['bing-images', 'https://www.bing.com/images/search?q=%E5%8F%AF%E5%A1%91%E6%80%A7%E8%AE%B0%E5%BF%86&form=HDRSC2&first=1'],
  ['bing-thumb', 'https://tse1.mm.bing.net/th?id=OIP.abc&w=300'],
  ['ddg-html', 'https://html.duckduckgo.com/html/?q=plastic+memories'],
  ['ddg-api', 'https://duckduckgo.com/i.js?q=plastic+memories&o=json'],
  ['wikimedia-api', 'https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=plastic%20memories&gsrnamespace=6&prop=imageinfo&iiprop=url&format=json'],
  ['openverse', 'https://api.openverse.org/v1/images/?q=plastic+memories'],
  ['pexels-home', 'https://www.pexels.com/'],
  ['unsplash-source', 'https://source.unsplash.com/400x300/?nature'],
  ['baidu-image', 'https://image.baidu.com/search/acjson?tn=resultjson_com&word=test&pn=0&rn=5'],
  ['sogou-image', 'https://pic.sogou.com/napi/pc/searchList?query=test&start=0&len=5'],
  ['google-images', 'https://www.google.com/search?tbm=isch&q=test'],
  ['bing-home', 'https://www.bing.com/'],
  ['github', 'https://api.github.com/zen'],
];

for (const [name, url] of targets) {
  const started = Date.now();
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('timeout')), 15000);
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: '*/*' },
      redirect: 'follow',
      signal: ac.signal,
    });
    clearTimeout(timer);
    const buf = new Uint8Array(await res.arrayBuffer());
    const head = Buffer.from(buf.subarray(0, 160)).toString('utf8').replace(/\s+/g, ' ');
    console.log(`${name.padEnd(16)} ${res.status} ${res.headers.get('content-type')} ${buf.byteLength}B ${Date.now() - started}ms :: ${head}`);
  } catch (e) {
    console.log(`${name.padEnd(16)} ERROR ${Date.now() - started}ms :: ${e && e.message}`);
  }
}
