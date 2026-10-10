// Follow-up probe: full error details for blocked hosts + real Bing image result parse + image download.
import { writeFileSync } from 'node:fs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function tryFetch(label, url, opts = {}) {
  try {
    const res = await fetch(url, { redirect: 'follow', ...opts });
    const buf = new Uint8Array(await res.arrayBuffer());
    console.log(`${label}: ${res.status} ${res.headers.get('content-type')} ${buf.byteLength}B`);
    return { res, buf };
  } catch (e) {
    const cause = e && e.cause;
    console.log(`${label}: ERROR ${e && e.message} | cause=${cause && cause.code} ${cause && cause.message}`);
    return null;
  }
}

console.log('--- blocked host error detail ---');
await tryFetch('wikipedia', 'https://en.wikipedia.org/wiki/Plastic_Memories');
await tryFetch('github-api', 'https://api.github.com/zen');
await tryFetch('duckduckgo', 'https://duckduckgo.com/');
await tryFetch('google', 'https://www.google.com/');

console.log('--- proxy env ---');
for (const k of Object.keys(process.env)) {
  if (/proxy|PROXY/.test(k)) console.log(k, '=', process.env[k]);
}

console.log('--- bing image search parse ---');
const q = encodeURIComponent('可塑性记忆 动漫 图片');
const bing = await tryFetch('bing', `https://www.bing.com/images/search?q=${q}&form=HDRSC2&first=1`, {
  headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
});
if (bing) {
  const html = Buffer.from(bing.buf).toString('utf8');
  const mAttrs = [...html.matchAll(/class="iusc"[^>]*?m="([^"]+)"/g)].map((m) => m[1]);
  console.log('iusc matches:', mAttrs.length);
  const unescaped = mAttrs.map((s) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
  const parsed = [];
  for (const s of unescaped) {
    try { parsed.push(JSON.parse(s)); } catch {}
  }
  console.log('parsed json:', parsed.length);
  console.log('sample keys:', parsed[0] && Object.keys(parsed[0]).join(','));
  console.log('sample:', JSON.stringify(parsed.slice(0, 3), null, 1).slice(0, 1200));
  // try downloading the first few originals
  for (const [i, item] of parsed.slice(0, 4).entries()) {
    const url = item.murl;
    const got = await tryFetch(`dl#${i} ${url && url.slice(0, 70)}`, url, {
      headers: { 'user-agent': UA, referer: 'https://www.bing.com/', accept: 'image/avif,image/webp,image/*,*/*;q=0.8' },
    });
    if (got) writeFileSync(`.work/dl-${i}.bin`, got.buf);
  }
}
