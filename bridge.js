#!/usr/bin/env node
// Zuper Prototype Dashboard — local bridge.
// Scans a parent folder, exposes each subfolder-with-.git as a project,
// and serves the dashboard + previews on http://localhost:5050.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');

const PORT = Number(process.env.PORT) || 5050;
// Monorepo mode: the bridge sits inside one git repo whose subfolders are projects
// and whose branches (named "<project>/<variant>") are versions of those projects.
const PARENT = process.env.PROTOTYPE_DIR
  ? path.resolve(process.env.PROTOTYPE_DIR.replace(/^~(?=$|\/)/, os.homedir()))
  : __dirname;

fs.mkdirSync(PARENT, { recursive: true });

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
      return sendJson(res, { ok: true, parent: PARENT, port: PORT });
    }
    if (p === '/api/projects' && req.method === 'GET') {
      return sendJson(res, await listProjects());
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
  console.log(`  Subfolders = projects · Branches "<project>/<variant>" = versions`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
});

process.on('SIGINT', () => {
  console.log('\nStopping bridge…');
  expoProcs.forEach(x => { try { x.proc.kill(); } catch {} });
  process.exit(0);
});
