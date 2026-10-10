/**
 * 把「Pixiv 连不上」的原因定死：DNS？TCP？TLS？还是只有 Pixiv 被挡？
 *
 * 上一轮全是 UND_ERR_CONNECT_TIMEOUT（连接超时 = TCP 建连没成功），区别于
 * 「证书错误」——后者说明能连上只是 TLS 校验不过。这两种原因的应对方式完全不同。
 */
import { lookup } from 'node:dns/promises';
import { connect } from 'node:net';

const HOSTS = [
  ['pixiv.net', 443],
  ['i.pximg.net', 443],
  ['www.pixiv.net', 443],
  ['www.bing.com', 443],
  ['api.github.com', 443],
  ['www.zhihu.com', 443],
  ['www.pixiv.co.jp', 443],
];

/** 只做 TCP 建连，不涉及 TLS/HTTP。 */
function tcpProbe(host, port, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = connect({ host, port });
    const done = (result) => {
      socket.destroy();
      resolve(`${result}  ${String(Date.now() - started)}ms`);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done('TCP OK'));
    socket.once('timeout', () => done('TCP TIMEOUT'));
    socket.once('error', (error) => done(`TCP ${error.code ?? error.message}`));
  });
}

console.log('=== DNS 解析 ===');
for (const [host] of HOSTS) {
  try {
    const addresses = await lookup(host, { all: true });
    console.log(`  ${host.padEnd(20)} → ${addresses.map((a) => `${a.address}(v${String(a.family)})`).join(', ')}`);
  } catch (error) {
    console.log(`  ${host.padEnd(20)} → DNS ${error.code ?? error.message}`);
  }
}

console.log('\n=== TCP 建连（443） ===');
for (const [host, port] of HOSTS) {
  console.log(`  ${host.padEnd(20)} ${await tcpProbe(host, port)}`);
}

console.log('\n=== HTTPS 层（区分证书问题 vs 连接问题） ===');
for (const host of ['pixiv.net', 'www.bing.com', 'api.github.com']) {
  try {
    const res = await fetch(`https://${host}/`, { signal: AbortSignal.timeout(12000) });
    console.log(`  ${host.padEnd(20)} HTTP ${String(res.status)}`);
  } catch (error) {
    console.log(`  ${host.padEnd(20)} ${error.message}  cause=${error.cause?.code ?? '-'}`);
  }
}

console.log('\n=== 代理环境（有代理时境外站才可能通） ===');
const proxyKeys = Object.keys(process.env).filter((key) => /proxy/i.test(key));
if (proxyKeys.length === 0) console.log('  （无任何 *_PROXY 环境变量）');
for (const key of proxyKeys) console.log(`  ${key}=${process.env[key]}`);
