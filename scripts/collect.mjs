#!/usr/bin/env node
// Collects allowlisted progress metadata from (private) project repositories and writes
// site/data/generated/site.json. It never copies source code: only titles, statuses,
// counts, dates, commit subjects, language byte totals and CI outcomes leave a repository.
//
//   node scripts/collect.mjs           GitHub API mode; needs GH_TOKEN (read-only, Contents)
//   node scripts/collect.mjs --local   reads the sibling checkouts named by localPath
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = JSON.parse(readFileSync(resolve(ROOT, 'config/projects.json'), 'utf8'));
const OUT = resolve(ROOT, 'site/data/generated/site.json');
const LOCAL = process.argv.includes('--local');
const TOKEN = process.env.GH_TOKEN;

if (!LOCAL && !TOKEN) {
  console.error('GH_TOKEN is not set. Use --local to read sibling checkouts instead.');
  process.exit(1);
}

// ---------------------------------------------------------------- sources

class GitHubSource {
  constructor(owner, repo) {
    this.base = `/repos/${owner}/${repo}`;
  }

  async api(path, raw = false) {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'portfolio-collector',
      },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub API ${res.status} for ${path}`);
    return raw ? res.text() : res.json();
  }

  async resolve(branch) {
    const b = await this.api(`${this.base}/branches/${encodeURIComponent(branch)}`);
    return b?.commit?.sha ?? null;
  }

  async branches() {
    this.branchCache ??= (async () => {
      const out = [];
      for (const b of (await this.api(`${this.base}/branches?per_page=100`)) ?? []) {
        const c = await this.api(`${this.base}/commits/${b.commit.sha}`);
        out.push({ name: b.name, sha: b.commit.sha, date: c?.commit?.committer?.date ?? null });
      }
      return out;
    })();
    return this.branchCache;
  }

  async files(ref) {
    const tree = await this.api(`${this.base}/git/trees/${ref}?recursive=1`);
    if (tree?.truncated) console.warn(`warning: tree for ${this.base} truncated`);
    return (tree?.tree ?? []).filter((e) => e.type === 'blob').map((e) => e.path);
  }

  read(ref, path) {
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    return this.api(`${this.base}/contents/${encoded}?ref=${ref}`, true);
  }

  async commits(ref, max) {
    const out = [];
    for (let page = 1; out.length < max; page++) {
      const batch = await this.api(`${this.base}/commits?sha=${ref}&per_page=100&page=${page}`);
      if (!batch?.length) break;
      for (const c of batch) {
        out.push({ sha: c.sha, date: c.commit.author.date, subject: c.commit.message.split('\n')[0] });
      }
      if (batch.length < 100) break;
    }
    return out.slice(0, max);
  }

  async languages() {
    return (await this.api(`${this.base}/languages`)) ?? {};
  }

  // Optional: needs "Actions: read" on the token; without it the site simply omits CI status.
  async ci() {
    const runs = await this.api(`${this.base}/actions/runs?per_page=1&exclude_pull_requests=true`).catch(() => null);
    const run = runs?.workflow_runs?.[0];
    return run ? { status: run.status, conclusion: run.conclusion, date: run.created_at } : null;
  }
}

const EXTENSIONS = {
  rs: 'Rust', py: 'Python', ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript',
  mjs: 'JavaScript', jsx: 'JavaScript', proto: 'Protocol Buffer', css: 'CSS', html: 'HTML',
  sh: 'Shell', ps1: 'PowerShell', go: 'Go', java: 'Java', cs: 'C#', cypher: 'Cypher',
  sql: 'SQL', toml: null, json: null, md: null, lock: null, yaml: null, yml: null,
};
const GENERATED = /(^|\/)(generated|node_modules|dist|target|vendor)\/|_pb2(_grpc)?\.pyi?$|_pb\.ts$/;

class LocalSource {
  constructor(path) {
    this.path = resolve(ROOT, path);
  }

  git(args) {
    return execFileSync('git', ['-C', this.path, ...args], {
      encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'],
    });
  }

  async resolve(branch) {
    for (const ref of [branch, `origin/${branch}`]) {
      try {
        return this.git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim();
      } catch { /* try the next candidate */ }
    }
    return null;
  }

  // Local and origin/* branches by short name, keeping whichever copy is newer.
  async branches() {
    const seen = new Map();
    const refs = this.git(['for-each-ref', '--format=%(refname:short)%09%(objectname)%09%(committerdate:iso-strict)',
      'refs/heads', 'refs/remotes/origin']);
    for (const line of refs.split('\n')) {
      const [ref, sha, date] = line.split('\t');
      if (!ref || !sha || ref === 'origin' || ref === 'origin/HEAD') continue;
      const name = ref.replace(/^origin\//, '');
      const prev = seen.get(name);
      if (!prev || Date.parse(date) > Date.parse(prev.date)) seen.set(name, { name, sha, date });
    }
    return [...seen.values()];
  }

  async files(ref) {
    return this.git(['ls-tree', '-r', '-z', '--name-only', ref]).split('\0').filter(Boolean);
  }

  async read(ref, path) {
    try {
      return this.git(['show', `${ref}:${path}`]);
    } catch {
      return null;
    }
  }

  async commits(ref, max) {
    return this.git(['log', ref, `-n${max}`, '--format=%H%x1f%aI%x1f%s%x1e'])
      .split('\x1e').map((s) => s.trim()).filter(Boolean)
      .map((line) => {
        const [sha, date, subject] = line.split('\x1f');
        return { sha, date, subject };
      });
  }

  // Approximates GitHub's language statistics from tracked file sizes by extension.
  async languages(ref) {
    const totals = {};
    for (const entry of this.git(['ls-tree', '-r', '-l', '-z', ref]).split('\0')) {
      const tab = entry.indexOf('\t');
      if (tab < 0) continue;
      const size = Number(entry.slice(0, tab).trim().split(/\s+/)[3]);
      const path = entry.slice(tab + 1);
      if (GENERATED.test(path)) continue;
      const lang = EXTENSIONS[path.split('.').pop().toLowerCase()];
      if (lang && Number.isFinite(size)) totals[lang] = (totals[lang] ?? 0) + size;
    }
    return totals;
  }

  async ci() {
    return null;
  }
}

function makeSource(repo) {
  return LOCAL ? new LocalSource(repo.localPath) : new GitHubSource(CONFIG.owner, repo.name);
}

// ---------------------------------------------------------------- sanitizing

const EXCLUDE = (CONFIG.commitFilter?.exclude ?? []).map(
  (p) => new RegExp(p, CONFIG.commitFilter.flags ?? ''),
);

// Plain text only: drop Markdown link targets and code ticks, redact anything that looks
// like an email address or a local filesystem path, and bound the length.
function clean(text, max = 160) {
  const s = String(text ?? '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`/g, '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/\b[A-Za-z]:\\[^\s]*/g, '[path]')
    .replace(/(^|\s)\/(home|Users|mnt)\/[^\s]*/g, '$1[path]')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ---------------------------------------------------------------- progress

function parseTitle(text, number) {
  const line = /^#\s+(.+)$/m.exec(text ?? '')?.[1] ?? `Task ${number}`;
  return clean(line.replace(new RegExp(`^(Task\\s+)?0*${number}\\s*[—–:-]\\s*`, 'i'), ''));
}

function taskStatus(number, registry) {
  const entry = registry?.tasks?.find((t) => t.number === number);
  if (entry?.status) return entry.status.replace(/[\s-]+/g, '_').toLowerCase();
  if (number <= (registry?.completed_through ?? -1)) return 'complete';
  if (number === registry?.next_task) return 'next';
  return 'planned';
}

function phaseStatus(tasks) {
  if (tasks.length && tasks.every((t) => t.status === 'complete')) return 'complete';
  if (tasks.some((t) => t.status !== 'planned')) return 'active';
  return 'planned';
}

function parseStatusTable(text, header) {
  const rows = [];
  let inTable = false;
  for (const line of (text ?? '').split(/\r?\n/)) {
    const cells = line.trim().startsWith('|') ? line.trim().slice(1, -1).split('|').map((c) => c.trim()) : null;
    if (!cells) {
      if (inTable) break;
      continue;
    }
    if (cells[0] === header) { inTable = true; continue; }
    if (!inTable || /^:?-+:?$/.test(cells[0])) continue;
    rows.push({ capability: clean(cells[0]), state: clean(cells[1]) });
  }
  return rows;
}

const excluder = (patterns) => {
  const res = (patterns ?? []).map((p) => new RegExp(p));
  return (name) => res.some((re) => re.test(name));
};

// "auto": among all non-excluded branches, read the task registry that shows the most
// progress (completed_through, then the newest commit). Registries only move forward on
// the active phase branch, so this follows you onto new phase branches without config edits.
async function pickProgressRef(source, cfg) {
  if (cfg.branch !== 'auto') return { ref: await source.resolve(cfg.branch), branch: cfg.branch };
  const excluded = excluder(cfg.branchExclude);
  let best = null;
  for (const b of await source.branches()) {
    if (excluded(b.name)) continue;
    const text = await source.read(b.sha, cfg.registry);
    if (!text) continue;
    let done = -1;
    try { done = JSON.parse(text).completed_through ?? -1; } catch { continue; }
    const better = !best || done > best.done || (done === best.done && Date.parse(b.date) > Date.parse(best.date));
    if (better) best = { ref: b.sha, branch: b.name, done, date: b.date };
  }
  return best ?? { ref: null, branch: null };
}

async function collectProgress(source, cfg, commits) {
  const { ref, branch } = await pickProgressRef(source, cfg);
  if (!ref) {
    console.warn(`warning: no branch with ${cfg.registry} found`);
    return null;
  }
  console.log(`  progress from ${branch}`);
  const files = await source.files(ref);
  const registryText = await source.read(ref, cfg.registry);
  const registry = registryText ? JSON.parse(registryText) : null;

  const phaseNames = { ...(cfg.phases ?? {}) };
  const phaseNumbers = new Set();
  if (cfg.phaseReadmePattern) {
    const re = new RegExp(cfg.phaseReadmePattern);
    for (const f of files) {
      const m = re.exec(f);
      if (!m) continue;
      phaseNumbers.add(Number(m[1]));
      if (phaseNames[m[1]]) continue;
      const title = /^#[ \t]+[^\n]*?Phase[ \t]+\d+\b[^—–\n-]*[—–-][ \t]*([^\n]+)$/m.exec((await source.read(ref, f)) ?? '');
      if (title) phaseNames[m[1]] = clean(title[1]);
    }
  }

  const taskRe = new RegExp(cfg.taskPattern);
  const tasks = [];
  for (const f of files) {
    const m = taskRe.exec(f);
    if (!m) continue;
    const phase = Number(m[1]);
    const number = Number(m[2]);
    const text = (await source.read(ref, f)) ?? '';
    phaseNumbers.add(phase);
    if (!phaseNames[phase]) {
      const named = /^>?[ \t]*Phase:[ \t]*\d+[ \t]*[—–-][ \t]*([^\n]+)$/m.exec(text);
      if (named) phaseNames[phase] = clean(named[1]);
    }
    const status = taskStatus(number, registry);
    const mention = new RegExp(`\\bTask\\s+0*${number}\\b`, 'i');
    const touched = status === 'complete' ? commits.find((c) => mention.test(c.subject)) : null;
    tasks.push({ number, phase, title: parseTitle(text, number), status, date: touched?.date ?? null });
  }
  tasks.sort((a, b) => a.number - b.number);

  const phases = [...phaseNumbers].sort((a, b) => a - b).map((n) => {
    const own = tasks.filter((t) => t.phase === n);
    return {
      number: n,
      name: phaseNames[n] ?? `Phase ${n}`,
      milestone: cfg.milestoneForPhase?.[n] ?? null,
      status: phaseStatus(own),
      tasks: own.map(({ phase, ...t }) => t),
    };
  });

  let decisions = [];
  if (cfg.decisionPattern) {
    const re = new RegExp(cfg.decisionPattern);
    for (const f of files.filter((p) => re.test(p))) {
      const text = (await source.read(ref, f)) ?? '';
      const title = /^#\s+(ADR-\d+)\s*[—–:-]\s*(.+)$/m.exec(text);
      const status = /^Status:\s*([A-Za-z]+)/m.exec(text)?.[1]?.toLowerCase() ?? null;
      if (title) decisions.push({ id: title[1], title: clean(title[2]), status });
    }
    decisions.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  }

  const statusTable = cfg.statusTable
    ? parseStatusTable(await source.read(ref, cfg.statusTable.path), cfg.statusTable.header)
    : [];

  const done = tasks.filter((t) => t.status === 'complete').length;
  const current = tasks.find((t) => t.status === 'in_progress') ?? tasks.find((t) => t.status === 'next') ?? null;
  // The phase being worked on: the current task's phase, else the last phase with any progress.
  const phaseNow = phases.find((p) => p.number === current?.phase)
    ?? [...phases].reverse().find((p) => p.status !== 'planned')
    ?? phases[0];
  return {
    completedThrough: registry?.completed_through ?? null,
    nextTask: registry?.next_task ?? null,
    tasksComplete: done,
    tasksKnown: tasks.length,
    current,
    currentPhase: phaseNow && {
      number: phaseNow.number,
      name: phaseNow.name,
      position: phases.indexOf(phaseNow) + 1,
      tasksComplete: phaseNow.tasks.filter((t) => t.status === 'complete').length,
      tasksKnown: phaseNow.tasks.length,
    },
    phasesKnown: phases.length,
    phasesComplete: phases.filter((p) => p.status === 'complete').length,
    phases,
    decisions,
    statusTable,
  };
}

// ---------------------------------------------------------------- per project

function weeklyActivity(commits, weeks) {
  const now = Date.now();
  const week = 7 * 24 * 3600 * 1000;
  const counts = Array(weeks).fill(0);
  for (const c of commits) {
    const age = Math.floor((now - Date.parse(c.date)) / week);
    if (age >= 0 && age < weeks) counts[weeks - 1 - age]++;
  }
  return { weekEnding: new Date(now).toISOString(), counts };
}

async function collectProject(project) {
  const max = CONFIG.maxCommitsPerBranch;
  const seen = new Map();
  const languages = {};
  let ci = null;
  let capped = false;
  const sources = {};

  for (const repo of project.repos) {
    const source = makeSource(repo);
    sources[repo.name] = source;
    // "all": every branch except branchExclude, newest first, so new branches need no config.
    const excluded = excluder(repo.branchExclude);
    const heads = repo.branches === 'all'
      ? (await source.branches())
        .filter((b) => !excluded(b.name))
        .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
        .map((b) => ({ branch: b.name, head: b.sha }))
      : await Promise.all(repo.branches.map(async (branch) => ({ branch, head: await source.resolve(branch) })));
    let ref = null;
    for (const { branch, head } of heads) {
      if (!head) {
        console.warn(`warning: ${repo.name}@${branch} not found`);
        continue;
      }
      ref ??= head;
      const list = await source.commits(head, max);
      if (list.length >= max) capped = true;
      for (const c of list) if (!seen.has(c.sha)) seen.set(c.sha, { ...c, repo: repo.label ?? repo.name });
    }
    if (ref) {
      for (const [lang, bytes] of Object.entries(await source.languages(ref))) {
        languages[lang] = (languages[lang] ?? 0) + bytes;
      }
    }
    ci ??= await source.ci();
  }

  const commits = [...seen.values()].sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  // Rewritten history (rebases, archive branches) can repeat a subject under new SHAs.
  const shown = new Set();
  const visible = commits
    .filter((c) => !EXCLUDE.some((re) => re.test(c.subject)))
    .filter((c) => !shown.has(`${c.repo}\0${c.subject}`) && shown.add(`${c.repo}\0${c.subject}`))
    .slice(0, CONFIG.recentCommits)
    .map((c) => ({ sha: c.sha.slice(0, 7), date: c.date, subject: clean(c.subject, 120), repo: c.repo }));

  const progress = project.progress
    ? await collectProgress(sources[project.progress.repo], project.progress, commits)
    : null;

  const totalBytes = Object.values(languages).reduce((a, b) => a + b, 0) || 1;
  return {
    id: project.id,
    name: project.name,
    tagline: project.tagline,
    summary: project.summary,
    stack: project.stack ?? [],
    highlights: project.highlights ?? [],
    roadmap: project.roadmap ?? [],
    diagram: project.diagram ?? null,
    repoCount: project.repos.length,
    stats: {
      commits: commits.length,
      commitsCapped: capped,
      firstCommit: commits.at(-1)?.date ?? null,
      lastCommit: commits[0]?.date ?? null,
    },
    activity: weeklyActivity(commits, CONFIG.activityWeeks),
    recentCommits: visible,
    languages: Object.entries(languages)
      .sort((a, b) => b[1] - a[1])
      .map(([name, bytes]) => ({ name, share: Math.round((bytes / totalBytes) * 1000) / 10 })),
    ci,
    progress,
  };
}

const projects = [];
for (const project of CONFIG.projects) {
  console.log(`collecting ${project.name}…`);
  projects.push(await collectProject(project));
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify({ generatedAt: new Date().toISOString(), mode: LOCAL ? 'local' : 'github', projects }, null, 2)}\n`);
console.log(`wrote ${OUT}`);
