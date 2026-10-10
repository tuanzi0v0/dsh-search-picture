// Are the hdslb (bilibili) image hosts actually reachable? Measure per-host latency/outcome.
const { httpGetCapped } = await import('../src/util.js');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const urls = [
  'https://i0.hdslb.com/bfs/archive/6118aa80d21e0dfff9499b989253ba8e0bbeda89.jpg',
  'http://i0.hdslb.com/bfs/archive/6118aa80d21e0dfff9499b989253ba8e0bbeda89.jpg',
  'https://i2.hdslb.com/bfs/archive/b83d0e0d6131cd00fab4db82df5c70e55c3ee8e9.jpg',
  'https://t14.baidu.com/it/u=2897858076,1773336339&fm=225&app=113&f=JPEG',
  'https://img2.baidu.com/it/u=4011426210,2040637411&fm=253&fmt=auto&app=120&f=JPEG?w=667&h=500',
  'https://i0.hdslb.com/bfs/article/e0a1a540b0f5ac9cd2b6e3f501dc7bf625f22a71.jpg',
];

// 朴素 fetch，不加超时，观察它到底会挂多久。
async function naive(url) {
  const started = Date.now();
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' } });
    const buf = new Uint8Array(await res.arrayBuffer());
    return `${res.status} ${buf.length}B ${Date.now() - started}ms`;
  } catch (e) {
    return `ERR ${e.message} ${e.cause?.code ?? ''} ${Date.now() - started}ms`;
  }
}

console.log('--- 朴素 fetch（参考耗时） ---');
await Promise.all(urls.map(async (u) => console.log(`${(await naive(u)).padEnd(46)} ${u.slice(0, 70)}`)));

console.log('\n--- withTimeout / httpGetCapped 8s ---');
await Promise.all(urls.map(async (u) => {
  const started = Date.now();
  try {
    const r = await httpGetCapped(u, { timeoutMs: 8000, referer: 'https://www.bilibili.com/', maxBytes: 12 * 1024 * 1024 });
    console.log(`${`${r.status} ${r.bytes.length}B ${Date.now() - started}ms`.padEnd(46)} ${u.slice(0, 70)}`);
  } catch (e) {
    console.log(`${`ERR ${e.message} ${Date.now() - started}ms`.padEnd(46)} ${u.slice(0, 70)}`);
  }
}));
