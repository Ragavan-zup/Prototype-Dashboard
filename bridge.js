#!/usr/bin/env node
// Zuper Prototype Dashboard — local bridge.
// Scans a parent folder, exposes each subfolder-with-.git as a project,
// and serves the dashboard + previews on http://localhost:5050.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const PORT = Number(process.env.PORT) || 5050;
// Monorepo mode: the bridge sits inside one git repo whose subfolders are projects
// and whose branches (named "<project>/<variant>") are versions of those projects.
const PARENT = process.env.PROTOTYPE_DIR
  ? path.resolve(process.env.PROTOTYPE_DIR.replace(/^~(?=$|\/)/, os.homedir()))
  : __dirname;

const DATA_DIR = path.join(__dirname, '_data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || null;
const SYNC_INTERVAL_MS = 5 * 60 * 1000;

fs.mkdirSync(PARENT, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Folder names at the monorepo root that are dashboard internals, not projects.
const RESERVED = new Set(['node_modules', '.git', '.sc', '__pycache__', 'dist', 'build', '.next', '.cache', '.turbo']);
const folderToSlug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Running Expo dev servers, keyed by project slug.
const expoProcs = new Map();

// ────────────────────────── git + fs helpers ──────────────────────────

function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout);
    });
  });
}

async function listBranches(repoPath) {
  try {
    const stdout = await runGit(
      ['for-each-ref',
       '--format=%(refname:short)|%(committerdate:iso-strict)|%(authorname)|%(objectname:short)|%(subject)',
       'refs/heads/'],
      repoPath
    );
    return stdout.trim().split('\n').filter(Boolean).map(line => {
      const [name, date, author, sha, ...rest] = line.split('|');
      return { name, lastCommit: date, author, sha, message: rest.join('|') };
    });
  } catch {
    return [];
  }
}

async function currentBranch(repoPath) {
  try {
    return (await runGit(['symbolic-ref', '--short', 'HEAD'], repoPath)).trim();
  } catch {
    return null;
  }
}

async function isWorkingTreeClean(repoPath) {
  try {
    const out = await runGit(['status', '--porcelain'], repoPath);
    return out.trim().length === 0;
  } catch {
    return false;
  }
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function detectType(repoPath) {
  let entries = [];
  try { entries = fs.readdirSync(repoPath); } catch { return 'unknown'; }
  if (entries.some(e => e.endsWith('.xcworkspace'))) return 'xcode';
  if (entries.some(e => e.endsWith('.xcodeproj'))) return 'xcode';
  if (entries.includes('Package.swift')) return 'spm';

  const pkg = readJsonSafe(path.join(repoPath, 'package.json'));
  if (pkg) {
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    if (deps['expo'] || deps['@expo/cli'] || pkg.name === 'expo') return 'expo';
    if (deps['react-native']) return 'react-native';
    if (deps['next']) return 'next';
    if (deps['vite']) return 'vite';
  }

  if (entries.includes('index.html')) return 'html';
  if (entries.some(e => /\.html?$/i.test(e))) return 'html';
  return 'unknown';
}

function findHtmlEntry(repoPath) {
  const candidates = ['index.html', 'public/index.html', 'src/index.html'];
  for (const c of candidates) {
    if (fs.existsSync(path.join(repoPath, c))) return c;
  }
  try {
    const top = fs.readdirSync(repoPath).find(e => /\.html?$/i.test(e));
    if (top) return top;
  } catch {}
  return null;
}

async function listProjects() {
  // The monorepo lives at PARENT itself. Subfolders are projects.
  if (!fs.existsSync(path.join(PARENT, '.git'))) {
    return { error: `No git repo at ${PARENT}. Run "git init" there.`, projects: [] };
  }
  const [cb, allBranches] = await Promise.all([currentBranch(PARENT), listBranches(PARENT)]);

  let dirs = [];
  try { dirs = fs.readdirSync(PARENT, { withFileTypes: true }); } catch { return { projects: [] }; }
  const projects = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    if (d.name.startsWith('.')) continue;
    if (RESERVED.has(d.name)) continue;
    const projPath = path.join(PARENT, d.name);
    const type = detectType(projPath);
    if (type === 'unknown') continue;
    const entry = type === 'html' ? findHtmlEntry(projPath) : null;
    const stat = fs.statSync(projPath);

    const slug = folderToSlug(d.name);
    const baseline = allBranches.find(b => b.name === 'main')
      || allBranches.find(b => b.name === 'master')
      || allBranches[0];
    // Variations are branches whose name starts with "<slug>/" (case-insensitive),
    // or the verbatim folder name with "/" suffix (e.g. "Instant Test/v2").
    const variations = allBranches.filter(b => {
      const ln = b.name.toLowerCase();
      return ln.startsWith(slug + '/') || ln.startsWith(d.name.toLowerCase() + '/');
    });
    const seen = new Set();
    const branches = [];
    if (baseline) { branches.push(baseline); seen.add(baseline.name); }
    for (const v of variations) {
      if (!seen.has(v.name)) { branches.push(v); seen.add(v.name); }
    }

    projects.push({
      slug: d.name,                    // folder name (used in URLs)
      name: d.name,
      branchSlug: slug,                // recommended branch prefix
      type,
      currentBranch: cb,
      branches,
      entry,
      updatedAt: stat.mtimeMs,
      expoUrl: expoProcs.get(d.name)?.url || null,
    });
  }
  return { projects, currentBranch: cb, parent: PARENT };
}

// ────────────────────────── projects store ──────────────────────────
// Persistent server-backed store for projects + heterogeneous versions
// (commit / url / file). Swap PROJECTS_FILE for the comp server later.

function loadStore() {
  try {
    const raw = fs.readFileSync(PROJECTS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.projects)) return { projects: [] };
    return parsed;
  } catch {
    return { projects: [] };
  }
}

function saveStore(store) {
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(store, null, 2));
}

function uid(prefix) {
  return prefix + '_' + crypto.randomBytes(6).toString('hex');
}

function nowMs() { return Date.now(); }

// Parse "owner/repo" out of a string like "https://github.com/owner/repo",
// "git@github.com:owner/repo.git", or just "owner/repo".
function parseGithubRepo(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (!s) return null;
  let m = s.match(/github\.com[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[/?#].*)?$/i);
  if (m) return { owner: m[1], repo: m[2] };
  m = s.match(/^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (m) return { owner: m[1], repo: m[2] };
  return null;
}

function ghHeaders() {
  const h = {
    'User-Agent': 'zuper-prototype-dashboard',
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (GITHUB_TOKEN) h['Authorization'] = 'Bearer ' + GITHUB_TOKEN;
  return h;
}

function ghRequest(pathAndQuery) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com',
      path: pathAndQuery,
      method: 'GET',
      headers: ghHeaders(),
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
        } else {
          const err = new Error(`GitHub ${res.statusCode}: ${buf.slice(0, 200)}`);
          err.status = res.statusCode;
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Fetch up to `limit` newest commits, optionally only those after `sinceSha` (exclusive).
async function fetchCommits(owner, repo, { limit = 30, sinceSha = null } = {}) {
  const perPage = Math.min(limit, 100);
  const data = await ghRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?per_page=${perPage}`);
  const out = [];
  for (const c of data) {
    if (sinceSha && c.sha === sinceSha) break;
    out.push({
      sha: c.sha,
      shortSha: c.sha.slice(0, 7),
      message: (c.commit?.message || '').split('\n')[0],
      author: c.commit?.author?.name || c.author?.login || 'unknown',
      authorLogin: c.author?.login || null,
      avatar: c.author?.avatar_url || null,
      date: c.commit?.author?.date || c.commit?.committer?.date,
      url: c.html_url,
    });
  }
  return out;
}

async function syncProjectGithub(project) {
  if (!project.githubRepo) return { added: 0, skipped: 'no repo' };
  const parsed = parseGithubRepo(project.githubRepo);
  if (!parsed) return { added: 0, skipped: 'unparseable repo' };
  const { owner, repo } = parsed;

  const commits = await fetchCommits(owner, repo, { limit: 30, sinceSha: project.lastSyncedSha });
  if (commits.length === 0) {
    project.lastSyncedAt = nowMs();
    return { added: 0 };
  }

  // Reverse so oldest gets the lower version number.
  commits.reverse();
  let added = 0;
  for (const c of commits) {
    if ((project.versions || []).some(v => v.meta?.sha === c.sha)) continue;
    const label = nextVersionLabel(project);
    const v = {
      id: uid('v'),
      label,
      name: c.message || c.shortSha,
      type: 'commit',
      status: 'published',
      description: c.message || '',
      uploadedBy: c.author || 'unknown',
      comments: [],
      createdAt: c.date ? new Date(c.date).getTime() : nowMs(),
      updatedAt: nowMs(),
      meta: {
        sha: c.sha,
        shortSha: c.shortSha,
        author: c.author,
        authorLogin: c.authorLogin,
        avatar: c.avatar,
        url: c.url,
        message: c.message,
        commitDate: c.date,
      },
    };
    project.versions = project.versions || [];
    project.versions.push(v);
    added++;
  }
  project.lastSyncedSha = commits[commits.length - 1].sha;
  project.lastSyncedAt = nowMs();
  project.updatedAt = nowMs();
  return { added };
}

function nextVersionLabel(project) {
  const labels = (project.versions || []).map(v => v.label || '');
  let major = 0, minor = 1;
  for (const l of labels) {
    const m = /^v(\d+)\.(\d+)$/.exec(l);
    if (m) {
      const M = +m[1], n = +m[2];
      if (M > major || (M === major && n >= minor)) { major = M; minor = n + 1; }
    }
  }
  return `v${major}.${minor}`;
}

let store = loadStore();

async function syncAllProjects() {
  const targets = store.projects.filter(p => p.githubRepo);
  if (targets.length === 0) return;
  let total = 0;
  for (const p of targets) {
    try {
      const { added } = await syncProjectGithub(p);
      total += added;
    } catch (err) {
      p.lastSyncError = err.message;
    }
  }
  if (total > 0 || targets.length > 0) saveStore(store);
  if (total > 0) console.log(`  ↻ GitHub sync: +${total} commit version(s) across ${targets.length} project(s)`);
}

function findProject(id) {
  return store.projects.find(p => p.id === id);
}

// ────────────────────────── upload helpers ──────────────────────────
// Files arrive as raw bodies on POST /api/projects/:id/versions/upload,
// with metadata in query string. Simpler and more reliable than multipart
// for the kinds of files (video/image) the user wants to attach.

function detectUrlKind(u) {
  if (!u) return 'link';
  try {
    const h = new URL(u).hostname.toLowerCase();
    if (h.includes('vercel.app') || h.includes('vercel.com')) return 'vercel';
    if (h.includes('netlify.app')) return 'netlify';
    if (h.includes('loom.com')) return 'loom';
    if (h.includes('youtube.com') || h.includes('youtu.be')) return 'youtube';
    if (h.includes('figma.com')) return 'figma';
    if (h.includes('github.com')) return 'github';
    if (h.includes('drive.google.com') || h.includes('docs.google.com')) return 'gdrive';
    return 'link';
  } catch { return 'link'; }
}

function safeFilename(name) {
  return String(name || 'upload')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'upload';
}

function readRawBody(req, maxBytes = 500 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error(`Upload too large (>${maxBytes} bytes)`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ────────────────────────── proxy + inspector ──────────────────────────
// Serve external pages through our origin so the dashboard's iframe can run
// element-inspection (hover outline, click to pick, flash to highlight) against
// them. Without this, cross-origin iframes block any DOM access.

function escapeBasic(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

// Script injected into proxied pages. Listens for postMessage from the
// dashboard parent and either:
//   * starts inspect mode (hover outline + tooltip; click picks an element)
//   * flashes an element matching a selector
// Sends back a `zuper:picked` message with the selector + rect + element info.
const INSPECTOR_SCRIPT = String.raw`
(function(){
  if (window.__zuperInspector) return; window.__zuperInspector = true;
  var active=false, overlay=null, tip=null, lastEl=null;

  function ensureUi(){
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.id = '__zuper_overlay';
    overlay.style.cssText = 'position:fixed;border:2px solid #fd5000;background:rgba(253,80,0,0.16);pointer-events:none;z-index:2147483646;border-radius:3px;transition:all 70ms ease;display:none;box-sizing:border-box;';
    document.documentElement.appendChild(overlay);
    tip = document.createElement('div');
    tip.id = '__zuper_tip';
    tip.style.cssText = 'position:fixed;background:#0f172a;color:#fff;font:600 11px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:0.02em;padding:4px 8px;border-radius:4px;z-index:2147483647;pointer-events:none;white-space:nowrap;display:none;box-shadow:0 4px 12px rgba(0,0,0,0.18);';
    document.documentElement.appendChild(tip);
  }

  function selectorFor(el){
    var path=[]; var cur=el;
    while (cur && cur.nodeType===1 && cur !== document.documentElement){
      var part = cur.tagName.toLowerCase();
      if (cur.id){ path.unshift('#' + (window.CSS && CSS.escape ? CSS.escape(cur.id) : cur.id)); break; }
      var p = cur.parentElement;
      if (p){
        var sibs = Array.prototype.filter.call(p.children, function(s){ return s.tagName === cur.tagName; });
        if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(cur)+1) + ')';
      }
      path.unshift(part);
      cur = p;
    }
    return path.join(' > ');
  }

  function describe(el){
    var tag = el.tagName.toLowerCase();
    var id  = el.id ? '#' + el.id : '';
    var cls = '';
    if (el.classList && el.classList.length){
      cls = '.' + Array.prototype.slice.call(el.classList, 0, 2).join('.');
    }
    return tag + id + cls;
  }

  function move(e){
    if (!active) return;
    var el = e.target;
    if (!el || el === overlay || el === tip) return;
    lastEl = el;
    var r = el.getBoundingClientRect();
    overlay.style.left = r.left + 'px';
    overlay.style.top = r.top + 'px';
    overlay.style.width = r.width + 'px';
    overlay.style.height = r.height + 'px';
    overlay.style.display = 'block';
    tip.textContent = describe(el) + ' · ' + Math.round(r.width) + '×' + Math.round(r.height);
    var top = r.top - 24;
    if (top < 4) top = r.top + r.height + 4;
    tip.style.left = Math.max(4, r.left) + 'px';
    tip.style.top  = top + 'px';
    tip.style.display = 'block';
  }
  function pick(e){
    if (!active) return;
    e.preventDefault(); e.stopPropagation();
    var el = lastEl || e.target;
    var r = el.getBoundingClientRect();
    var vw = Math.max(document.documentElement.clientWidth || 0, 1);
    var vh = Math.max(document.documentElement.clientHeight || 0, 1);
    var data = {
      type: 'zuper:picked',
      selector: selectorFor(el),
      describe: describe(el),
      text: (el.innerText || el.textContent || '').trim().slice(0,80),
      rect: { x:r.left, y:r.top, w:r.width, h:r.height },
      // Normalised viewport coords for fallback rendering on the parent side.
      x: (r.left + r.width/2) / vw,
      y: (r.top + r.height/2) / vh
    };
    stop();
    try { parent.postMessage(data, '*'); } catch(_){}
  }
  function keyCancel(e){
    if (e.key === 'Escape'){ stop(); try { parent.postMessage({type:'zuper:cancelled'}, '*'); } catch(_){} }
  }
  function start(){
    ensureUi();
    active = true;
    document.addEventListener('mousemove', move, true);
    document.addEventListener('click', pick, true);
    document.addEventListener('keydown', keyCancel, true);
    document.documentElement.style.cursor = 'crosshair';
  }
  function stop(){
    active = false;
    document.removeEventListener('mousemove', move, true);
    document.removeEventListener('click', pick, true);
    document.removeEventListener('keydown', keyCancel, true);
    document.documentElement.style.cursor = '';
    if (overlay) overlay.style.display = 'none';
    if (tip)     tip.style.display = 'none';
  }
  function drawFlashAt(el){
    var r = el.getBoundingClientRect();
    overlay.style.transition = 'none';
    overlay.style.left = r.left + 'px';
    overlay.style.top = r.top + 'px';
    overlay.style.width = r.width + 'px';
    overlay.style.height = r.height + 'px';
    overlay.style.display = 'block';
    try {
      overlay.animate(
        [{ opacity:0, transform:'scale(0.96)' },
         { opacity:1, transform:'scale(1)'   , offset: 0.18 },
         { opacity:0, transform:'scale(1.06)' }],
        { duration:1200, easing:'cubic-bezier(0.16,1,0.3,1)' }
      );
    } catch(_){}
    setTimeout(function(){ if (overlay) overlay.style.display = 'none'; }, 1200);
  }

  // Wait until the target element's position has been stable for ~2 polling
  // intervals (so smooth scrolling has finished and layout has settled), or
  // bail after a hard cap. Then draw the flash. This is more reliable than
  // a fixed setTimeout because scroll duration varies with distance.
  function waitForSettle(el, cb){
    var lastTop = null, lastLeft = null, sameCount = 0, ticks = 0;
    function tick(){
      var r = el.getBoundingClientRect();
      // Treat zero-rect (hidden / detached) as not-settled but bail-able.
      if (r.width === 0 && r.height === 0) {
        if (++ticks > 24) cb(); // ~1.2s — element never appears; let caller decide
        else setTimeout(tick, 50);
        return;
      }
      if (lastTop !== null && Math.abs(r.top - lastTop) < 0.5 && Math.abs(r.left - lastLeft) < 0.5) {
        if (++sameCount >= 2) { cb(); return; }
      } else {
        sameCount = 0;
      }
      lastTop = r.top; lastLeft = r.left;
      if (++ticks > 30) { cb(); return; } // ~1.5s hard cap
      setTimeout(tick, 50);
    }
    setTimeout(tick, 40);
  }

  function flash(selector){
    try {
      ensureUi();
      var el = document.querySelector(selector);
      if (!el) {
        try { parent.postMessage({ type:'zuper:not-found', selector: selector }, '*'); } catch(_){}
        return;
      }
      // Pre-check: is element actually visible? Hidden elements have a zero rect.
      var preRect = el.getBoundingClientRect();
      if (preRect.width === 0 && preRect.height === 0) {
        try { parent.postMessage({ type:'zuper:not-visible', selector: selector }, '*'); } catch(_){}
        return;
      }
      el.scrollIntoView({ block:'center', inline:'center', behavior:'smooth' });
      waitForSettle(el, function(){ drawFlashAt(el); });
    } catch(_){}
  }

  window.addEventListener('message', function(e){
    var d = e.data;
    if (!d || typeof d !== 'object') return;
    if (d.type === 'zuper:start')  start();
    else if (d.type === 'zuper:stop') stop();
    else if (d.type === 'zuper:flash') flash(d.selector);
  });

  try { parent.postMessage({ type:'zuper:ready' }, '*'); } catch(_){}
})();
`;

async function proxyHtml(target, { stripScripts = true } = {}) {
  const res = await fetch(target, {
    redirect: 'follow',
    headers: { 'User-Agent': 'Mozilla/5.0 (zuper-prototype-dashboard)' },
  });
  if (!res.ok && res.status >= 400) {
    throw new Error(`Target returned HTTP ${res.status}`);
  }
  let body = await res.text();
  const finalUrl = res.url || target;

  // Strip any meta-level CSP / XFO baked into the document.
  body = body.replace(/<meta[^>]+http-equiv\s*=\s*['"]?content-security-policy['"]?[^>]*>/gi, '');
  body = body.replace(/<meta[^>]+http-equiv\s*=\s*['"]?x-frame-options['"]?[^>]*>/gi, '');

  if (stripScripts) {
    // Remove all <script>…</script> blocks AND self-closing/empty script tags.
    // This prevents SPA hydration (which breaks on a different origin) from
    // crashing the page. Server-rendered HTML stays intact and inspectable.
    body = body.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    body = body.replace(/<script\b[^>]*\/?>/gi, '');
    // Preloads/prefetches that hint scripts can also kick things off.
    body = body.replace(/<link[^>]+rel\s*=\s*['"]?(?:modulepreload|preload)['"]?[^>]*as\s*=\s*['"]?script['"]?[^>]*>/gi, '');
    body = body.replace(/<link[^>]+as\s*=\s*['"]?script['"]?[^>]*>/gi, '');
    // Strip on-* attribute handlers from elements.
    body = body.replace(/\s+on[a-z]+\s*=\s*"(?:[^"\\]|\\.)*"/gi, '');
    body = body.replace(/\s+on[a-z]+\s*=\s*'(?:[^'\\]|\\.)*'/gi, '');
  }

  const baseTag = `<base href="${escapeBasic(finalUrl)}">`;
  const inspector = `<script>${INSPECTOR_SCRIPT}</script>`;
  // A small style block to hide common "no-JS" hidden states so the SSR
  // content shows even though JS isn't running.
  const noJsCss = `<style>noscript{display:contents!important}[hidden][data-state],[data-loading]{display:initial!important}</style>`;
  const head = `${baseTag}${inspector}${stripScripts ? noJsCss : ''}`;

  if (/<head[^>]*>/i.test(body)) {
    body = body.replace(/<head[^>]*>/i, m => m + head);
  } else if (/<html[^>]*>/i.test(body)) {
    body = body.replace(/<html[^>]*>/i, m => m + '<head>' + head + '</head>');
  } else {
    body = head + body;
  }
  return { status: res.status === 0 ? 200 : res.status, body };
}

// ────────────────────────── routes ──────────────────────────

const MIME = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  css:  'text/css; charset=utf-8',  js:  'text/javascript; charset=utf-8',
  mjs:  'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8',
  svg:  'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif:  'image/gif', webp: 'image/webp', ico: 'image/x-icon',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  mp4:  'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg',
  txt:  'text/plain; charset=utf-8', map: 'application/json',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
function sendJson(res, data, status = 200) {
  send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json' });
}
function notFound(res) { send(res, 404, 'Not found'); }
function forbidden(res) { send(res, 403, 'Forbidden'); }
async function readBody(req) {
  return new Promise(resolve => {
    let buf = '';
    req.on('data', c => buf += c);
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch { resolve({}); } });
  });
}

async function startExpo(slug, projPath) {
  if (expoProcs.has(slug) && expoProcs.get(slug).url) {
    return { url: expoProcs.get(slug).url };
  }
  return new Promise((resolve, reject) => {
    const proc = spawn('npx', ['expo', 'start', '--web', '--non-interactive'], {
      cwd: projPath,
      env: { ...process.env, BROWSER: 'none', CI: '1' },
    });
    const entry = { proc, url: null };
    expoProcs.set(slug, entry);
    let settled = false;
    const finish = (err, url) => {
      if (settled) return; settled = true;
      err ? reject(err) : resolve({ url });
    };
    const scan = (chunk) => {
      const text = chunk.toString();
      // Expo prints "Web is waiting on http://localhost:8081" or similar.
      const m = text.match(/https?:\/\/localhost:\d+(?:\/[^\s]*)?/);
      if (m && !entry.url) {
        entry.url = m[0];
        finish(null, m[0]);
      }
    };
    proc.stdout.on('data', scan);
    proc.stderr.on('data', scan);
    proc.on('exit', (code) => {
      expoProcs.delete(slug);
      if (!settled) finish(new Error(`expo exited (code ${code}) before web URL was ready`));
    });
    setTimeout(() => {
      if (!entry.url) {
        try { proc.kill(); } catch {}
        expoProcs.delete(slug);
        finish(new Error('expo start timed out after 90s'));
      }
    }, 90_000);
  });
}
function stopExpo(slug) {
  const x = expoProcs.get(slug);
  if (!x) return false;
  try { x.proc.kill(); } catch {}
  expoProcs.delete(slug);
  return true;
}

function safeJoin(base, rel) {
  const resolved = path.resolve(base, '.' + (rel.startsWith('/') ? rel : '/' + rel));
  if (!resolved.startsWith(base + path.sep) && resolved !== base) return null;
  return resolved;
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    if (p === '/api/health') {
      return sendJson(res, { ok: true, parent: PARENT, port: PORT, githubAuth: !!GITHUB_TOKEN });
    }

    // /proxy?url=<target>  — fetch a target URL server-side and serve it from our
    // origin so the dashboard's iframe can run an inspector script against it.
    if (p === '/proxy' && req.method === 'GET') {
      const target = url.searchParams.get('url');
      if (!target || !/^https?:\/\//i.test(target)) {
        return sendJson(res, { error: 'valid http(s) url required' }, 400);
      }
      try {
        const out = await proxyHtml(target, {
          stripScripts: url.searchParams.get('js') !== 'on',
        });
        res.writeHead(out.status, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          // Strip any framing restrictions inherited from the target — our origin owns this response.
        });
        return res.end(out.body);
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(`<!doctype html><meta charset="utf-8"><body style="font:14px ui-sans-serif,system-ui;padding:24px;color:#475569">
          <h2 style="color:#0f172a;margin:0 0 8px">Couldn't load preview</h2>
          <p>Proxy fetch failed: ${escapeBasic(err.message)}</p>
          <p><a href="${escapeBasic(target)}" target="_blank" style="color:#fd5000">Open the original in a new tab</a></p></body>`);
      }
    }
    if (p === '/api/projects' && req.method === 'GET') {
      return sendJson(res, await listProjects());
    }

    // ────── Cloud projects (server-backed; GitHub + URL + uploaded files) ──────
    if (p === '/api/cloud/projects' && req.method === 'GET') {
      return sendJson(res, { projects: store.projects, githubAuth: !!GITHUB_TOKEN });
    }
    if (p === '/api/cloud/projects' && req.method === 'POST') {
      const body = await readBody(req);
      const name = (body.name || '').trim();
      if (!name) return sendJson(res, { error: 'name required' }, 400);
      const project = {
        id: uid('p'),
        name,
        description: (body.description || '').trim(),
        icon: body.icon || 'rocket',
        cover: body.cover || 'orange',
        owner: (body.owner || '').trim() || 'You',
        githubRepo: body.githubRepo ? parseGithubRepo(body.githubRepo) ? `${parseGithubRepo(body.githubRepo).owner}/${parseGithubRepo(body.githubRepo).repo}` : null : null,
        createdAt: nowMs(),
        updatedAt: nowMs(),
        lastSyncedSha: null,
        lastSyncedAt: null,
        versions: [],
      };
      store.projects.push(project);
      saveStore(store);
      if (project.githubRepo) {
        try { await syncProjectGithub(project); saveStore(store); } catch (err) { project.lastSyncError = err.message; saveStore(store); }
      }
      return sendJson(res, { project });
    }

    let cm = p.match(/^\/api\/cloud\/projects\/([^/]+)$/);
    if (cm && req.method === 'DELETE') {
      const id = decodeURIComponent(cm[1]);
      const i = store.projects.findIndex(x => x.id === id);
      if (i < 0) return notFound(res);
      const proj = store.projects[i];
      const dir = path.join(UPLOADS_DIR, proj.id);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      store.projects.splice(i, 1);
      saveStore(store);
      return sendJson(res, { ok: true });
    }
    if (cm && req.method === 'PATCH') {
      const id = decodeURIComponent(cm[1]);
      const proj = findProject(id);
      if (!proj) return notFound(res);
      const body = await readBody(req);
      if (typeof body.name === 'string') proj.name = body.name.trim() || proj.name;
      if (typeof body.description === 'string') proj.description = body.description;
      if (typeof body.icon === 'string') proj.icon = body.icon;
      if (typeof body.cover === 'string') proj.cover = body.cover;
      if (typeof body.owner === 'string') proj.owner = body.owner;
      if (typeof body.githubRepo !== 'undefined') {
        const parsed = body.githubRepo ? parseGithubRepo(body.githubRepo) : null;
        proj.githubRepo = parsed ? `${parsed.owner}/${parsed.repo}` : null;
        proj.lastSyncedSha = null;
      }
      proj.updatedAt = nowMs();
      saveStore(store);
      return sendJson(res, { project: proj });
    }

    cm = p.match(/^\/api\/cloud\/projects\/([^/]+)\/sync$/);
    if (cm && req.method === 'POST') {
      const id = decodeURIComponent(cm[1]);
      const proj = findProject(id);
      if (!proj) return notFound(res);
      try {
        const result = await syncProjectGithub(proj);
        saveStore(store);
        return sendJson(res, { ok: true, ...result, project: proj });
      } catch (err) {
        proj.lastSyncError = err.message;
        saveStore(store);
        return sendJson(res, { error: err.message }, err.status || 500);
      }
    }

    // Add a URL-based version (Vercel, Loom, Drive, etc.)
    cm = p.match(/^\/api\/cloud\/projects\/([^/]+)\/versions$/);
    if (cm && req.method === 'POST') {
      const id = decodeURIComponent(cm[1]);
      const proj = findProject(id);
      if (!proj) return notFound(res);
      const body = await readBody(req);
      const type = body.type || 'url';
      if (!['url', 'commit'].includes(type)) return sendJson(res, { error: 'invalid type' }, 400);
      const url = (body.url || '').trim();
      if (type === 'url' && !url) return sendJson(res, { error: 'url required' }, 400);
      const v = {
        id: uid('v'),
        label: (body.label || '').trim() || nextVersionLabel(proj),
        name: (body.name || '').trim() || 'Untitled',
        type,
        status: body.status || 'draft',
        description: (body.description || body.notes || '').trim(),
        uploadedBy: (body.uploadedBy || '').trim() || proj.owner || 'Unknown',
        url: url || null,
        urlKind: body.urlKind || detectUrlKind(url),
        comments: [],
        createdAt: nowMs(),
        updatedAt: nowMs(),
      };
      proj.versions = proj.versions || [];
      proj.versions.push(v);
      proj.updatedAt = nowMs();
      saveStore(store);
      return sendJson(res, { version: v });
    }

    // Add a comment to a version.
    cm = p.match(/^\/api\/cloud\/projects\/([^/]+)\/versions\/([^/]+)\/comments$/);
    if (cm && req.method === 'POST') {
      const proj = findProject(decodeURIComponent(cm[1]));
      if (!proj) return notFound(res);
      const v = (proj.versions || []).find(x => x.id === decodeURIComponent(cm[2]));
      if (!v) return notFound(res);
      const body = await readBody(req);
      const text = (body.text || '').trim();
      if (!text) return sendJson(res, { error: 'text required' }, 400);
      const clamp01 = (n) => typeof n === 'number' && isFinite(n) ? Math.max(0, Math.min(1, n)) : null;
      let pin = null;
      if (body.pin && typeof body.pin === 'object') {
        const x = clamp01(body.pin.x);
        const y = clamp01(body.pin.y);
        if (x !== null && y !== null) {
          pin = { x, y };
          if (typeof body.pin.t === 'number' && isFinite(body.pin.t)) pin.t = body.pin.t;
          if (typeof body.pin.selector === 'string' && body.pin.selector) pin.selector = body.pin.selector.slice(0, 500);
          if (typeof body.pin.label === 'string' && body.pin.label) pin.label = body.pin.label.slice(0, 80);
        }
      }
      const c = {
        id: uid('c'),
        author: (body.author || '').trim() || 'Anonymous',
        text,
        pin,
        createdAt: nowMs(),
      };
      v.comments = v.comments || [];
      v.comments.push(c);
      v.updatedAt = nowMs();
      proj.updatedAt = nowMs();
      saveStore(store);
      return sendJson(res, { comment: c });
    }

    // Edit comment text.
    cm = p.match(/^\/api\/cloud\/projects\/([^/]+)\/versions\/([^/]+)\/comments\/([^/]+)$/);
    if (cm && req.method === 'PATCH') {
      const proj = findProject(decodeURIComponent(cm[1]));
      if (!proj) return notFound(res);
      const v = (proj.versions || []).find(x => x.id === decodeURIComponent(cm[2]));
      if (!v) return notFound(res);
      const c = (v.comments || []).find(x => x.id === decodeURIComponent(cm[3]));
      if (!c) return notFound(res);
      const body = await readBody(req);
      if (typeof body.text === 'string') {
        const text = body.text.trim();
        if (!text) return sendJson(res, { error: 'text required' }, 400);
        c.text = text;
        c.editedAt = nowMs();
      }
      saveStore(store);
      return sendJson(res, { comment: c });
    }

    // Delete a comment.
    cm = p.match(/^\/api\/cloud\/projects\/([^/]+)\/versions\/([^/]+)\/comments\/([^/]+)$/);
    if (cm && req.method === 'DELETE') {
      const proj = findProject(decodeURIComponent(cm[1]));
      if (!proj) return notFound(res);
      const v = (proj.versions || []).find(x => x.id === decodeURIComponent(cm[2]));
      if (!v) return notFound(res);
      const cid = decodeURIComponent(cm[3]);
      const i = (v.comments || []).findIndex(c => c.id === cid);
      if (i < 0) return notFound(res);
      v.comments.splice(i, 1);
      saveStore(store);
      return sendJson(res, { ok: true });
    }

    // Upload a file as a version (video / image / any binary).
    // Body is raw file bytes; metadata in query string.
    cm = p.match(/^\/api\/cloud\/projects\/([^/]+)\/versions\/upload$/);
    if (cm && req.method === 'POST') {
      const id = decodeURIComponent(cm[1]);
      const proj = findProject(id);
      if (!proj) return notFound(res);
      const filename = safeFilename(url.searchParams.get('filename') || 'upload.bin');
      const name = (url.searchParams.get('name') || filename).trim();
      const notes = url.searchParams.get('notes') || '';
      const status = url.searchParams.get('status') || 'draft';
      const ext = path.extname(filename).slice(1).toLowerCase();
      const kind = /^(mp4|webm|mov|m4v)$/.test(ext) ? 'video'
                 : /^(png|jpg|jpeg|gif|webp|svg)$/.test(ext) ? 'image'
                 : 'file';
      try {
        const buf = await readRawBody(req);
        if (buf.length === 0) return sendJson(res, { error: 'empty body' }, 400);
        const projDir = path.join(UPLOADS_DIR, proj.id);
        fs.mkdirSync(projDir, { recursive: true });
        const versionId = uid('v');
        const storedName = versionId + (ext ? '.' + ext : '');
        fs.writeFileSync(path.join(projDir, storedName), buf);
        const v = {
          id: versionId,
          label: (url.searchParams.get('label') || '').trim() || nextVersionLabel(proj),
          name,
          type: 'file',
          fileKind: kind,
          status,
          description: (url.searchParams.get('description') || notes || '').trim(),
          uploadedBy: (url.searchParams.get('uploadedBy') || '').trim() || proj.owner || 'Unknown',
          filename,
          storedName,
          size: buf.length,
          mime: MIME[ext] || 'application/octet-stream',
          comments: [],
          createdAt: nowMs(),
          updatedAt: nowMs(),
        };
        proj.versions = proj.versions || [];
        proj.versions.push(v);
        proj.updatedAt = nowMs();
        saveStore(store);
        return sendJson(res, { version: v });
      } catch (err) {
        return sendJson(res, { error: err.message }, 500);
      }
    }

    // Edit version metadata.
    cm = p.match(/^\/api\/cloud\/projects\/([^/]+)\/versions\/([^/]+)$/);
    if (cm && req.method === 'PATCH') {
      const proj = findProject(decodeURIComponent(cm[1]));
      if (!proj) return notFound(res);
      const v = (proj.versions || []).find(x => x.id === decodeURIComponent(cm[2]));
      if (!v) return notFound(res);
      const body = await readBody(req);
      if (typeof body.label === 'string') v.label = body.label.trim() || v.label;
      if (typeof body.name === 'string') v.name = body.name.trim() || v.name;
      if (typeof body.description === 'string') v.description = body.description;
      if (typeof body.status === 'string') v.status = body.status;
      if (typeof body.uploadedBy === 'string') v.uploadedBy = body.uploadedBy.trim() || v.uploadedBy;
      if (typeof body.url === 'string' && v.type === 'url') {
        v.url = body.url.trim();
        v.urlKind = detectUrlKind(v.url);
      }
      v.updatedAt = nowMs();
      proj.updatedAt = nowMs();
      saveStore(store);
      return sendJson(res, { version: v });
    }

    // Delete a version (and its file if any).
    cm = p.match(/^\/api\/cloud\/projects\/([^/]+)\/versions\/([^/]+)$/);
    if (cm && req.method === 'DELETE') {
      const id = decodeURIComponent(cm[1]);
      const vid = decodeURIComponent(cm[2]);
      const proj = findProject(id);
      if (!proj) return notFound(res);
      const i = (proj.versions || []).findIndex(v => v.id === vid);
      if (i < 0) return notFound(res);
      const v = proj.versions[i];
      if (v.type === 'file' && v.storedName) {
        try { fs.unlinkSync(path.join(UPLOADS_DIR, proj.id, v.storedName)); } catch {}
      }
      proj.versions.splice(i, 1);
      proj.updatedAt = nowMs();
      saveStore(store);
      return sendJson(res, { ok: true });
    }

    // Serve an uploaded file.
    cm = p.match(/^\/uploads\/([^/]+)\/([^/]+)$/);
    if (cm && req.method === 'GET') {
      const projId = decodeURIComponent(cm[1]);
      const name = decodeURIComponent(cm[2]);
      const proj = findProject(projId);
      if (!proj) return notFound(res);
      const safe = safeFilename(name);
      const full = path.join(UPLOADS_DIR, projId, safe);
      if (!full.startsWith(UPLOADS_DIR + path.sep) || !fs.existsSync(full)) return notFound(res);
      const ext = path.extname(full).slice(1).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      return fs.createReadStream(full).pipe(res);
    }

    // /api/projects/:slug/expo/start
    let m = p.match(/^\/api\/projects\/([^/]+)\/expo\/(start|stop|status)$/);
    if (m) {
      const slug = decodeURIComponent(m[1]), action = m[2];
      const { projects } = await listProjects();
      const proj = (projects || []).find(x => x.slug === slug);
      if (!proj) return notFound(res);
      if (action === 'status') return sendJson(res, { url: proj.expoUrl });
      if (action === 'stop')  { stopExpo(slug); return sendJson(res, { ok: true }); }
      try {
        const out = await startExpo(slug, path.join(PARENT, slug));
        return sendJson(res, out);
      } catch (err) {
        return sendJson(res, { error: err.message }, 500);
      }
    }

    // /api/projects/:slug/open-xcode  &  /api/projects/:slug/open-finder
    m = p.match(/^\/api\/projects\/([^/]+)\/open-(xcode|finder)$/);
    if (m && req.method === 'POST') {
      const slug = decodeURIComponent(m[1]), which = m[2];
      const projPath = path.join(PARENT, slug);
      if (!fs.existsSync(projPath)) return notFound(res);
      let target = projPath;
      if (which === 'xcode') {
        const entries = fs.readdirSync(projPath);
        const xc = entries.find(e => e.endsWith('.xcworkspace')) || entries.find(e => e.endsWith('.xcodeproj'));
        if (!xc) return sendJson(res, { error: 'No Xcode project in folder' }, 404);
        target = path.join(projPath, xc);
      }
      spawn('open', [target], { detached: true, stdio: 'ignore' }).unref();
      return sendJson(res, { ok: true });
    }

    // /api/projects/:slug/checkout  { branch }
    m = p.match(/^\/api\/projects\/([^/]+)\/checkout$/);
    if (m && req.method === 'POST') {
      const body = await readBody(req);
      const branch = body.branch;
      if (!branch) return sendJson(res, { error: 'invalid' }, 400);
      const clean = await isWorkingTreeClean(PARENT);
      if (!clean) return sendJson(res, { error: 'Working tree has uncommitted changes — commit or stash first.' }, 409);
      try {
        await runGit(['checkout', branch], PARENT);
        return sendJson(res, { ok: true });
      } catch (err) {
        return sendJson(res, { error: err.message }, 500);
      }
    }

    // /api/projects/:slug/branch  { name }  — creates a new variation branch off current
    m = p.match(/^\/api\/projects\/([^/]+)\/branch$/);
    if (m && req.method === 'POST') {
      const slug = decodeURIComponent(m[1]);
      const body = await readBody(req);
      const variant = (body.variant || '').trim();
      if (!variant) return sendJson(res, { error: 'variant required' }, 400);
      const { projects } = await listProjects();
      const proj = (projects || []).find(x => x.slug === slug);
      if (!proj) return notFound(res);
      const clean = await isWorkingTreeClean(PARENT);
      if (!clean) return sendJson(res, { error: 'Working tree has uncommitted changes — commit or stash first.' }, 409);
      const full = `${proj.branchSlug}/${folderToSlug(variant)}`;
      try {
        await runGit(['checkout', '-b', full], PARENT);
        return sendJson(res, { ok: true, branch: full });
      } catch (err) {
        return sendJson(res, { error: err.message }, 500);
      }
    }

    // /preview/:slug/* — serve files from the project working tree
    m = p.match(/^\/preview\/([^/]+)(\/.*)?$/);
    if (m) {
      const slug = decodeURIComponent(m[1]);
      const projPath = path.join(PARENT, slug);
      if (!fs.existsSync(projPath)) return notFound(res);
      let rel = decodeURIComponent(m[2] || '/');
      if (!rel || rel === '/') {
        const entry = findHtmlEntry(projPath);
        if (!entry) return send(res, 404, 'No HTML entry in this project');
        rel = '/' + entry;
      }
      const full = safeJoin(projPath, rel);
      if (!full) return forbidden(res);
      if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) return notFound(res);
      const ext = path.extname(full).slice(1).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      return fs.createReadStream(full).pipe(res);
    }

    // Static: dashboard
    if (p === '/' || p === '/index.html') {
      const f = path.join(__dirname, 'index.html');
      res.writeHead(200, { 'Content-Type': MIME.html });
      return fs.createReadStream(f).pipe(res);
    }

    return notFound(res);
  } catch (err) {
    console.error('Route error:', err);
    sendJson(res, { error: err.message }, 500);
  }
}

// ────────────────────────── boot ──────────────────────────

http.createServer(handle).listen(PORT, () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Zuper Prototype Dashboard — local bridge');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Dashboard:  http://localhost:${PORT}`);
  console.log(`  Monorepo:   ${PARENT}`);
  console.log(`  Data dir:   ${DATA_DIR}`);
  console.log(`  GitHub:     ${GITHUB_TOKEN ? 'authenticated (5k req/hr)' : 'anonymous (60 req/hr) — set GITHUB_TOKEN for more'}`);
  console.log(`  Subfolders = projects · Branches "<project>/<variant>" = versions`);
  console.log(`  Cloud projects load from ${path.relative(__dirname, PROJECTS_FILE)}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Background GitHub sync — runs immediately then every 5 minutes.
  syncAllProjects().catch(err => console.error('initial sync error:', err.message));
  setInterval(() => {
    syncAllProjects().catch(err => console.error('periodic sync error:', err.message));
  }, SYNC_INTERVAL_MS);
});

process.on('SIGINT', () => {
  console.log('\nStopping bridge…');
  expoProcs.forEach(x => { try { x.proc.kill(); } catch {} });
  process.exit(0);
});
