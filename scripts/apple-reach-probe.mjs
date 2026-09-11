/**
 * Why can this host not reach Apple's web player?
 *
 * The token scrape fails with `fetch failed`, which is the same message for a blocked DNS
 * lookup, a dead IPv6 route, an untrusted CA and a reset connection. This walks those apart
 * on the machine that is actually failing: resolve, connect per address family, then run the
 * real scrape and print the cause chain.
 *
 * Run it on the affected box:  node scripts/apple-reach-probe.mjs
 */
import { lookup, Resolver } from 'node:dns/promises';
import { connect as tlsConnect } from 'node:tls';

const HOST = 'music.apple.com';

const describe = (err) => {
  const parts = [];
  const seen = new Set();
  let cur = err;
  while (cur instanceof Error && !seen.has(cur)) {
    seen.add(cur);
    const code = cur.code ? ` (${cur.code})` : '';
    const inner = cur instanceof AggregateError && cur.errors?.length
      ? ` [${cur.errors.map((e) => (e instanceof Error ? `${e.message}${e.code ? ` (${e.code})` : ''}` : String(e))).join('; ')}]`
      : '';
    parts.push(`${cur.message}${code}${inner}`);
    cur = cur.cause;
  }
  return parts.join('  <-  ') || String(err);
};

console.log(`node ${process.version} on ${process.platform}/${process.arch}`);
console.log(`NODE_EXTRA_CA_CERTS=${process.env.NODE_EXTRA_CA_CERTS ?? '(unset)'}  proxy=${
  process.env.HTTPS_PROXY ?? process.env.https_proxy ?? '(unset)'}`);

console.log(`\n--- dns ${HOST}`);
try {
  const resolver = new Resolver();
  console.log('  servers:', resolver.getServers().join(', '));
} catch (err) { console.log('  servers: ?', describe(err)); }
let addresses = [];
try {
  addresses = await lookup(HOST, { all: true });
  for (const a of addresses) console.log(`  ${a.family === 6 ? 'AAAA' : 'A   '} ${a.address}`);
} catch (err) { console.log('  FAIL', describe(err)); }

console.log('\n--- tls connect per address');
for (const { address, family } of addresses) {
  await new Promise((resolve) => {
    const t0 = Date.now();
    const sock = tlsConnect({ host: address, servername: HOST, port: 443, timeout: 8000 }, () => {
      console.log(`  ${address} ok in ${Date.now() - t0}ms  authorized=${sock.authorized}${
        sock.authorized ? '' : ` (${sock.authorizationError})`}`);
      sock.destroy(); resolve();
    });
    sock.on('timeout', () => { console.log(`  ${address} TIMEOUT after ${Date.now() - t0}ms`); sock.destroy(); resolve(); });
    sock.on('error', (err) => { console.log(`  ${address} FAIL ${describe(err)}`); resolve(); });
  });
}

console.log('\n--- the real scrape');
const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:95.0) Gecko/20100101 Firefox/95.0',
  Accept: 'application/json', 'Accept-Language': 'en-US', 'Accept-Encoding': 'gzip, deflate, br',
  'content-type': 'application/json', 'x-apple-renewal': 'true', DNT: '1', Connection: 'keep-alive',
  'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-site',
  origin: 'https://music.apple.com', referer: 'https://music.apple.com/',
};
const decode = (jwt) => {
  try { return JSON.parse(Buffer.from(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()); }
  catch { return null; }
};
try {
  const t0 = Date.now();
  const home = await fetch(`https://${HOST}`, { headers, signal: AbortSignal.timeout(15000) });
  const text = await home.text();
  console.log(`  home ${home.status}, ${text.length} bytes, ${Date.now() - t0}ms`);
  const bundles = [...new Set([...text.matchAll(/\/(assets\/index[~-][^/"]+\.js)/gi)].map((m) => m[1]))];
  console.log('  bundles:', bundles.join(', ') || '(none matched — Apple changed the layout)');
  for (const bundle of bundles) {
    const t1 = Date.now();
    const res = await fetch(`https://${HOST}/${bundle}`, { headers, signal: AbortSignal.timeout(15000) });
    const js = await res.text();
    const jwts = (js.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) ?? [])
      .map(decode).filter(Boolean)
      .map((p) => `${p.iss} exp ${p.exp ? new Date(p.exp * 1000).toISOString().slice(0, 10) : '-'}`);
    console.log(`  ${bundle} ${res.status}, ${js.length} bytes, ${Date.now() - t1}ms, jwts: ${jwts.join(' | ') || '(none)'}`);
  }
} catch (err) { console.log('  FAIL', describe(err)); }
