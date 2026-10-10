// Verify the client half end-to-end over HTTP: authenticate like the browser, then
// ask whether our package is in the boot manifest and whether its bundle is served.
const BASE = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:19387';
const TOKEN = process.argv[2];

if (!TOKEN) {
  console.log('usage: node probe-client-route.mjs <token>');
  process.exit(2);
}

let cookie = '';
async function get(path) {
  const res = await fetch(`${BASE}${path}`, {
    redirect: 'manual',
    headers: {
      ...(cookie === '' ? {} : { cookie }),
      accept: 'text/html,application/javascript,*/*',
    },
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  if (setCookie.length > 0) cookie = setCookie.map((entry) => entry.split(';')[0]).join('; ');
  const text = await res.text();
  return { status: res.status, location: res.headers.get('location'), type: res.headers.get('content-type'), text, setCookie };
}

// 1) 用 token 激活会话 cookie。
const login = await get(`/?token=${encodeURIComponent(TOKEN)}`);
console.log(`login: status=${login.status} location=${login.location ?? '-'} cookie=${cookie === '' ? '(none)' : 'set'}`);

// 2) 首页：boot 载荷里是否提到我们的包。
const home = await get('/');
console.log(`home: status=${home.status} type=${home.type} len=${home.text.length}`);
const mentions = ['dsh-search-picture', 'search_picture', '__DSH_BOOT__', 'client-modules'].map((needle) => `${needle}=${home.text.includes(needle)}`);
console.log(`  boot payload: ${mentions.join(' ')}`);
const bootMatch = home.text.match(/window\.__DSH_BOOT__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/);
if (bootMatch) {
  try {
    const boot = JSON.parse(bootMatch[1]);
    const modules = boot.modules ?? boot.entries ?? [];
    console.log(`  boot modules (${modules.length}):`);
    for (const row of modules) console.log(`    - ${row.id}${row.immediately ? ' [immediate]' : ''}${row.external?.length ? ` external=[${row.external.join(',')}]` : ''}`);
    const ours = modules.filter((row) => String(row.id).includes('search-picture'));
    console.log(`  our module present: ${ours.length > 0 ? 'YES' : 'NO'}`);
  } catch (error) {
    console.log(`  boot JSON parse failed: ${error.message}`);
    const idx = home.text.indexOf('dsh-search-picture');
    console.log(`  raw context: ${idx === -1 ? '(not found)' : home.text.slice(Math.max(0, idx - 300), idx + 300)}`);
  }
}

// 3) 尝试取 client bundle（带与不带 rev）。
for (const path of ['/plugins/dsh-search-picture/client.js', '/plugins/dsh-search-picture/client.js?rev=0']) {
  const res = await get(path);
  console.log(`bundle ${path}: status=${res.status} type=${res.type} len=${res.text.length} mentionsKey=${res.text.includes('search_picture')}`);
}
