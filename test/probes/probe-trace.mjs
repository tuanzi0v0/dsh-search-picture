// Trace one download batch attempt-by-attempt to find why so few candidates are tried.
const query = '可塑性记忆 艾拉';
const { ENGINES, runEngine } = await import('../src/providers.js');
const { downloadCandidates } = await import('../src/download.js');

const results = [];
for (const engine of ENGINES) results.push(await runEngine(engine, query, { timeoutMs: 25000 }));
const seen = new Set();
const all = [];
for (const r of results) for (const c of r.candidates) { if (!seen.has(c.imageUrl)) { seen.add(c.imageUrl); all.push(c); } }
console.log('候选总数', all.length);

let attempts = 0;
const { mkdir } = await import('node:fs/promises');
await mkdir('.work/trace-downloads', { recursive: true });
const { files, failures } = await downloadCandidates(all, {
  directory: '.work/trace-downloads',
  query: 'trace',
  count: 6,
  minPixels: 720000,
  minBytes: 4096,
  concurrency: 6,
  timeoutMs: 30000,
});
console.log('成功', files.length, '失败', failures.length, '尝试总计(成功+失败)', files.length + failures.length);
const counts = {};
for (const f of failures) { const k = `${f.engine}: ${f.reason.replace(/\(.*\)/, '').trim()}`; counts[k] = (counts[k] ?? 0) + 1; }
console.log(counts);
console.log('成功清单:', files.map((f) => `${f.fileName} ${f.width}x${f.height} ${f.engine}`).join('\n  '));
console.log('失败前 20:', failures.slice(0, 20).map((f) => `${f.engine} ${f.reason.slice(0, 70)} ${f.url.slice(0, 70)}`).join('\n  '));
