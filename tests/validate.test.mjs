import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateDomain, validateAll, validateName, loadDomains, isPublicIPv4, isPublicIPv6, canonicalIPv6,
  withDeployDefaults, isHostname, recordCount,
} from '../scripts/lib/domains.mjs';

const config = {
  zone: 'is-my.app', repo: 'jn-aman/is-my.app', pagesPrefix: 'ismy-', sitePagesProject: 'is-my-app',
  maintainers: ['jn-aman'], maxDomainsPerUser: 2, maxRecordsPerUser: 6, minAccountAgeDays: 14,
};
const reserved = ['www', 'api', 'admin', 'blog'];
const ctx = { config, reserved };
const owner = (github = 'alice') => ({ github });
const rec = (records, extra = {}) => ({ owner: owner(), records, ...extra });
const errs = (name, data) => validateDomain(name, data, ctx).errors;
const ok = (name, data) => assert.deepEqual(errs(name, data), [], `${name} should be valid`);
const bad = (name, data, re) => {
  const e = errs(name, data);
  assert.ok(e.some((m) => re.test(m)), `${name}: expected error matching ${re}, got ${JSON.stringify(e)}`);
};

test('valid names', () => {
  for (const n of ['a', 'bob', 'my-site', 'x1', 'a'.repeat(63), 'www2', 'docs.bob', '_dmarc.bob', '_github-pages-challenge-bob.bob', 'a.b.c']) {
    assert.deepEqual(validateName(n, ctx), [], n);
  }
});

test('invalid names', () => {
  for (const n of ['', 'Bob', '-bob', 'bob-', 'b_b', 'a'.repeat(64), 'bob..x', '.bob', 'bob.', 'bo b', '_bob', 'x._bob', '__x.bob', 'bob!']) {
    assert.notDeepEqual(validateName(n, ctx), [], JSON.stringify(n));
  }
});

test('long FQDNs are rejected', () => {
  const name = Array(4).fill('a'.repeat(62)).join('.');
  assert.ok(validateName(name, ctx).some((m) => /253/.test(m)));
});

test('reserved check applies to the rightmost label', () => {
  bad('www', rec({ CNAME: 'example.com' }), /reserved/);
  bad('foo.www', rec({ CNAME: 'example.com' }), /reserved/);
  ok('www.foo', rec({ CNAME: 'example.com' }));
});

test('IPv4 ranges', () => {
  for (const ip of ['1.1.1.1', '8.8.8.8', '185.199.108.153', '100.63.255.255', '172.32.0.1', '223.255.255.255']) assert.ok(isPublicIPv4(ip), ip);
  for (const ip of ['10.0.0.1', '127.0.0.1', '0.1.2.3', '169.254.1.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1',
    '100.127.255.255', '224.0.0.1', '239.1.1.1', '240.0.0.1', '255.255.255.255', '192.0.2.1', '198.51.100.7', '203.0.113.9',
    '198.18.0.1', '192.0.0.8', '01.2.3.4', '1.2.3', '1.2.3.4.5', ' 1.1.1.1', 1]) {
    assert.ok(!isPublicIPv4(ip), String(ip));
  }
});

test('IPv6 ranges', () => {
  for (const ip of ['2606:4700:4700::1111', '2a00:1450:4001::200e', '2001:4860:4860::8888']) assert.ok(isPublicIPv6(ip), ip);
  for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:8.8.8.8', '2001:db8::1', '2002:c000:0204::1',
    '64:ff9b::1.2.3.4', '2001::1', '3fff::1', 'fe80::1%eth0', 'not-an-ip', '1.1.1.1']) {
    assert.ok(!isPublicIPv6(ip), ip);
  }
});

test('canonical IPv6', () => {
  assert.equal(canonicalIPv6('2606:4700:4700:0000:0000:0000:0000:1111'), '2606:4700:4700::1111');
  assert.equal(canonicalIPv6('2001:0DB8:0:0:1:0:0:1'), '2001:db8::1:0:0:1');
  assert.equal(canonicalIPv6('2a00:1:0:1:0:1:0:1'), '2a00:1:0:1:0:1:0:1');
});

test('records: A / AAAA', () => {
  ok('a', rec({ A: ['1.1.1.1', '8.8.8.8'] }));
  ok('a', rec({ AAAA: ['2606:4700:4700::1111'] }));
  ok('a', rec({ A: ['1.1.1.1'], AAAA: ['2606:4700:4700::1111'], TXT: 'hello' }));
  bad('a', rec({ A: ['10.0.0.1'] }), /public IPv4/);
  bad('a', rec({ A: '1.1.1.1' }), /non-empty array/);
  bad('a', rec({ A: [] }), /non-empty array/);
  bad('a', rec({ A: ['1.1.1.1', '1.1.1.1'] }), /duplicate/);
  bad('a', rec({ AAAA: ['::1'] }), /public IPv6/);
  bad('a', rec({ A: Array.from({ length: 11 }, (_, i) => `1.1.1.${i + 1}`) }), /at most 10/);
});

test('records: CNAME', () => {
  ok('a', rec({ CNAME: 'aman.wiki' }));
  ok('a', rec({ CNAME: 'user.github.io.' }));
  bad('a', rec({ CNAME: 'is-my.app' }), /points back/);
  bad('a', rec({ CNAME: 'foo.is-my.app' }), /points back/);
  bad('a', rec({ CNAME: 'FOO.IS-MY.APP.' }), /points back/);
  bad('a', rec({ CNAME: 'localhost' }), /valid hostname/);
  bad('a', rec({ CNAME: '1.2.3.4' }), /valid hostname/);
  bad('a', rec({ CNAME: 'https://example.com' }), /valid hostname/);
  bad('a', rec({ CNAME: ['example.com'] }), /valid hostname/);
  bad('a', rec({ CNAME: 'example.com', A: ['1.1.1.1'] }), /cannot be combined/);
  bad('a', rec({ CNAME: 'example.com', TXT: 'x' }), /cannot be combined/);
});

test('records: MX and TXT', () => {
  ok('a', rec({ MX: ['mx1.example.com', { target: 'mx2.example.com', priority: 20 }] }));
  bad('a', rec({ MX: [{ target: 'mx.example.com' }] }), /priority/);
  bad('a', rec({ MX: [{ target: 'mx.example.com', priority: 70000 }] }), /priority/);
  bad('a', rec({ MX: [{ target: 'mx.example.com', priority: 1, weight: 2 }] }), /unknown key "weight"/);
  bad('a', rec({ MX: ['not a host'] }), /valid hostname/);
  ok('a', rec({ TXT: 'v=spf1 -all' }));
  ok('_dmarc.a', rec({ TXT: ['v=DMARC1; p=none'] }));
  bad('a', rec({ TXT: '' }), /TXT/);
  bad('a', rec({ TXT: 'line\nbreak' }), /TXT/);
  bad('a', rec({ TXT: 'x'.repeat(2049) }), /TXT/);
  bad('a', rec({ SRV: 'x' }), /unknown key "SRV"/);
  bad('a', rec({}), /non-empty object/);
});

test('strict keys everywhere', () => {
  bad('a', { ...rec({ CNAME: 'example.com' }), extra: 1 }, /unknown key "extra"/);
  bad('a', { owner: { github: 'alice', twitter: 'x' }, records: { CNAME: 'example.com' } }, /owner: unknown key "twitter"/);
  bad('a', { owner: owner(), deploy: { repo: 'a/b', command: 'x' } }, /deploy: unknown key "command"/);
  ok('a', { $schema: '../schema/domain.schema.json', owner: owner(), description: 'hi', records: { CNAME: 'example.com' } });
});

test('owner and description', () => {
  bad('a', { records: { CNAME: 'example.com' } }, /owner/);
  bad('a', { owner: { github: '-bad-' }, records: { CNAME: 'example.com' } }, /GitHub username/);
  bad('a', { owner: { github: 'alice', email: 'nope' }, records: { CNAME: 'example.com' } }, /email/);
  ok('a', { owner: { github: 'alice', email: 'a@b.co' }, records: { CNAME: 'example.com' } });
  bad('a', { ...rec({ CNAME: 'example.com' }), description: 'x'.repeat(201) }, /description/);
  bad('a', [], /JSON object/);
  bad('a', null, /JSON object/);
});

test('exactly one of records / deploy', () => {
  bad('a', { owner: owner() }, /exactly one/);
  bad('a', { owner: owner(), records: { CNAME: 'example.com' }, deploy: { repo: 'a/b' } }, /exactly one/);
});

test('proxied rules', () => {
  ok('a', rec({ CNAME: 'example.com' }, { proxied: true }));
  ok('a', rec({ A: ['1.1.1.1'], TXT: 'x' }, { proxied: true }));
  ok('a.b', rec({ CNAME: 'example.com' }, { proxied: false }));
  bad('a.b', rec({ CNAME: 'example.com' }, { proxied: true }), /top-level/);
  bad('a', rec({ TXT: 'x' }, { proxied: true }), /requires an A, AAAA or CNAME/);
  bad('a', rec({ CNAME: 'example.com' }, { proxied: 'yes' }), /true or false/);
  bad('a', { owner: owner(), deploy: { repo: 'a/b' }, proxied: true }, /cannot be used with "deploy"/);
});

test('vercel verification rules', () => {
  const code = 'f539122e5720ff377cb0';
  ok('a', rec({ CNAME: 'cname.vercel-dns.com' }, { vercel: `vc-domain-verify=a.is-my.app,${code}` }));
  ok('docs.a', rec({ CNAME: 'cname.vercel-dns.com' }, { vercel: `vc-domain-verify=docs.a.is-my.app,${code}` }));
  bad('a', rec({ CNAME: 'cname.vercel-dns.com' }, { vercel: `vc-domain-verify=b.is-my.app,${code}` }), /"vercel" must be the TXT value/);
  bad('docs.a', rec({ CNAME: 'cname.vercel-dns.com' }, { vercel: `vc-domain-verify=a.is-my.app,${code}` }), /"vercel" must be the TXT value/);
  bad('a', rec({ CNAME: 'cname.vercel-dns.com' }, { vercel: 'vc-domain-verify=a.is-my.app,bad code!' }), /"vercel" must be the TXT value/);
  bad('a', rec({ CNAME: 'cname.vercel-dns.com' }, { vercel: 'vc-domain-verify=a.is-my.app,' }), /"vercel" must be the TXT value/);
  bad('a', rec({ CNAME: 'cname.vercel-dns.com' }, { vercel: 5 }), /"vercel" must be the TXT value/);
  bad('a', { owner: owner(), deploy: { repo: 'a/b' }, vercel: `vc-domain-verify=a.is-my.app,${code}` }, /"vercel" cannot be used with "deploy"/);
});

test('deploy validation and defaults', () => {
  ok('site', { owner: owner(), deploy: { repo: 'alice/portfolio' } });
  ok('site', { owner: owner(), deploy: { repo: 'alice/my.site', branch: 'gh-pages', build: 'npm ci && npm run build', output: 'dist', root: 'packages/web', node: '20' } });
  bad('site', { owner: owner(), deploy: {} }, /deploy.repo/);
  bad('site', { owner: owner(), deploy: { repo: 'https://github.com/a/b' } }, /deploy.repo/);
  bad('site', { owner: owner(), deploy: { repo: 'a/..' } }, /deploy.repo/);
  bad('site', { owner: owner(), deploy: { repo: 'a/b', output: '../secrets' } }, /deploy.output/);
  bad('site', { owner: owner(), deploy: { repo: 'a/b', root: '/etc' } }, /deploy.root/);
  bad('site', { owner: owner(), deploy: { repo: 'a/b', branch: '-x' } }, /deploy.branch/);
  bad('site', { owner: owner(), deploy: { repo: 'a/b', branch: 'a..b' } }, /deploy.branch/);
  bad('site', { owner: owner(), deploy: { repo: 'a/b', node: '16' } }, /deploy.node/);
  bad('site', { owner: owner(), deploy: { repo: 'a/b', node: 22 } }, /deploy.node/);
  bad('site', { owner: owner(), deploy: { repo: 'a/b', build: 'a\nb' } }, /deploy.build/);
  bad('_x.site', { owner: owner(), deploy: { repo: 'a/b' } }, /top-level/);
  bad('docs.site', { owner: owner(), deploy: { repo: 'a/b' } }, /top-level/);
  assert.deepEqual(withDeployDefaults({ repo: 'a/b' }), { repo: 'a/b', branch: 'main', build: '', output: '.', root: '.', node: '22' });
  assert.equal(withDeployDefaults({ repo: 'a/b', build: '  npm run build ' }).build, 'npm run build');
});

test('isHostname', () => {
  assert.ok(isHostname('a.b'));
  assert.ok(isHostname('_acme.example.com'));
  assert.ok(isHostname('xn--80ak6aa92e.com'));
  assert.ok(!isHostname('example'));
  assert.ok(!isHostname('example.123'));
  assert.ok(!isHostname('exa mple.com'));
  assert.ok(!isHostname(`${'a'.repeat(64)}.com`));
});

const map = (obj) => new Map(Object.entries(obj));
const allErrors = (domains, cfg = config) => validateAll(map(domains), cfg, reserved).errors;

test('nested names need the top-level name with the same owner', () => {
  assert.deepEqual(allErrors({ bob: rec({ CNAME: 'example.com' }), 'docs.bob': rec({ CNAME: 'example.com' }) }), []);
  const orphan = allErrors({ 'docs.bob': rec({ CNAME: 'example.com' }) });
  assert.ok(orphan.some((e) => e.name === 'docs.bob' && /must be registered/.test(e.message)));
  const stranger = allErrors({ bob: rec({ CNAME: 'example.com' }), 'docs.bob': { owner: owner('mallory'), records: { CNAME: 'example.com' } } });
  assert.ok(stranger.some((e) => e.name === 'docs.bob' && /different owner/.test(e.message)));
  const mid = allErrors({
    bob: rec({ CNAME: 'example.com' }),
    'x.bob': { owner: owner('ALICE'), records: { CNAME: 'example.com' } },
    'y.x.bob': { owner: owner('mallory'), records: { CNAME: 'example.com' } },
  });
  assert.deepEqual(mid.map((e) => e.name).sort(), ['y.x.bob', 'y.x.bob']);
});

test('per-user limits count top-level names only; maintainers are exempt', () => {
  const r = rec({ CNAME: 'example.com' });
  assert.deepEqual(allErrors({ a: r, b: r, 'x.a': r, 'y.b': r }), []);
  const over = allErrors({ a: r, b: r, c: r });
  assert.equal(over.filter((e) => /exceeds the limit/.test(e.message)).length, 3);
  const m = { owner: owner('JN-Aman'), records: { CNAME: 'example.com' } };
  assert.deepEqual(allErrors({ a: m, b: m, c: m, d: m }), []);
});

test('per-user record cap counts every record, nested names included', () => {
  const two = rec({ A: ['1.1.1.1', '8.8.8.8'] });
  assert.deepEqual(allErrors({ a: two, 'x.a': two, 'y.a': two }), []);
  const over = allErrors({ a: two, 'x.a': two, 'y.a': two, 'z.a': rec({ TXT: 'hello' }) });
  assert.equal(over.filter((e) => /6 DNS records \(has 7\)/.test(e.message)).length, 4);
  assert.equal(recordCount({ deploy: { repo: 'a/b' } }), 1);
  assert.equal(recordCount({ records: { MX: ['a.example', 'b.example'], TXT: 'x' } }), 3);
  assert.equal(recordCount({ records: { CNAME: 'example.com' }, vercel: 'vc-domain-verify=a.is-my.app,abc' }), 2);
  assert.equal(recordCount({ deploy: { repo: 'a/b' } }), 1);
  const m = { owner: owner('jn-aman'), records: { A: ['1.1.1.1', '8.8.8.8', '9.9.9.9', '4.4.4.4'] } };
  assert.deepEqual(allErrors({ a: m, b: m }), []);
});

test('validateAll reports the set of valid names', () => {
  const { valid } = validateAll(map({ good: rec({ CNAME: 'example.com' }), bad: rec({ A: ['10.0.0.1'] }) }), config, reserved);
  assert.deepEqual([...valid], ['good']);
});

test('loadDomains rejects non-JSON files and bad JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ismy-'));
  writeFileSync(join(dir, 'good.json'), JSON.stringify(rec({ CNAME: 'example.com' })));
  writeFileSync(join(dir, 'broken.json'), '{ nope');
  writeFileSync(join(dir, 'README.md'), 'hi');
  mkdirSync(join(dir, 'sub'));
  const { domains, errors } = loadDomains(dir);
  assert.deepEqual([...domains.keys()], ['good']);
  assert.equal(errors.length, 3);
  assert.ok(errors.some((e) => /invalid JSON/.test(e.message)));
});
