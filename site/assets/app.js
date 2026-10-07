// Renders the portfolio from data/profile.json (hand-written) and
// data/generated/site.json (written by scripts/collect.mjs). All repository-derived text
// is inserted as text nodes, never as HTML.

const STATUS_LABEL = {
  complete: 'Complete', active: 'In progress', in_progress: 'In progress', next: 'Up next',
  planned: 'Planned', success: 'Passing', failure: 'Failing',
};

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

const isSet = (v) => typeof v === 'string' && v.trim() && !v.startsWith('TODO');
const safeUrl = (u) => isSet(u) && /^(https?:|mailto:|[\w./-]+$)/.test(u);

function linkItem({ label, url }) {
  return h('li', {}, safeUrl(url)
    ? h('a', { href: url, rel: url.startsWith('http') ? 'noopener' : null }, label)
    : h('span', { title: 'Not set yet — edit site/data/profile.json' }, label));
}

const dateFmt = new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: 'numeric' });
const rel = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

function fmtDate(iso) {
  return iso ? dateFmt.format(new Date(iso)) : '—';
}

function ago(iso) {
  if (!iso) return '—';
  const days = Math.round((Date.parse(iso) - Date.now()) / 86400000);
  if (Math.abs(days) < 1) return 'today';
  if (Math.abs(days) < 45) return rel.format(days, 'day');
  if (Math.abs(days) < 540) return rel.format(Math.round(days / 30), 'month');
  return rel.format(Math.round(days / 365), 'year');
}

function chip(status) {
  return h('span', { class: `chip ${status}` }, STATUS_LABEL[status] ?? status);
}

function progressBar(p, label = 'Tasks complete') {
  if (!p?.tasksKnown) return null;
  const pct = Math.round((p.tasksComplete / p.tasksKnown) * 100);
  return h('div', { class: 'progress' },
    h('div', { class: 'progress-label' },
      h('span', {}, label), h('span', {}, `${p.tasksComplete} / ${p.tasksKnown} · ${pct}%`)),
    h('div', {
      class: 'bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': p.tasksKnown,
      'aria-valuenow': p.tasksComplete, 'aria-label': label,
    }, h('span', { style: `width:${pct}%` })));
}

// One series of weekly commit counts: single hue, bars rounded at the top, a native
// tooltip on each bar, and the total stated in text beside it.
function sparkline(activity) {
  const ns = 'http://www.w3.org/2000/svg';
  const counts = activity?.counts ?? [];
  const max = Math.max(1, ...counts);
  const w = 8;
  const gap = 2;
  const height = 44;
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'spark');
  svg.setAttribute('viewBox', `0 0 ${counts.length * (w + gap)} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  const total = counts.reduce((a, b) => a + b, 0);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${total} commits over the last ${counts.length} weeks`);
  const end = Date.parse(activity?.weekEnding ?? new Date().toISOString());
  counts.forEach((n, i) => {
    const bh = n ? Math.max(4, (n / max) * height) : 2;
    const rect = document.createElementNS(ns, 'rect');
    rect.setAttribute('x', i * (w + gap));
    rect.setAttribute('y', height - bh);
    rect.setAttribute('width', w);
    rect.setAttribute('height', bh);
    rect.setAttribute('rx', n ? 2 : 1);
    if (!n) rect.setAttribute('class', 'zero');
    const title = document.createElementNS(ns, 'title');
    const weekStart = new Date(end - (counts.length - i) * 7 * 86400000);
    title.textContent = `Week of ${fmtDate(weekStart.toISOString())}: ${n} commit${n === 1 ? '' : 's'}`;
    rect.append(title);
    svg.append(rect);
  });
  return h('figure', { style: 'margin:0' },
    svg, h('figcaption', { class: 'muted small' }, `${total} commits in the last ${counts.length} weeks`));
}

function bindProfile(profile) {
  for (const el of document.querySelectorAll('[data-bind]')) {
    const v = profile[el.dataset.bind];
    if (isSet(v)) el.textContent = v;
    else if (el.tagName !== 'A') el.textContent = v ?? '';
  }
  if (isSet(profile.name)) document.title = document.body.dataset.page === 'home' ? profile.name : document.title;
}

function footer(site, profile) {
  const slot = document.querySelector('[data-slot="footer"]');
  if (!slot) return;
  slot.replaceChildren(
    h('p', {}, `Progress data refreshed automatically from the project repositories · last update ${site ? fmtDate(site.generatedAt) + ' (' + ago(site.generatedAt) + ')' : 'unavailable'}.`),
    h('p', {}, `© ${new Date().getFullYear()} ${isSet(profile.name) ? profile.name : ''}`));
}

// ---------------------------------------------------------------- home

function projectCard(p) {
  const href = `project.html?id=${encodeURIComponent(p.id)}`;
  const cur = p.progress?.current;
  return h('article', { class: 'card' },
    h('div', {},
      h('h3', {}, h('a', { href }, p.name)),
      h('p', { class: 'muted small' },
        `Last active ${ago(p.stats.lastCommit)} · ${p.stats.commits}${p.stats.commitsCapped ? '+' : ''} commits since ${fmtDate(p.stats.firstCommit)}`)),
    h('p', {}, p.tagline),
    progressBar(p.progress),
    cur && h('p', { class: 'small' }, chip(cur.status), ' ', `Task ${cur.number}: ${cur.title}`),
    sparkline(p.activity),
    h('ul', { class: 'tags', 'aria-label': 'Stack' }, p.stack.map((s) => h('li', {}, s))),
    h('a', { class: 'more', href }, `Explore ${p.name} →`));
}

function renderHome(profile, site) {
  document.querySelector('[data-slot="links"]').replaceChildren(...profile.links.map(linkItem));
  document.querySelector('[data-slot="contact"]').replaceChildren(
    ...profile.links.filter((l) => l.label !== 'GitHub').map(linkItem),
    linkItem({ label: 'Request code access', url: profile.codeAccessUrl }));
  document.querySelector('[data-slot="skills"]').replaceChildren(...(profile.skills ?? []).map((g) =>
    h('div', {}, h('h3', {}, g.group), h('ul', { class: 'tags' }, g.items.map((i) => h('li', {}, i))))));

  const projectsSlot = document.querySelector('[data-slot="projects"]');
  if (!site) {
    projectsSlot.replaceChildren(h('p', { class: 'notice' },
      'Project data has not been generated yet. Run "node scripts/collect.mjs --local" (or let the GitHub Action run).'));
    return;
  }
  document.querySelector('[data-slot="updated"]').textContent = `Live data · updated ${ago(site.generatedAt)}`;
  projectsSlot.replaceChildren(...site.projects.map(projectCard));

  const feed = site.projects
    .flatMap((p) => p.recentCommits.map((c) => ({ ...c, project: p })))
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
    .slice(0, 15);
  document.querySelector('[data-slot="feed"]').replaceChildren(...feed.map((c) =>
    h('li', {},
      h('time', { datetime: c.date }, fmtDate(c.date)),
      h('div', {},
        h('div', { class: 'subject' }, c.subject),
        h('div', { class: 'meta' },
          h('a', { href: `project.html?id=${encodeURIComponent(c.project.id)}` }, c.project.name),
          c.repo !== c.project.name ? ` · ${c.repo}` : '', ' · ', h('span', { class: 'mono' }, c.sha))))));
}

// ---------------------------------------------------------------- project

function stat(value, label) {
  return h('div', { class: 'stat' }, h('b', {}, value), h('span', {}, label));
}

function section(title, ...body) {
  return h('section', {}, h('h2', {}, title), ...body);
}

async function inlineDiagram(path) {
  try {
    const res = await fetch(path);
    if (!res.ok) return null;
    const box = h('div', { class: 'diagram' });
    // The SVG is a first-party file from this repository, not repository-derived data.
    box.innerHTML = await res.text();
    return box;
  } catch {
    return null;
  }
}

async function renderProject(profile, site) {
  const slot = document.querySelector('[data-slot="project"]');
  const id = new URLSearchParams(location.search).get('id');
  const p = site?.projects.find((x) => x.id === id);
  if (!p) {
    slot.replaceChildren(h('p', { class: 'notice' }, 'Project not found. ', h('a', { href: './' }, 'Back to all projects')));
    return;
  }
  document.title = `${p.name}${isSet(profile.name) ? ` · ${profile.name}` : ''}`;
  const g = p.progress;

  const head = h('div', { class: 'project-head' },
    h('p', { class: 'eyebrow' }, 'Project'),
    h('h1', {}, p.name),
    h('p', { class: 'lede' }, p.tagline),
    h('p', {}, p.summary),
    h('ul', { class: 'tags' }, p.stack.map((s) => h('li', {}, s))),
    h('p', { class: 'notice' }, profile.codeAccessNote ?? '', ' ',
      safeUrl(profile.codeAccessUrl) ? h('a', { href: profile.codeAccessUrl }, 'Request access') : null));

  const ciState = p.ci?.conclusion === 'success' ? 'success' : p.ci?.conclusion ? 'failure' : null;
  const stats = h('div', { class: 'stats' },
    g && stat(`${g.tasksComplete}/${g.tasksKnown}`, 'tasks complete'),
    stat(`${p.stats.commits}${p.stats.commitsCapped ? '+' : ''}`, 'commits'),
    stat(ago(p.stats.lastCommit), 'last commit'),
    stat(fmtDate(p.stats.firstCommit), 'started'),
    ciState && h('div', { class: 'stat' }, h('b', {}, chip(ciState)), h('span', {}, `CI · ${ago(p.ci.date)}`)));

  const parts = [head, stats, h('div', { class: 'two-col' },
    h('div', {}, h('h2', {}, 'Progress'), progressBar(g, 'Planned tasks complete'),
      g?.current && h('p', {}, chip(g.current.status), ' ', h('b', {}, `Task ${g.current.number}: `), g.current.title)),
    h('div', {}, h('h2', {}, 'Activity'), sparkline(p.activity)))];

  if (p.highlights.length) {
    parts.push(section('Engineering highlights', h('ul', { class: 'highlights' }, p.highlights.map((x) => h('li', {}, x)))));
  }
  if (p.diagram) {
    const d = await inlineDiagram(p.diagram);
    if (d) parts.push(section('Architecture', h('p', { class: 'muted' }, 'Target design. See the status table below for what is implemented today.'), d));
  }
  if (p.roadmap.length && g) {
    const milestoneStatus = Object.fromEntries(g.phases.filter((ph) => ph.milestone).map((ph) => [ph.milestone, ph.status]));
    parts.push(section('Milestones', h('ol', { class: 'roadmap' }, p.roadmap.map((m) =>
      h('li', {}, h('b', {}, m.id), h('span', { class: 't' }, m.title), chip(milestoneStatus[m.id] ?? 'planned'))))));
  }
  if (g?.phases.length) {
    parts.push(section('Phases and tasks',
      h('p', { class: 'muted' }, 'Generated from the project\'s task registry on every update.'),
      h('div', { class: 'phases' }, g.phases.map((ph) => {
        const done = ph.tasks.filter((t) => t.status === 'complete').length;
        return h('details', { class: 'phase', open: ph.status === 'active' },
          h('summary', {}, h('b', {}, `Phase ${ph.number}`), h('span', {}, ph.name),
            h('span', { class: 'count' }, ph.tasks.length ? `${done}/${ph.tasks.length}` : 'scoping'), chip(ph.status)),
          ph.tasks.length ? h('ol', { class: 'tasks' }, ph.tasks.map((t) =>
            h('li', { class: g.current?.number === t.number ? 'current' : null },
              h('span', { class: 'num' }, String(t.number).padStart(3, '0')),
              h('span', {}, t.title, t.date ? h('span', { class: 'muted small' }, ` · ${fmtDate(t.date)}`) : null),
              chip(t.status)))) : h('p', { class: 'tasks muted small' }, 'Task breakdown not written yet.'));
      }))));
  }
  if (g?.statusTable.length) {
    parts.push(section('What exists today',
      h('p', { class: 'muted' }, 'Taken directly from the repository\'s status file, so the site never claims more than the code does.'),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Capability'), h('th', { scope: 'col' }, 'State'))),
        h('tbody', {}, g.statusTable.map((r) => h('tr', {}, h('td', {}, r.capability), h('td', {}, r.state))))))));
  }
  if (g?.decisions.length) {
    parts.push(section('Architecture decisions',
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Record'), h('th', { scope: 'col' }, 'Decision'), h('th', { scope: 'col' }, 'Status'))),
        h('tbody', {}, g.decisions.map((d) => h('tr', {}, h('td', { class: 'mono' }, d.id), h('td', {}, d.title), h('td', {}, d.status ?? '—'))))))));
  }
  const langs = p.languages.filter((l) => l.share >= 0.5);
  parts.push(h('div', { class: 'two-col' },
    section('Recent commits', h('ol', { class: 'feed' }, p.recentCommits.slice(0, 12).map((c) =>
      h('li', {}, h('time', { datetime: c.date }, fmtDate(c.date)),
        h('div', {}, h('div', { class: 'subject' }, c.subject),
          h('div', { class: 'meta' }, p.repoCount > 1 ? `${c.repo} · ` : '', h('span', { class: 'mono' }, c.sha))))))),
    section('Languages', h('p', { class: 'muted small' }, 'Share of source by size.'),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('tbody', {}, langs.map((l) => h('tr', {}, h('td', {}, l.name), h('td', { style: 'text-align:right' }, `${l.share}%`)))))))));

  slot.replaceChildren(...parts);
}

// ---------------------------------------------------------------- boot

async function loadJson(path) {
  try {
    const res = await fetch(path, { cache: 'no-cache' });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

const [profile, site] = await Promise.all([loadJson('data/profile.json'), loadJson('data/generated/site.json')]);
bindProfile(profile ?? {});
if (document.body.dataset.page === 'home') renderHome(profile ?? { links: [] }, site);
else await renderProject(profile ?? {}, site);
footer(site, profile ?? {});
