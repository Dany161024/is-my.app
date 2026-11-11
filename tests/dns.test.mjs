import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugFor, desiredRecords, planDnsChanges, validateAll, MANAGED, SITE } from '../scripts/lib/domains.mjs';

const config = { zone: 'is-my.app', pagesPrefix: 'ismy-', maintainers: ['jn-aman'], maxDomainsPerUser: 5, maxRecordsPerUser: 50 };
const owner = { github: 'alice' };
const map = (obj) => new Map(Object.entries(obj));

test('slugFor: simple names', () => {
  assert.equal(slugFor('foo'), 'ismy-foo');
  assert.equal(slugFor('docs.bob'), 'ismy-docs--bob');
  assert.equal(slugFor('Foo'), 'ismy-foo');
});

test('slugFor: always a valid, unique Pages project name', () => {
  const names = ['a.b', 'a--b', 'a---b', '_x.b', 'x-b', 'a'.repeat(63), `${'a'.repeat(52)}.b`, `${'a'.repeat(53)}.b`,
    `${'a'.repeat(60)}.${'b'.repeat(60)}`, `${'a'.repeat(60)}.${'b'.repeat(61)}`, 'b-12345678', 'a.b-12345678'];
  const slugs = names.map((n) => slugFor(n));
  for (const s of slugs) {
    assert.match(s, /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, s);
    assert.ok(s.length <= 58, s);
    assert.ok(s.startsWith('ismy-'), s);
  }
  assert.equal(new Set(slugs).size, names.length);
  assert.equal(slugFor('a.b'), 'ismy-a--b');
  assert.notEqual(slugFor('a--b'), slugFor('a.b'));
  assert.match(slugFor('a--b'), /---[0-9a-f]{8}$/);
});

test('distinct deploy names get distinct project names', () => {
  const d = { owner, deploy: { repo: 'a/b' } };
  assert.deepEqual(validateAll(map({ a: d, b: d }), config, []).errors, []);
});

test('desiredRecords normalizes records', () => {
  const domains = map({
    web: { owner, records: { CNAME: 'User.GitHub.io.' }, proxied: true },
    ip: { owner, records: { A: ['1.1.1.1'], AAAA: ['2606:4700:4700:0:0:0:0:1111'], MX: ['mx1.example.com', { target: 'mx9.example.com', priority: 5 }], TXT: ['a', 'b'] } },
    site: { owner, deploy: { repo: 'alice/site' } },
    pending: { owner, deploy: { repo: 'alice/other' } },
  });
  const lookup = (name) => ({ site: 'ismy-site-x1y.pages.dev' })[name] ?? null;
  const recs = desiredRecords(domains, config, lookup);
  const base = { ttl: 1, comment: MANAGED };
  assert.deepEqual(recs, [
    { type: 'A', name: 'ip.is-my.app', content: '1.1.1.1', proxied: false, ...base },
    { type: 'AAAA', name: 'ip.is-my.app', content: '2606:4700:4700::1111', proxied: false, ...base },
    { type: 'MX', name: 'ip.is-my.app', content: 'mx1.example.com', proxied: false, priority: 10, ...base },
    { type: 'MX', name: 'ip.is-my.app', content: 'mx9.example.com', proxied: false, priority: 5, ...base },
    { type: 'TXT', name: 'ip.is-my.app', content: 'a', proxied: false, ...base },
    { type: 'TXT', name: 'ip.is-my.app', content: 'b', proxied: false, ...base },
    { type: 'CNAME', name: 'site.is-my.app', content: 'ismy-site-x1y.pages.dev', proxied: true, ...base },
    { type: 'CNAME', name: 'web.is-my.app', content: 'user.github.io', proxied: true, ...base },
  ]);
});

const want = (type, name, content, extra = {}) => ({ type, name: `${name}.is-my.app`, content, proxied: false, ttl: 1, comment: MANAGED, ...extra });
let nextId = 0;
const have = (type, name, content, extra = {}) => ({ id: `r${++nextId}`, ...want(type, name, content), ...extra });

test('plan: create, keep, update, delete', () => {
  const existing = [
    have('CNAME', 'same', 'example.com'),
    have('CNAME', 'moved', 'old.example.com'),
    have('A', 'gone', '1.1.1.1'),
    have('A', 'proxy', '1.1.1.1'),
    have('TXT', 'quoted', '"hello"'),
  ];
  const desired = [
    want('CNAME', 'same', 'example.com'),
    want('CNAME', 'moved', 'new.example.com'),
    want('A', 'proxy', '1.1.1.1', { proxied: true }),
    want('A', 'new', '8.8.8.8'),
    want('TXT', 'quoted', 'hello'),
  ];
  const plan = planDnsChanges(existing, desired);
  assert.deepEqual(plan.create.map((r) => r.name), ['new.is-my.app']);
  assert.deepEqual(plan.update.map((u) => [u.before.name, u.after.content]).sort(), [['moved.is-my.app', 'new.example.com'], ['proxy.is-my.app', '1.1.1.1']]);
  assert.deepEqual(plan.delete.map((r) => r.name), ['gone.is-my.app']);
  assert.deepEqual(plan.warnings, []);
});

test('desiredRecords publishes vercel verification at _vercel on the zone', () => {
  const value = 'vc-domain-verify=app.is-my.app,f539122e5720ff377cb0';
  const recs = desiredRecords(map({ app: { owner, records: { CNAME: 'cname.vercel-dns.com' }, vercel: value } }), config);
  assert.deepEqual(recs[1], { type: 'TXT', name: '_vercel.is-my.app', content: value, proxied: false, ttl: 1, comment: MANAGED });
  assert.equal(recs.length, 2);
});

test('plan: several vercel files share _vercel.is-my.app', () => {
  const v = (n) => ({ owner, records: { CNAME: 'cname.vercel-dns.com' }, vercel: `vc-domain-verify=${n}.is-my.app,abc${n}` });
  const desired = desiredRecords(map({ a: v('a'), b: v('b') }), config);
  const created = planDnsChanges([], desired).create;
  const txt = created.filter((r) => r.name === '_vercel.is-my.app');
  assert.equal(txt.length, 2);
  const existing = created.map((r, i) => ({ id: `v${i}`, ...r }));
  const plan = planDnsChanges(existing, desiredRecords(map({ a: v('a') }), config));
  assert.deepEqual(plan.create, []);
  assert.deepEqual(plan.delete.map((r) => `${r.name} ${r.content}`).sort(), ['b.is-my.app cname.vercel-dns.com', `_vercel.is-my.app ${txt[1].content}`].sort());
});

test('plan: never touches unmanaged or site records', () => {
  const existing = [
    { id: 'apex', type: 'A', name: 'is-my.app', content: '76.76.21.21', proxied: true, ttl: 1, comment: null },
    { id: 'www', type: 'CNAME', name: 'www.is-my.app', content: 'is-my-app.pages.dev', proxied: true, ttl: 1, comment: SITE },
    { id: 'manual', type: 'TXT', name: 'taken.is-my.app', content: 'maintainer note', ttl: 1 },
    { id: 'm1', ...want('A', 'taken', '9.9.9.9') },
  ];
  const plan = planDnsChanges(existing, [want('CNAME', 'taken', 'example.com'), want('CNAME', 'www', 'evil.example')]);
  assert.deepEqual(plan.create, []);
  assert.deepEqual(plan.update, []);
  assert.deepEqual(plan.delete, []);
  assert.equal(plan.warnings.length, 2);
  // Nothing desired: unmanaged records still survive.
  const empty = planDnsChanges(existing.slice(0, 3), []);
  assert.deepEqual(empty.delete, []);
});

test('plan: pending deploys keep their records', () => {
  const existing = [have('CNAME', 'site', 'ismy-site.pages.dev', { proxied: true }), have('A', 'old', '1.1.1.1')];
  const plan = planDnsChanges(existing, [], { protect: ['site.is-my.app'] });
  assert.deepEqual(plan.delete.map((r) => r.name), ['old.is-my.app']);
});

test('plan: type changes delete and create, duplicates are removed', () => {
  const existing = [have('A', 'x', '1.1.1.1'), have('A', 'x', '1.1.1.2'), have('CNAME', 'y', 'a.example.com'), have('CNAME', 'y', 'a.example.com')];
  const plan = planDnsChanges(existing, [want('CNAME', 'x', 'example.com'), want('CNAME', 'y', 'a.example.com')]);
  assert.deepEqual(plan.create.map((r) => `${r.type} ${r.name}`), ['CNAME x.is-my.app']);
  assert.equal(plan.delete.length, 3);
  assert.deepEqual(plan.update, []);
});

test('plan: MX priority and comment changes are updates', () => {
  const existing = [have('MX', 'm', 'mx.example.com', { priority: 10 }), have('CNAME', 'c', 'example.com', { comment: `${MANAGED} old` })];
  const plan = planDnsChanges(existing, [want('MX', 'm', 'mx.example.com', { priority: 20 }), want('CNAME', 'c', 'example.com')]);
  assert.equal(plan.update.length, 2);
  assert.deepEqual(plan.create, []);
  assert.deepEqual(plan.delete, []);
});

test('plan: case and trailing-dot differences are not changes', () => {
  const existing = [have('CNAME', 'c', 'Example.COM.'), have('AAAA', 'v6', '2606:4700:4700:0:0:0:0:1111')];
  const plan = planDnsChanges(existing, [want('CNAME', 'c', 'example.com'), want('AAAA', 'v6', '2606:4700:4700::1111')]);
  assert.deepEqual([plan.create, plan.update, plan.delete], [[], [], []]);
});
