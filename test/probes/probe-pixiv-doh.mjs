/**
 * 能不能绕开 DNS 污染去访问 Pixiv？
 *
 * 线索：`www.pixiv.co.jp` 直连正常（TCP 238ms），而 `pixiv.net` / `i.pximg.net` 被解析到
 * 无关 IP（Meta、Verizon）并连接超时——典型的 DNS 污染，不是 IP 段封锁。
 *
 * 因此试两条路：
 *   A. 用加密 DNS（DoH）拿真实 IP，看能否直连；
 *   B. 直接请求应用 API 域名（app-api.pixiv.net），它的解析可能与网页域不同。
 *
 * 这是「诊断」用途：只做连通性验证，不下载任何内容。
 */
import { lookup } from 'node:dns/promises';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** 用 DoH（Cloudflare / Google）查真实 A 记录。 */
async function dohResolve(host, endpoint) {
  const url = endpoint === 'cloudflare'
    ? `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`
    : `https://dns.google/resolve?name=${encodeURIComponent(host)}&type=A`;
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/dns-json', 'user-agent': UA },
      signal: AbortSignal.timeout(12000),
    });
    if (res.status !== 200) return `HTTP ${String(res.status)}`;
    const body = await res.json();
    const answers = (body.Answer ?? []).filter((a) => a.type === 1).map((a) => a.data);
    return answers.length > 0 ? answers.join(', ') : '(无 A 记录)';
  } catch (error) {
    return `ERR ${error.message} ${error.cause?.code ?? ''}`;
  }
}

const HOSTS = ['pixiv.net', 'www.pixiv.net', 'i.pximg.net', 'app-api.pixiv.net'];

console.log('=== A. DoH 能否拿到真实 IP（对比系统 DNS） ===');
for (const host of HOSTS) {
  let system = '';
  try {
    const addresses = await lookup(host, { all: true });
    system = addresses.map((a) => a.address).join(', ');
  } catch (error) {
    system = `DNS ${error.code ?? error.message}`;
  }
  const cloudflare = await dohResolve(host, 'cloudflare');
  console.log(`  ${host.padEnd(20)}`);
  console.log(`     系统 DNS : ${system}`);
  console.log(`     DoH(CF)  : ${cloudflare}`);
}

console.log('\n=== B. 应用 API 域名的连通性 ===');
for (const url of ['https://app-api.pixiv.net/v1/illust/ranking?mode=day', 'https://pixiv.net/', 'https://www.pixiv.co.jp/']) {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'application/json,text/html' },
      signal: AbortSignal.timeout(12000),
    });
    console.log(`  ${url.padEnd(56)} HTTP ${String(res.status)}`);
  } catch (error) {
    console.log(`  ${url.padEnd(56)} ${error.message} ${error.cause?.code ?? ''}`);
  }
}

console.log('\n=== C. DoH 返回的 IP 能否直连（443） ===');
const { connect } = await import('node:net');
function tcpProbe(ip, port = 443, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = connect({ host: ip, port });
    const done = (result) => {
      socket.destroy();
      resolve(`${result} ${String(Date.now() - started)}ms`);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done('TCP OK'));
    socket.once('timeout', () => done('TCP TIMEOUT'));
    socket.once('error', (error) => done(`TCP ${error.code ?? error.message}`));
  });
}
for (const host of HOSTS.slice(0, 2)) {
  const cloudflare = await dohResolve(host, 'cloudflare');
  const ips = cloudflare.split(', ').filter((value) => /^\d+\.\d+\.\d+\.\d+$/.test(value));
  for (const ip of ips.slice(0, 3)) {
    console.log(`  ${host} → ${ip}  ${await tcpProbe(ip)}`);
  }
  if (ips.length === 0) console.log(`  ${host} → DoH 未给出可用 IP（${cloudflare}）`);
}
