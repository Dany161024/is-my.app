// Build the GitHub Actions matrix of hosted sites to (re)deploy.
// PLAN_MODE: changed (BEFORE_SHA..AFTER_SHA) | stale | all | dns | name:<subdomain>
import { execFileSync } from 'node:child_process';
import { loadRepo, validateAll, deployEntries, repoTreeProblems } from './lib/domains.mjs';
import { annotate, setOutput, isMain } from './lib/gha.mjs';

const MAX_MATRIX = 256;
const ZERO_SHA = /^0*$/;

// Subdomain names whose domain file appears in `git diff --name-only` output.
export function changedNames(diffOutput) {
  const names = new Set();
  for (const line of diffOutput.split('\n')) {
    const m = line.trim().match(/^domains\/([^/]+)\.json$/);
    if (m) names.add(m[1]);
  }
  return names;
}

export function parseMode(raw) {
  const mode = (raw ?? '').trim() || 'all';
  if (['changed', 'stale', 'all', 'dns'].includes(mode)) return { mode };
  const m = mode.match(/^name:(.+)$/);
  if (m) return { mode: 'name', name: m[1].trim().toLowerCase() };
  throw new Error(`unknown PLAN_MODE "${mode}"`);
}

export function selectTargets(entries, { mode, name, changed }) {
  if (mode === 'dns') return [];
  if (mode === 'name') return entries.filter((e) => e.name === name);
  if (mode === 'changed') return entries.filter((e) => changed.has(e.name));
  return entries;
}

function gitDiff(before, after = 'HEAD') {
  if (!before || ZERO_SHA.test(before)) return null;
  try {
    return execFileSync('git', ['diff', '--name-only', before, after, '--', 'domains/'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    annotate('warning', `git diff ${before}..${after} failed; treating every deploy entry as changed`);
    return null;
  }
}

function headSha(repo, branch) {
  try {
    const out = execFileSync('git', ['ls-remote', `https://github.com/${repo}`, `refs/heads/${branch}`], {
      encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return out.split(/\s/)[0] || null;
  } catch {
    return null;
  }
}

// The repo's file list at `sha`, or null on any failure (the build then reports the real problem).
async function repoTree(repo, sha) {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/git/trees/${sha}?recursive=1`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'is-my-app-bot',
        ...(process.env.GITHUB_TOKEN && { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }),
      },
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function main() {
  const { config, reserved, domains } = loadRepo();
  const { valid } = validateAll(domains, config, reserved);
  const entries = deployEntries(new Map([...domains].filter(([n]) => valid.has(n))), config);
  const opts = parseMode(process.env.PLAN_MODE);

  if (opts.mode === 'changed') {
    const diff = gitDiff(process.env.BEFORE_SHA, process.env.AFTER_SHA || undefined);
    opts.changed = diff === null ? new Set(entries.map((e) => e.name)) : changedNames(diff);
  }
  if (opts.mode === 'name' && !entries.some((e) => e.name === opts.name)) {
    annotate('error', `"${opts.name}" is not a valid deploy entry`);
    process.exit(1);
  }

  let deployed = new Map();
  if (opts.mode === 'stale') {
    const cf = await import('./lib/cloudflare.mjs');
    const projects = await cf.listPagesProjects();
    deployed = new Map(projects.map((p) => [p.name, cf.deploymentCommit(p.canonical_deployment ?? p.latest_deployment)]));
  }

  const include = [];
  for (const e of selectTargets(entries, opts)) {
    const sha = headSha(e.repo, e.branch);
    if (!sha) {
      annotate('warning', `${e.name}: could not read ${e.repo}@${e.branch}; skipping`);
      continue;
    }
    if (opts.mode === 'stale' && deployed.get(e.project) === sha) continue;
    const tree = await repoTree(e.repo, sha);
    const { errors } = tree ? repoTreeProblems(tree, e) : { errors: [] };
    if (errors.length) {
      annotate('warning', `${e.name}: not deploying ${e.repo}@${sha.slice(0, 7)}: ${errors.join('; ')}`);
      continue;
    }
    include.push({ name: e.name, project: e.project, repo: e.repo, branch: e.branch, build: e.build, output: e.output, root: e.root, node: e.node, sha });
  }
  if (include.length > MAX_MATRIX) {
    annotate('warning', `${include.length} targets; deploying the first ${MAX_MATRIX} (the rest follow on the next scheduled run)`);
    include.length = MAX_MATRIX;
  }

  const matrix = JSON.stringify({ include });
  console.log(`Mode ${opts.mode}: ${include.length} target(s)`);
  for (const i of include) console.log(`  ${i.name} <- ${i.repo}@${i.branch} (${i.sha.slice(0, 7)}) as ${i.project}`);
  setOutput('matrix', matrix);
  setOutput('count', String(include.length));
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    annotate('error', e.stack ?? e.message);
    process.exit(1);
  });
}
