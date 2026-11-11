// Validates a pull request for pull_request_target. Runs from the BASE checkout and only
// reads the PR's files as data through the GitHub API; PR code is never executed.
import { writeFileSync } from 'node:fs';
import { Resolver } from 'node:dns/promises';
import { loadRepo, validateAll, normHost, repoTreeProblems } from './lib/domains.mjs';
import { annotate, setOutput, appendSummary, isMain } from './lib/gha.mjs';

export const MARKER = '<!-- is-my-app-bot -->';
const DOMAIN_FILE = /^domains\/([^/]+)\.json$/;
const DEFAULT_BRANCH = 'main';
const MAX_FILES = 20;
const MAX_BYTES = 16 * 1024;
// The compare API lists at most 300 files; a longer list could hide a file, so it is rejected.
const COMPARE_LIMIT = 300;
const MAX_LISTED = 30;

const { GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER } = process.env;

async function gh(path, { method = 'GET', body, raw = false, allow404 = false } = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'is-my-app-bot',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (allow404 && res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub ${method} ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  if (raw) return res.text();
  return res.status === 204 ? null : res.json();
}

async function ghAll(path) {
  const out = [];
  for (let page = 1; ; page++) {
    const batch = await gh(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    out.push(...batch);
    if (batch.length < 100) return out;
  }
}

// Why a git tree entry cannot be a domain file, or null if it can. Symlinks would pass
// through the contents API as their target but break loading on main.
export function entryProblem(entry) {
  if (!entry) return 'file not found in the pull request commit';
  if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) return 'must be a regular file (no symlinks or submodules)';
  if (entry.size > MAX_BYTES) return `file is larger than ${MAX_BYTES} bytes`;
  return null;
}

const resolver = new Resolver({ timeout: 4000, tries: 2 });
async function resolves(host) {
  for (const fn of ['resolve4', 'resolve6', 'resolveCname']) {
    try {
      if ((await resolver[fn](host)).length) return true;
    } catch {}
  }
  return false;
}

export const isReclaimedName = (accountCreated, lastChanged) => accountCreated > Date.parse(lastChanged);

/**
 * Pure core: apply PR changes on top of base domains and decide what is allowed.
 * changes: [{ name, status: 'added'|'modified'|'removed', data?, parseError? }]; otherFiles: non-domain paths.
 */
export function evaluate({ base, changes, otherFiles, author, config, reserved }) {
  const errors = [];
  const warnings = [];
  const who = author.toLowerCase();
  const isMaintainer = config.maintainers.some((m) => m.toLowerCase() === who);
  const ownerOf = (d) => (typeof d?.owner?.github === 'string' ? d.owner.github.toLowerCase() : undefined);

  if (!isMaintainer) {
    for (const f of otherFiles) errors.push({ name: null, message: `\`${f}\`: only files matching domains/<name>.json may be changed` });
    if (changes.length > MAX_FILES) errors.push({ name: null, message: `too many domain files changed (${changes.length}, max ${MAX_FILES})` });
  }

  const merged = new Map(base);
  for (const c of changes) {
    if (c.parseError) errors.push({ name: c.name, message: c.parseError });
    if (c.status === 'removed') merged.delete(c.name);
    else if (!c.parseError) merged.set(c.name, c.data);
    if (isMaintainer) continue;
    if (c.status !== 'added' && base.has(c.name) && ownerOf(base.get(c.name)) !== who) {
      errors.push({ name: c.name, message: `only @${base.get(c.name).owner?.github} (the current owner) can change or remove this domain` });
    }
    if (c.status === 'added' && !c.parseError && ownerOf(c.data) !== who) {
      errors.push({ name: c.name, message: `owner.github must be your GitHub username (@${author})` });
    }
    if (c.status === 'modified' && !c.parseError && base.has(c.name) && ownerOf(c.data) !== ownerOf(base.get(c.name))) {
      warnings.push({ name: c.name, message: `ownership is being transferred to @${c.data?.owner?.github}` });
    }
  }

  // Only errors that the PR introduces count, so an unrelated problem on main cannot block everyone.
  const key = (e) => `${e.name}\n${e.message}`;
  const before = new Set(validateAll(base, config, reserved).errors.map(key));
  const after = validateAll(merged, config, reserved);
  errors.push(...after.errors.filter((e) => !before.has(key(e))));
  warnings.push(...after.warnings.filter((w) => changes.some((c) => c.name === w.name)));

  const kinds = new Set();
  for (const c of changes) {
    const d = c.status === 'removed' ? base.get(c.name) : c.data;
    kinds.add(d && typeof d === 'object' && 'deploy' in d ? 'deploy' : 'records');
  }
  const mode = otherFiles.length || kinds.size > 1 ? 'mixed' : kinds.size ? [...kinds][0] : 'none';
  return { errors, warnings, merged, mode, isMaintainer };
}

// Neutralise HTML and @mentions coming from PR data.
const safe = (s) => String(s).replace(/</g, '&lt;').replace(/@(?=[\w-])/g, '@\u200b');

function summarize(d) {
  if (!d || typeof d !== 'object') return ['-', '-'];
  if (d.deploy) return ['deploy', d.deploy.repo];
  const r = d.records ?? {};
  const first = (v) => (Array.isArray(v) ? v[0] : v);
  const target = r.CNAME ?? first(r.A) ?? first(r.AAAA) ?? first(r.MX)?.target ?? first(r.MX) ?? first(r.TXT);
  return [Object.keys(r).join(', ') || '-', typeof target === 'string' ? target : '-'];
}

export function renderReport({ valid, mode, errors, warnings, changes, author, sha, zone, autoMerge = false }) {
  const lines = [MARKER, `### ${valid ? 'Validation passed' : 'Validation failed'}`, ''];
  lines.push(`Checked commit ${sha.slice(0, 7)} by @${author}.`, '');
  if (changes.length) {
    lines.push('| Domain | Change | Type | Target |', '| --- | --- | --- | --- |');
    const cell = (s) => `\`${safe(s).replace(/[`|\n\r]/g, '').slice(0, 80)}\``;
    for (const c of changes) {
      const [type, target] = summarize(c.status === 'removed' ? null : c.data);
      lines.push(`| ${cell(`${c.name}.${zone}`)} | ${c.status} | ${type} | ${cell(target)} |`);
    }
    lines.push('');
  }
  const fmt = (e) => `- ${e.name ? `\`${safe(e.name).slice(0, 80)}\`: ` : ''}${safe(e.message).slice(0, 300)}`;
  const list = (items) => [...items.slice(0, MAX_LISTED).map(fmt), ...(items.length > MAX_LISTED ? [`- ...and ${items.length - MAX_LISTED} more`] : [])];
  if (errors.length) lines.push('**Errors**', '', ...list(errors), '');
  if (warnings.length) lines.push('**Warnings**', '', ...list(warnings), '');
  if (valid) {
    lines.push(autoMerge && (mode === 'records' || mode === 'deploy')
      ? 'Everything looks good. This PR merges automatically, and your app goes live a few minutes later.'
      : 'Everything looks good. A maintainer will review this PR; changes go live a few minutes after merge.');
  } else {
    lines.push('Please fix the errors above and push again; this check re-runs automatically.');
  }
  return lines.join('\n');
}

async function upsertComment(body) {
  const comments = await ghAll(`/repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/comments`);
  const mine = comments.find((c) => c.user?.login === 'github-actions[bot]' && c.body?.includes(MARKER));
  if (mine) await gh(`/repos/${GITHUB_REPOSITORY}/issues/comments/${mine.id}`, { method: 'PATCH', body: { body } });
  else await gh(`/repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/comments`, { method: 'POST', body: { body } });
}

async function main() {
  for (const [k, v] of Object.entries({ GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER })) if (!v) throw new Error(`${k} is not set`);
  const { config, reserved, domains: base } = loadRepo();

  const pr = await gh(`/repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}`);
  const author = pr.user.login;
  const sha = pr.head.sha;
  // Everything below reads the commit `sha`, never "the PR's current head": the file list and the
  // contents must describe exactly the commit that auto-merge later pins with --match-head-commit.
  // PR commits from forks are reachable through the base repository.
  const cmp = await gh(`/repos/${GITHUB_REPOSITORY}/compare/${encodeURIComponent(pr.base.ref)}...${sha}`);
  const files = cmp.files ?? [];
  const tree = await gh(`/repos/${GITHUB_REPOSITORY}/git/trees/${sha}:domains`, { allow404: true });
  const entries = new Map((tree?.tree ?? []).map((e) => [`domains/${e.path}`, e]));

  const changes = [];
  const otherFiles = [];
  const addChange = async (path, status) => {
    const m = path.match(DOMAIN_FILE);
    if (!m) return otherFiles.push(path);
    const change = { name: m[1], status, path };
    if (status !== 'removed') {
      try {
        const problem = entryProblem(entries.get(path));
        if (problem) throw new Error(problem);
        change.data = JSON.parse(await gh(`/repos/${GITHUB_REPOSITORY}/git/blobs/${entries.get(path).sha}`, { raw: true }));
      } catch (e) {
        change.parseError = `could not parse: ${e.message}`;
      }
    }
    changes.push(change);
  };
  for (const f of files) {
    if (f.status === 'renamed') {
      await addChange(f.previous_filename, 'removed');
      await addChange(f.filename, 'added');
    } else {
      await addChange(f.filename, f.status === 'removed' ? 'removed' : f.status === 'added' || f.status === 'copied' ? 'added' : 'modified');
    }
  }
  // Git reports status against the merge base, which can be older than main. Ownership rules
  // must use main: a file that exists there is a modification, whatever git calls it.
  for (const c of changes) if (c.status !== 'removed') c.status = base.has(c.name) ? 'modified' : 'added';

  const result = evaluate({ base, changes, otherFiles, author, config, reserved });
  const { errors, warnings, mode, isMaintainer } = result;
  if (pr.base.ref !== DEFAULT_BRANCH) errors.push({ name: null, message: `pull requests must target \`${DEFAULT_BRANCH}\`` });
  if (files.length >= COMPARE_LIMIT || tree?.truncated) errors.push({ name: null, message: `too many files changed (max ${COMPARE_LIMIT - 1})` });

  if (!isMaintainer && changes.length) {
    const user = await gh(`/users/${encodeURIComponent(author)}`);
    const created = Date.parse(user.created_at);
    if (changes.some((c) => c.status !== 'removed') && (Date.now() - created) / 86_400_000 < config.minAccountAgeDays) {
      errors.push({ name: null, message: `your GitHub account must be at least ${config.minAccountAgeDays} days old` });
    }
    // Usernames are freed when an account is renamed or deleted, and anyone can take them. An account
    // created after a domain file last changed on main cannot be the account that owned it then.
    for (const c of changes) {
      if (c.status === 'added' || !base.has(c.name)) continue;
      const path = encodeURIComponent(`domains/${c.name}.json`);
      const [last] = await gh(`/repos/${GITHUB_REPOSITORY}/commits?path=${path}&sha=${DEFAULT_BRANCH}&per_page=1`);
      if (last && isReclaimedName(created, last.commit.committer.date)) {
        errors.push({ name: c.name, message: 'your account is newer than this domain, so it may be a reused username. Please open an issue and a maintainer will help' });
      }
    }
  }

  for (const c of changes) {
    if (c.status === 'removed' || c.parseError || errors.some((e) => e.name === c.name)) continue;
    const { records, deploy } = c.data;
    if (typeof records?.CNAME === 'string' && !(await resolves(normHost(records.CNAME)))) {
      warnings.push({ name: c.name, message: `CNAME target \`${records.CNAME}\` does not resolve right now` });
    }
    if (typeof deploy?.repo === 'string' && /^[\w-]+\/(?!\.\.?$)[\w.-]+$/.test(deploy.repo)) {
      const repo = await gh(`/repos/${deploy.repo}`, { allow404: true });
      if (!repo || repo.private || repo.visibility !== 'public') {
        errors.push({ name: c.name, message: `deploy.repo \`${deploy.repo}\` was not found or is not public` });
        continue;
      }
      const branch = deploy.branch ?? 'main';
      const head = await gh(`/repos/${deploy.repo}/branches/${encodeURIComponent(branch)}`, { allow404: true });
      if (!head) {
        errors.push({ name: c.name, message: `branch \`${branch}\` does not exist in \`${deploy.repo}\`` });
      } else {
        try {
          const found = repoTreeProblems(await gh(`/repos/${deploy.repo}/git/trees/${head.commit.sha}?recursive=1`), deploy);
          for (const message of found.errors) errors.push({ name: c.name, message });
          for (const message of found.warnings) warnings.push({ name: c.name, message });
        } catch (e) {
          warnings.push({ name: c.name, message: `could not list the files in \`${deploy.repo}\`: ${e.message}` });
        }
      }
      if (repo.archived) warnings.push({ name: c.name, message: `\`${deploy.repo}\` is archived` });
      if (repo.owner.login.toLowerCase() !== String(c.data.owner?.github).toLowerCase()) {
        warnings.push({ name: c.name, message: `\`${deploy.repo}\` is not owned by the domain owner` });
      }
    }
  }
  if (changes.length === 0 && otherFiles.length === 0) warnings.push({ name: null, message: 'this PR does not change any files' });

  const valid = errors.length === 0;
  const autoMerge = process.env.AUTO_MERGE === 'true';
  const report = renderReport({ valid, mode, errors, warnings, changes, author, sha, zone: config.zone, autoMerge });
  writeFileSync('pr-report.md', `${report}\n`);
  appendSummary(report);
  for (const e of errors.slice(0, MAX_LISTED)) annotate('error', e.message, e.name ? `domains/${e.name}.json` : undefined);
  for (const w of warnings.slice(0, MAX_LISTED)) annotate('warning', w.message, w.name ? `domains/${w.name}.json` : undefined);
  console.log(report);

  try {
    await upsertComment(report);
  } catch (e) {
    annotate('warning', `could not post PR comment: ${e.message}`);
  }
  setOutput('valid', String(valid));
  setOutput('mode', mode);
  setOutput('sha', sha);
  process.exit(valid ? 0 : 1);
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    annotate('error', e.stack ?? e.message);
    setOutput('valid', 'false');
    setOutput('mode', 'none');
    process.exit(1);
  });
}
