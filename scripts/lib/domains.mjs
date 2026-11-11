import { readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const MANAGED = 'is-my.app:managed';
export const SITE = 'is-my.app:site';
export const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT'];
export const DEPLOY_DEFAULTS = { branch: 'main', build: '', output: '.', root: '.', node: '22' };

const LABEL = /^_?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const HOST_LABEL = /^_?[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const TLD = /^[a-z]([a-z0-9-]*[a-z0-9])?$/;
const GITHUB_USER = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REPO = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}\/[\w.-]{1,100}$/i;
const PRINTABLE = /^[^\x00-\x1f\x7f]*$/;
const PROXIABLE = ['A', 'AAAA', 'CNAME'];

// ---------- loading ----------

export function loadDomains(dir) {
  const domains = new Map();
  const errors = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = join(dir, entry.name);
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      errors.push({ file, message: 'only *.json files are allowed in domains/' });
      continue;
    }
    try {
      domains.set(entry.name.slice(0, -5), JSON.parse(readFileSync(file, 'utf8')));
    } catch (e) {
      errors.push({ file, message: `invalid JSON: ${e.message}` });
    }
  }
  return { domains, errors };
}

export function loadRepo(root = ROOT) {
  const read = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));
  const { domains, errors } = loadDomains(join(root, 'domains'));
  return { config: read('config/zone.json'), reserved: read('config/reserved.json'), domains, loadErrors: errors };
}

// ---------- IP helpers ----------

const V4_BLOCKED = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12',
  '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15',
  '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4',
];
// Only global unicast (2000::/3) is allowed, minus these special-purpose ranges.
const V6_BLOCKED = ['2001::/23', '2001:db8::/32', '2002::/16', '3fff::/20'];

const v4ToInt = (ip) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0);

function inV4(ip, cidr) {
  const [base, bits] = cidr.split('/');
  const size = 2 ** (32 - Number(bits));
  return Math.floor(v4ToInt(ip) / size) === Math.floor(v4ToInt(base) / size);
}

export const isPublicIPv4 = (ip) => typeof ip === 'string' && isIPv4(ip) && !V4_BLOCKED.some((c) => inV4(ip, c));

function v6Groups(ip) {
  let s = ip.toLowerCase();
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = v4ToInt(v4[1]);
    s = s.slice(0, -v4[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [h, t] = s.includes('::') ? s.split('::') : [s, null];
  const head = h ? h.split(':') : [];
  const tail = t ? t.split(':') : [];
  const fill = t === null ? [] : Array(8 - head.length - tail.length).fill('0');
  return [...head, ...fill, ...tail].map((g) => parseInt(g, 16));
}

const v6ToBig = (ip) => v6Groups(ip).reduce((a, g) => (a << 16n) | BigInt(g), 0n);

function inV6(ip, cidr) {
  const [base, bits] = cidr.split('/');
  const shift = 128n - BigInt(bits);
  return v6ToBig(ip) >> shift === v6ToBig(base) >> shift;
}

export const isPublicIPv6 = (ip) =>
  typeof ip === 'string' && !ip.includes('%') && isIPv6(ip) && inV6(ip, '2000::/3') && !V6_BLOCKED.some((c) => inV6(ip, c));

// RFC 5952 canonical text form, so diffs against Cloudflare are stable.
export function canonicalIPv6(ip) {
  const groups = v6Groups(ip);
  let best = [-1, 0];
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > best[1] && j - i > 1) best = [i, j - i];
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (best[0] < 0) return hex.join(':');
  return `${hex.slice(0, best[0]).join(':')}::${hex.slice(best[0] + best[1]).join(':')}`;
}

// ---------- name / host helpers ----------

export const normHost = (h) => h.toLowerCase().replace(/\.$/, '');

export function isHostname(h) {
  if (typeof h !== 'string') return false;
  const s = normHost(h);
  if (s.length > 253) return false;
  const labels = s.split('.');
  return labels.length >= 2 && labels.every((l) => l.length <= 63 && HOST_LABEL.test(l)) && TLD.test(labels.at(-1));
}

export const topLabel = (name) => name.split('.').at(-1);
export const isTopLevel = (name) => !name.includes('.');

export function validateName(name, { config, reserved = [] }) {
  if (typeof name !== 'string' || !name) return ['name is empty'];
  const errors = [];
  for (const l of name.split('.')) {
    if (l.length > 63 || !LABEL.test(l)) {
      errors.push(`invalid label "${l}": use lowercase a-z, 0-9 and "-" (max 63 chars, no leading or trailing "-")`);
    }
  }
  const top = topLabel(name);
  if (top.startsWith('_')) errors.push(`"${top}" cannot start with "_" (only nested labels may)`);
  if (`${name}.${config.zone}`.length > 253) errors.push('full hostname is longer than 253 characters');
  if (new Set(reserved).has(top)) errors.push(`"${top}" is reserved`);
  return errors;
}

// ---------- per-file validation ----------

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, max) => typeof v === 'string' && v.length <= max && PRINTABLE.test(v);

function strictKeys(obj, allowed, where, errors) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) errors.push(`${where}: unknown key "${k}"`);
}

function checkList(value, type, check, errors, allowString = false) {
  const list = allowString && typeof value === 'string' ? [value] : value;
  if (!Array.isArray(list) || !list.length) return errors.push(`records.${type} must be a non-empty array`);
  if (list.length > 10) errors.push(`records.${type}: at most 10 values allowed`);
  for (const v of list) {
    const msg = check(v);
    if (msg) errors.push(`records.${type}: ${msg}`);
  }
  if (new Set(list.map((v) => JSON.stringify(v))).size !== list.length) errors.push(`records.${type}: duplicate values`);
}

function checkTarget(host, zone) {
  if (!isHostname(host)) return `${JSON.stringify(host)} is not a valid hostname`;
  const h = normHost(host);
  if (zone && (h === zone || h.endsWith(`.${zone}`))) return `"${h}" points back into ${zone} (not allowed)`;
  return null;
}

function validateRecords(records, zone, errors) {
  if (!isObj(records) || !Object.keys(records).length) return errors.push('"records" must be a non-empty object');
  strictKeys(records, RECORD_TYPES, 'records', errors);
  if ('CNAME' in records && Object.keys(records).length > 1) errors.push('CNAME cannot be combined with other record types');
  if ('A' in records) checkList(records.A, 'A', (v) => !isPublicIPv4(v) && `${JSON.stringify(v)} is not a public IPv4 address`, errors);
  if ('AAAA' in records) checkList(records.AAAA, 'AAAA', (v) => !isPublicIPv6(v) && `${JSON.stringify(v)} is not a public IPv6 address`, errors);
  if ('CNAME' in records) {
    const msg = checkTarget(records.CNAME, zone);
    if (msg) errors.push(`records.CNAME: ${msg}`);
  }
  if ('MX' in records) {
    checkList(records.MX, 'MX', (v) => {
      if (typeof v === 'string') return checkTarget(v);
      if (!isObj(v)) return 'each MX must be a hostname or {"target", "priority"}';
      const bad = Object.keys(v).filter((k) => k !== 'target' && k !== 'priority');
      if (bad.length) return `unknown key "${bad[0]}"`;
      if (!Number.isInteger(v.priority) || v.priority < 0 || v.priority > 65535) return 'priority must be an integer 0-65535';
      return checkTarget(v.target);
    }, errors);
  }
  if ('TXT' in records) {
    checkList(records.TXT, 'TXT', (v) => !(str(v, 2048) && v.length > 0) && 'each TXT value must be a non-empty single-line string (max 2048 chars)', errors, true);
  }
}

function isRelPath(p) {
  return typeof p === 'string' && p.length > 0 && p.length <= 200 && /^[\w.\/@+-]+$/.test(p) &&
    !p.startsWith('/') && !p.startsWith('-') && !p.split('/').includes('..');
}

function isBranch(b) {
  return typeof b === 'string' && b.length > 0 && b.length <= 200 && /^[\w.\/-]+$/.test(b) &&
    !/^[-/.]/.test(b) && !/(\.\.|\/\/|\/\.|\.lock$|[/.]$)/.test(b);
}

function validateDeploy(name, d, errors) {
  if (!isObj(d)) return errors.push('"deploy" must be an object');
  strictKeys(d, ['repo', 'branch', 'build', 'output', 'root', 'node'], 'deploy', errors);
  // Free Universal SSL only covers one level (*.is-my.app), so hosted apps live at top-level names.
  if (!isTopLevel(name)) errors.push('"deploy" is only available on top-level names like "my-app", not "docs.my-app"');
  if (typeof d.repo !== 'string' || !REPO.test(d.repo) || /\/\.\.?$/.test(d.repo)) errors.push('deploy.repo must be a GitHub repository like "owner/name"');
  if ('branch' in d && !isBranch(d.branch)) errors.push('deploy.branch must be a valid branch name');
  if ('build' in d && !str(d.build, 500)) errors.push('deploy.build must be a single-line string (max 500 chars; chain commands with &&)');
  for (const k of ['output', 'root']) if (k in d && !isRelPath(d[k])) errors.push(`deploy.${k} must be a relative path inside the repository`);
  if ('node' in d && !(typeof d.node === 'string' && /^(1[89]|2\d)(\.\d+){0,2}$/.test(d.node))) errors.push('deploy.node must be a Node.js version like "22"');
}

export function validateDomain(name, data, { config, reserved = [] }) {
  const errors = validateName(name, { config, reserved });
  const warnings = [];
  if (!isObj(data)) return { errors: [...errors, 'file must contain a JSON object'], warnings };
  strictKeys(data, ['$schema', 'owner', 'description', 'records', 'deploy', 'proxied', 'vercel'], 'root', errors);
  if ('$schema' in data && typeof data.$schema !== 'string') errors.push('"$schema" must be a string');

  if (!isObj(data.owner)) errors.push('"owner" must be an object with your GitHub username in "github"');
  else {
    strictKeys(data.owner, ['github', 'email'], 'owner', errors);
    if (typeof data.owner.github !== 'string' || !GITHUB_USER.test(data.owner.github)) errors.push('owner.github must be a valid GitHub username');
    if ('email' in data.owner && !(str(data.owner.email, 254) && EMAIL.test(data.owner.email))) errors.push('owner.email must be a valid email address');
  }
  if ('description' in data && !str(data.description, 200)) errors.push('description must be a single-line string (max 200 chars)');

  const hasRecords = 'records' in data;
  const hasDeploy = 'deploy' in data;
  if (hasRecords === hasDeploy) errors.push('exactly one of "records" or "deploy" is required');
  else if (hasRecords) validateRecords(data.records, config.zone, errors);
  else validateDeploy(name, data.deploy, errors);

  if ('proxied' in data) {
    if (hasDeploy) errors.push('"proxied" cannot be used with "deploy" (hosted sites are always proxied)');
    else if (typeof data.proxied !== 'boolean') errors.push('"proxied" must be true or false');
    else if (data.proxied && !isTopLevel(name)) errors.push('"proxied" is only allowed on top-level names');
    else if (data.proxied && isObj(data.records) && !PROXIABLE.some((t) => t in data.records)) errors.push('"proxied" requires an A, AAAA or CNAME record');
  }

  if ('vercel' in data) {
    const prefix = `vc-domain-verify=${name}.${config.zone},`;
    if (hasDeploy) errors.push('"vercel" cannot be used with "deploy" (hosted sites are verified by Cloudflare)');
    else if (typeof data.vercel !== 'string' || !data.vercel.startsWith(prefix) || !/^[a-z0-9]{1,128}$/i.test(data.vercel.slice(prefix.length))) {
      errors.push(`"vercel" must be the TXT value Vercel shows for _vercel.${config.zone}, like "vc-domain-verify=${name}.${config.zone},<code>"`);
    }
  }
  return { errors, warnings };
}

export const withDeployDefaults = (d) => ({ ...DEPLOY_DEFAULTS, ...d, build: (d.build ?? '').trim() });

// ---------- hosted repo limits (Cloudflare Pages) ----------

export const PAGES_LIMITS = { files: 20000, fileBytes: 25 * 1024 * 1024 };

// Problems with a GitHub git tree (GET /git/trees/{sha}?recursive=1) that would make the deploy fail.
export function repoTreeProblems(tree, deploy) {
  const errors = [];
  const warnings = [];
  const d = withDeployDefaults(deploy);
  const hasBuild = d.build !== '';
  const dir = posix.normalize(hasBuild ? d.root : posix.join(d.root, d.output)).replace(/\/+$/, '') || '.';
  const prefix = dir === '.' ? '' : `${dir}/`;
  const files = (tree?.tree ?? []).filter((e) => e.type === 'blob' && e.mode !== '120000' && e.path.startsWith(prefix));
  const big = files.filter((e) => e.size > PAGES_LIMITS.fileBytes).map((e) => e.path);
  const list = `${big.slice(0, 5).join(', ')}${big.length > 5 ? ` and ${big.length - 5} more` : ''}`;
  if (hasBuild) {
    if (big.length) warnings.push(`files larger than 25 MiB will fail the deploy if the build copies them into the output: ${list}`);
  } else {
    if (big.length) errors.push(`files larger than 25 MiB cannot be hosted on Cloudflare Pages: ${list}`);
    if (!tree?.truncated && files.length === 0) errors.push(`no files found in "${dir}" to deploy (check deploy.root and deploy.output)`);
    else if (!tree?.truncated && files.length > PAGES_LIMITS.files) errors.push(`${files.length} files in "${dir}", Cloudflare Pages allows at most ${PAGES_LIMITS.files}`);
  }
  if (tree?.truncated) warnings.push('repository is too large to check every file before the build');
  return { errors, warnings };
}

// ---------- cross-file validation ----------

// Number of DNS records a domain file turns into (a hosted app is one CNAME).
export function recordCount(data) {
  if (isObj(data?.deploy)) return 1;
  if (!isObj(data?.records)) return 0;
  return Object.values(data.records).reduce((n, v) => n + (Array.isArray(v) ? v.length : 1), 'vercel' in data ? 1 : 0);
}

const ownerOf = (data) => (typeof data?.owner?.github === 'string' ? data.owner.github.toLowerCase() : undefined);

export function validateAll(domains, config, reserved = []) {
  const errors = [];
  const warnings = [];
  const valid = new Set();
  for (const [name, data] of domains) {
    const r = validateDomain(name, data, { config, reserved });
    for (const message of r.errors) errors.push({ name, message });
    for (const message of r.warnings) warnings.push({ name, message });
    if (!r.errors.length) valid.add(name);
  }

  for (const [name, data] of domains) {
    if (isTopLevel(name)) continue;
    const labels = name.split('.');
    if (!domains.has(labels.at(-1))) {
      errors.push({ name, message: `the top-level name "${labels.at(-1)}" must be registered (by the same owner) before nested names` });
    }
    for (let i = 1; i < labels.length; i++) {
      const parent = labels.slice(i).join('.');
      if (domains.has(parent) && ownerOf(domains.get(parent)) !== ownerOf(data)) {
        errors.push({ name, message: `"${parent}" belongs to a different owner` });
      }
    }
  }

  const maintainers = new Set(config.maintainers.map((m) => m.toLowerCase()));
  const perOwner = new Map();
  for (const [name, data] of domains) {
    const owner = ownerOf(data);
    if (!owner || !isTopLevel(name) || maintainers.has(owner)) continue;
    perOwner.set(owner, [...(perOwner.get(owner) ?? []), name]);
  }
  for (const [owner, names] of perOwner) {
    if (names.length <= config.maxDomainsPerUser) continue;
    for (const name of names) errors.push({ name, message: `@${owner} exceeds the limit of ${config.maxDomainsPerUser} top-level domains` });
  }

  // Nested names do not count as apps, but every record uses up the zone's shared record quota.
  const records = new Map();
  for (const [name, data] of domains) {
    const owner = ownerOf(data);
    if (!owner || maintainers.has(owner)) continue;
    const entry = records.get(owner) ?? { count: 0, names: [] };
    entry.count += recordCount(data);
    entry.names.push(name);
    records.set(owner, entry);
  }
  for (const [owner, { count, names }] of records) {
    if (count <= config.maxRecordsPerUser) continue;
    for (const name of names) errors.push({ name, message: `@${owner} exceeds the limit of ${config.maxRecordsPerUser} DNS records (has ${count})` });
  }

  const slugs = new Map();
  for (const [name, data] of domains) {
    if (!isObj(data?.deploy)) continue;
    const slug = slugFor(name, config.pagesPrefix);
    if (slugs.has(slug)) errors.push({ name, message: `project name "${slug}" collides with "${slugs.get(slug)}"` });
    else slugs.set(slug, name);
  }
  return { errors, warnings, valid };
}

// ---------- Pages project names ----------

// Pages project names: [a-z0-9-], max 58. Plain slugs never contain "---" (labels
// cannot start or end with "-"), so hashed slugs use "---" and cannot collide with them.
export function slugFor(name, prefix = 'ismy-') {
  const lower = name.toLowerCase();
  const plain = prefix + lower.replace(/\./g, '--');
  const simple = /^[a-z0-9.-]+$/.test(lower) && !lower.split('.').some((l) => l.includes('--'));
  if (simple && plain.length <= 58) return plain;
  const hash = createHash('sha256').update(lower).digest('hex').slice(0, 8);
  const body = plain.slice(prefix.length).replace(/[^a-z0-9-]/g, '-').slice(0, 58 - prefix.length - 3 - hash.length).replace(/-+$/, '');
  return `${prefix}${body}---${hash}`;
}

// ---------- desired DNS state ----------

export function deployEntries(domains, config) {
  return [...domains]
    .filter(([, data]) => isObj(data?.deploy))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, data]) => ({ name, project: slugFor(name, config.pagesPrefix), owner: data.owner.github, ...withDeployDefaults(data.deploy) }));
}

export function desiredRecords(domains, config, pagesSubdomainLookup = () => null) {
  const out = [];
  const rec = (type, name, content, proxied, priority) => ({
    type, name, content, proxied, ...(priority !== undefined && { priority }), ttl: 1, comment: MANAGED,
  });
  for (const [name, data] of [...domains].sort(([a], [b]) => a.localeCompare(b))) {
    const fqdn = `${name}.${config.zone}`;
    if (data.deploy) {
      const target = pagesSubdomainLookup(name);
      if (target) out.push(rec('CNAME', fqdn, normHost(target), true));
      continue;
    }
    const r = data.records;
    const proxied = data.proxied === true;
    if (r.CNAME) out.push(rec('CNAME', fqdn, normHost(r.CNAME), proxied));
    for (const ip of r.A ?? []) out.push(rec('A', fqdn, ip, proxied));
    for (const ip of r.AAAA ?? []) out.push(rec('AAAA', fqdn, canonicalIPv6(ip), proxied));
    (r.MX ?? []).forEach((mx, i) => {
      const { target, priority } = typeof mx === 'string' ? { target: mx, priority: 10 * (i + 1) } : mx;
      out.push(rec('MX', fqdn, normHost(target), false, priority));
    });
    for (const txt of [r.TXT ?? []].flat()) out.push(rec('TXT', fqdn, txt, false));
    if (data.vercel) out.push(rec('TXT', `_vercel.${config.zone}`, data.vercel, false));
  }
  return out;
}

// ---------- DNS diff ----------

export const isManaged = (r) => typeof r.comment === 'string' && r.comment.startsWith(MANAGED);

function contentKey(r) {
  let c = String(r.content);
  if (r.type === 'TXT') c = c.replace(/^"(.*)"$/s, '$1');
  else if (r.type === 'AAAA' && isIPv6(c)) c = canonicalIPv6(c);
  else if (r.type === 'CNAME' || r.type === 'MX') c = normHost(c);
  return `${c}|${r.type === 'MX' ? r.priority : ''}`;
}

const differs = (have, want) =>
  contentKey(have) !== contentKey(want) || Boolean(have.proxied) !== want.proxied || have.ttl !== want.ttl || (have.comment ?? '') !== want.comment;

/**
 * existing: Cloudflare DNS records; desired: output of desiredRecords.
 * protect: FQDNs whose managed records must never be deleted (e.g. deploys waiting for their Pages project).
 * Unmanaged records (no is-my.app:managed comment, including is-my.app:site) are never touched;
 * any name that has one is skipped entirely with a warning.
 */
export function planDnsChanges(existing, desired, { protect = [] } = {}) {
  const plan = { create: [], update: [], delete: [], warnings: [] };
  const managed = existing.filter(isManaged);
  const blocked = new Set(existing.filter((r) => !isManaged(r)).map((r) => r.name));
  const keep = new Set(protect);
  for (const name of new Set(desired.map((d) => d.name))) {
    if (blocked.has(name)) plan.warnings.push(`${name}: unmanaged DNS records exist at this name; skipping it`);
  }

  const groups = new Map();
  const group = (k) => groups.get(k) ?? groups.set(k, { have: [], want: [] }).get(k);
  for (const r of managed) if (!blocked.has(r.name)) group(`${r.name}\t${r.type}`).have.push(r);
  for (const d of desired) if (!blocked.has(d.name)) group(`${d.name}\t${d.type}`).want.push(d);

  for (const { have, want } of groups.values()) {
    const rest = [...have];
    const unmatched = [];
    for (const d of want) {
      const i = rest.findIndex((r) => contentKey(r) === contentKey(d));
      if (i < 0) { unmatched.push(d); continue; }
      const [r] = rest.splice(i, 1);
      if (differs(r, d)) plan.update.push({ id: r.id, before: r, after: d });
    }
    for (const d of unmatched) {
      const r = rest.shift();
      if (r) plan.update.push({ id: r.id, before: r, after: d });
      else plan.create.push(d);
    }
    for (const r of rest) if (!keep.has(r.name)) plan.delete.push(r);
  }
  return plan;
}
