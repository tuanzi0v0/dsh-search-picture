// Why does the pipeline stop at ~6 attempts? Inspect ranking + pool composition + claim count.
const query = '可塑性记忆 艾拉';
const { ENGINES, runEngine } = await import('../src/providers.js');
const { rankCandidates } = await import('../src/download.js');
const { sizeHintOf } = await import('../src/providers.js');

const results = [];
for (const engine of ENGINES) results.push(await runEngine(engine, query, { timeoutMs: 25000 }));

const seen = new Set();
const all = [];
for (const r of results) {
  const proxied = r.candidates.filter((c) => c.proxied === true).length;
  console.log(`${r.engine}: ${r.candidates.length} 候选, 其中 proxied=${proxied}, error=${r.error ?? '-'}`);
  for (const c of r.candidates) {
    if (seen.has(c.imageUrl)) continue;
    seen.add(c.imageUrl);
    all.push(c);
  }
}
const ranked = rankCandidates(all);
const proxiedTotal = ranked.filter((c) => c.proxied === true).length;
console.log(`\n合并 ${all.length} 条, ranked 中 proxied=${proxiedTotal}, 非 proxied=${all.length - proxiedTotal}`);
console.log(`pool 大小 count=6 -> ${Math.max(6 * 8, 6 + 40)}`);
console.log('\nranked 前 12 条:');
for (const [i, c] of ranked.slice(0, 12).entries()) {
  console.log(` ${String(i).padStart(2)} ${String(c.engine).padEnd(6)} proxied=${String(c.proxied)} ${String(c.width ?? '?')}x${String(c.height ?? '?')} hint=${String(sizeHintOf(c.imageUrl))} ${c.imageUrl.slice(0, 85)}`);
}
console.log('\n非 proxied 的条数:', all.length - proxiedTotal, ' 前 8 条的非 proxied:');
for (const [i, c] of ranked.filter((c) => c.proxied !== true).slice(0, 8).entries()) {
  console.log(` ${String(i).padStart(2)} ${String(c.engine).padEnd(6)} ${String(c.width ?? '?')}x${String(c.height ?? '?')} ${c.imageUrl.slice(0, 90)}`);
}
