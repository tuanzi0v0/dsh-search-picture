// Baidu middleURL 变体与 Bing 尺寸过滤的效果对比：找出能稳定拿到高清原图的取法。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const q = encodeURIComponent('可塑性记忆 艾拉');

const { sniffImageMediaType, imageSize } = await import('../src/image.js');

async function size(url, referer) {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, referer, accept: 'image/avif,image/webp,image/*,*/*;q=0.8' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return `HTTP ${res.status}`;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const type = sniffImageMediaType(bytes);
    const dim = type === undefined ? undefined : imageSize(bytes, type);
    return `${dim === undefined ? '?' : `${dim.width}x${dim.height}`} ${type ?? 'unknown'} ${bytes.length}B`;
  } catch (e) {
    return `ERR ${e.message}`;
  }
}

console.log('=== 百度：同一张图的 middleURL 变体 ===');
{
  const res = await fetch(`https://image.baidu.com/search/acjson?tn=resultjson_com&ipn=rj&ct=201326592&fp=result&word=${q}&pn=0&rn=30&gsm=1e`, {
    headers: { 'user-agent': UA, referer: 'https://image.baidu.com/' },
  });
  const json = JSON.parse(Buffer.from(await res.arrayBuffer()).toString('utf8'));
  const rows = json.data.filter((r) => r && r.thumbURL).slice(0, 3);
  for (const [i, row] of rows.entries()) {
    console.log(`\n-- 第 ${i + 1} 条 ${row.width}x${row.height} ${row.type} objURL=${row.objURL ? row.objURL.slice(0, 40) : '(空)'}`);
    const variants = {
      middleURL: row.middleURL,
      'middleURL 去 w/h': row.middleURL.replace(/[?&]w=\d+/g, '').replace(/[?&]h=\d+/g, ''),
      'thumbURL 去 w/h': row.thumbURL.replace(/[?&]w=\d+/g, '').replace(/[?&]h=\d+/g, ''),
      'objURL 原样': row.objURL,
      replaceUrl: row.replaceUrl?.[0]?.ObjURL,
    };
    for (const [label, url] of Object.entries(variants)) {
      if (!url) { console.log(`   ${label.padEnd(18)} (无)`); continue; }
      console.log(`   ${label.padEnd(18)} ${await size(url, 'https://image.baidu.com/')}  <- ${url.slice(0, 100)}`);
    }
  }
}

console.log('\n=== Bing：不同 imagesize 过滤的候选数与首图 ===');
for (const qft of ['', '+filterui:imagesize-large', '+filterui:imagesize-wallpaper', '+filterui:imagesize-2mp']) {
  const url = `https://www.bing.com/images/search?q=${q}&form=HDRSC2&first=1&qft=${qft}`;
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' } });
  const html = Buffer.from(await res.arrayBuffer()).toString('utf8');
  const items = [...html.matchAll(/class="iusc"[^>]*?m="([^"]+)"/g)]
    .map((m) => { try { return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')); } catch { return null; } })
    .filter(Boolean);
  console.log(`\nqft="${qft}" 候选 ${items.length}`);
  for (const item of items.slice(0, 3)) {
    console.log(`   ${await size(item.murl, 'https://www.bing.com/')}  <- ${item.murl.slice(0, 90)}`);
  }
}
