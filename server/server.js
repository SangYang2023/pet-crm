// 宠物行业 CRM 轻量后端：静态资源 + 跟进数据 REST API（零依赖，数据存于本地 JSON）
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8778;
// 静态文件目录：优先用环境变量，否则从 server.js 所在目录向上找（兼容本地和 PaaS 部署）
function findStaticDir() {
  if (process.env.STATIC_DIR) return path.resolve(process.env.STATIC_DIR);
  // 尝试多个可能位置
  const candidates = [
    path.join(__dirname, '..'),           // server/ 的父目录（本地开发）
    path.join(process.cwd()),             // 工作目录（大多数 PaaS 默认）
    '/opt/render/project/src',            // Render 典型路径
    '/app',                               // Docker / 某些 PaaS
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'index.html'))) return c;
  }
  // 最后回退
  return path.join(__dirname, '..');
}
const STATIC_DIR = findStaticDir();
console.log('[CRM] STATIC_DIR =', STATIC_DIR);
console.log('[CRM] index.html exists:', fs.existsSync(path.join(STATIC_DIR, 'index.html')));
// 数据目录：默认存 server/data/；部署时可设 DATA_DIR 指向持久盘（Render Disk / Railway Volume）
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'followups.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------- 数据自动同步回 GitHub（免费持久化方案） ----------
   原理：每次数据变更后，把 followups.json 作为文件提交回仓库；
   每次服务启动（含重新部署）时，从 GitHub 拉取最新版本覆盖本地，
   从而实现"换实例 / 重新部署后数据不丢"。需设置以下环境变量：
     GITHUB_TOKEN       —— 具有 repo 权限的个人访问令牌(PAT)
     GITHUB_REPO        —— 仓库 owner/name，默认 SangYang2023/pet-crm
     GITHUB_BRANCH      —— 代码分支（Render 部署此分支），默认 main
     GITHUB_DATA_BRANCH —— 数据分支（与代码分离，避免触发 Auto-Deploy 部署风暴），默认 crm-data
     GITHUB_DATA_PATH   —— 仓库内数据文件路径，默认 server/data/followups.json
   注：数据分支与代码分支分离后，可放心开启 Render 的 Auto-Deploy ——
       代码 push 到 GITHUB_BRANCH 自动部署，数据 sync 推到 GITHUB_DATA_BRANCH 不会触发部署。
   未设置 GITHUB_TOKEN 时自动关闭同步，退化为纯本地文件。 */
const GH_TOKEN = process.env.GITHUB_TOKEN || '';
const GH_REPO = process.env.GITHUB_REPO || 'SangYang2023/pet-crm';
const GH_BRANCH = process.env.GITHUB_BRANCH || 'main';
// 数据分支：与代码分支分离，避免「数据同步提交」触发 Render 的 Auto-Deploy（部署风暴）
const GH_DATA_BRANCH = process.env.GITHUB_DATA_BRANCH || 'crm-data';
const GH_DATA_PATH = process.env.GITHUB_DATA_PATH || 'server/data/followups.json';
const GH_ENABLED = !!GH_TOKEN;
if (GH_ENABLED) console.log('[CRM] GitHub 同步已启用 ->', GH_REPO, GH_DATA_PATH);
else console.log('[CRM] GitHub 同步未启用（未设置 GITHUB_TOKEN），数据仅存本地文件');

function ghRequest(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(body) : null;
    const req = https.request({
      hostname: 'api.github.com',
      path: apiPath,
      method,
      headers: {
        'User-Agent': 'pet-crm-sync',
        'Accept': 'application/vnd.github+json',
        'Authorization': 'Bearer ' + GH_TOKEN,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {})
      }
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, text: buf }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function ghGetFile(p, branch) {
  const b = branch || GH_BRANCH;
  const res = await ghRequest('GET', `/repos/${GH_REPO}/contents/${encodeURI(p)}?ref=${b}`);
  if (res.status === 404) return null;
  if (res.status >= 400) throw new Error('GET ' + res.status + ' ' + res.text);
  try { return JSON.parse(res.text); } catch (e) { throw new Error('parse ' + res.text); }
}

async function ghPutFile(p, contentB64, sha, message, branch, depth = 0) {
  const b = branch || GH_BRANCH;
  const body = JSON.stringify({ message, content: contentB64, branch: b, ...(sha ? { sha } : {}) });
  const res = await ghRequest('PUT', `/repos/${GH_REPO}/contents/${encodeURI(p)}`, body);
  if (res.status === 409 && depth < 4) {
    // 并发冲突：重新取 sha 后重试
    const f = await ghGetFile(p, b);
    return ghPutFile(p, contentB64, f ? f.sha : null, message, b, depth + 1);
  }
  if (res.status >= 400) throw new Error('PUT ' + res.status + ' ' + res.text);
  return res;
}

// 确保数据分支存在：不存在时基于主分支创建（仅首次）
async function ensureDataBranch() {
  if (!GH_ENABLED) return;
  if (GH_DATA_BRANCH === GH_BRANCH) return; // 未分离则跳过
  try {
    const refRes = await ghRequest('GET', `/repos/${GH_REPO}/git/refs/heads/${GH_DATA_BRANCH}`);
    if (refRes.status === 200) return; // 已存在
    if (refRes.status !== 404) {
      console.log('[CRM] 检查数据分支异常:', refRes.status, refRes.text);
      return;
    }
    // 从主分支最新 commit 创建
    const mainRef = await ghRequest('GET', `/repos/${GH_REPO}/git/refs/heads/${GH_BRANCH}`);
    if (mainRef.status !== 200) { console.log('[CRM] 无法获取主分支 HEAD，跳过数据分支创建'); return; }
    const sha = JSON.parse(mainRef.text).object.sha;
    const createRes = await ghRequest('POST', `/repos/${GH_REPO}/git/refs`,
      JSON.stringify({ ref: 'refs/heads/' + GH_DATA_BRANCH, sha }));
    if (createRes.status === 201) console.log('[CRM] 已创建数据分支 ->', GH_DATA_BRANCH);
    else console.log('[CRM] 创建数据分支失败:', createRes.status, createRes.text);
  } catch (e) {
    console.log('[CRM] ensureDataBranch 出错（忽略）:', e.message);
  }
}

// 启动时从 GitHub 拉取最新数据覆盖本地（实现重新部署后恢复）
async function restoreFromGitHub() {
  if (!GH_ENABLED) return;
  try {
    const f = await ghGetFile(GH_DATA_PATH, GH_DATA_BRANCH);
    if (f && f.content) {
      const txt = Buffer.from(f.content, 'base64').toString('utf8');
      // 立即清洗脏数据（leadStatus 为 undefined/"undefined"/空 → "待开发"），不等 readStore 触发
      let obj;
      try { obj = JSON.parse(txt); } catch(e) { obj = {}; }
      let dirty = false;
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (!v || typeof v !== 'object') continue;
        if (!v.leadStatus || v.leadStatus === 'undefined') { v.leadStatus = '待开发'; dirty = true; }
        if (!v.priority || v.priority === 'undefined') { v.priority = '中'; dirty = true; }
      }
      if (dirty) {
        const cleanTxt = JSON.stringify(obj, null, 2);
        fs.writeFileSync(DATA_FILE, cleanTxt, 'utf8');
        console.log('[CRM] 已从 GitHub 恢复并清洗 followups.json（' + cleanTxt.length + ' 字节，修复 ' + dirty + ' 条脏数据）');
        // 清洗后立即同步回 GitHub，防止下次再拉到脏数据
        syncToGitHub('startup-cleanup').catch(()=>{});
      } else {
        fs.writeFileSync(DATA_FILE, txt, 'utf8');
        console.log('[CRM] 已从 GitHub 恢复 followups.json（' + txt.length + ' 字节，无需清洗）');
      }
    } else {
      console.log('[CRM] GitHub 上暂无数据文件，使用本地/部署版本');
    }
  } catch (e) {
    console.log('[CRM] GitHub 恢复失败，沿用本地文件：', e.message);
  }
}

// 变更后保存回 GitHub（串行队列，避免并发冲突）
let ghSaveChain = Promise.resolve();
function syncToGitHub(reason) {
  if (!GH_ENABLED) return Promise.resolve();
  ghSaveChain = ghSaveChain.then(async () => {
    const content = fs.readFileSync(DATA_FILE, 'utf8');
    const b64 = Buffer.from(content, 'utf8').toString('base64');
    let sha = null;
    try { const f = await ghGetFile(GH_DATA_PATH, GH_DATA_BRANCH); sha = f ? f.sha : null; } catch (e) { /* 文件不存在则创建 */ }
    await ghPutFile(GH_DATA_PATH, b64, sha, 'chore(data): auto-sync followups.json [' + (reason || 'update') + '] ' + new Date().toISOString(), GH_DATA_BRANCH);
    console.log('[CRM] 已同步 followups.json 回 GitHub（' + (reason || 'update') + '）');
  }).catch(e => console.log('[CRM] GitHub 同步出错（已忽略，下次变更重试）：', e.message));
  return ghSaveChain;
}

function readStore() {
  try { 
    const obj = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    // 自动修复脏数据：leadStatus/priority 为 undefined/"undefined"/空 时修正为默认值
    let dirty = false;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (!v || typeof v !== 'object') continue;
      if (!v.leadStatus || v.leadStatus === 'undefined') { v.leadStatus = '待开发'; dirty = true; }
      if (!v.priority || v.priority === 'undefined') { v.priority = '中'; dirty = true; }
    }
    if (dirty) { writeStore(obj); syncToGitHub('cleanup-undefined'); }
    return obj; 
  }
  catch (e) { return {}; }
}
function writeStore(obj) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(obj, null, 2), 'utf8');
}
// 操作留痕：在变更项上追加一条历史记录（时间 / 动作 / 操作人）
function logHistory(item, action, who) {
  if (!item || typeof item !== 'object') return;
  if (!Array.isArray(item.history)) item.history = [];
  item.history.push({ ts: new Date().toISOString(), action: String(action || ''), by: who || '系统' });
  if (item.history.length > 80) item.history = item.history.slice(-80);
}

/* ---------- 实时推送（SSE） ---------- */
const clients = new Set();   // 在线销售团队的 EventSource 连接
let heartbeat;
function broadcast(from) {
  if (clients.size === 0) return;
  const payload = 'data: ' + JSON.stringify({ type:'update', store: readStore(), from: from || null, ts: Date.now() }) + '\n\n';
  clients.forEach(res => { try { res.write(payload); } catch(e){ clients.delete(res); } });
}
function startHeartbeat() {
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    clients.forEach(res => { try { res.write(': ping\n\n'); } catch(e){ clients.delete(res); } });
  }, 25000);
}

/* ---------- 简单账号登录（零依赖） ---------- */
const sessions = new Map();                 // sid -> { user, expires }
const SESSION_TTL = 1000 * 60 * 60 * 24 * 7; // 7 天
function loadUsers() {
  const list = [];
  if (process.env.CRM_USERS) {
    process.env.CRM_USERS.split(',').forEach(p => {
      const i = p.indexOf(':'); if (i > 0) list.push([p.slice(0,i).trim(), p.slice(i+1).trim()]);
    });
  } else if (process.env.CRM_PASSWORD) {
    list.push(['team', String(process.env.CRM_PASSWORD)]);
  } else {
    list.push(['admin', 'admin123']);
    console.log('⚠️  未设置 CRM_USERS / CRM_PASSWORD，使用默认账号 admin / admin123，请在部署平台的环境变量中修改！');
  }
  return list;
}
const USERS = loadUsers();
// 管理员账号（拥有批量分配等管理权限），用环境变量 CRM_ADMINS 指定，逗号分隔
const ADMINS = (process.env.CRM_ADMINS || '').split(',').map(s => s.trim()).filter(Boolean);
function parseCookies(req) {
  const out = {}; (req.headers.cookie || '').split(';').forEach(c => {
    const i = c.indexOf('='); if (i > 0) out[c.slice(0,i).trim()] = decodeURIComponent(c.slice(i+1).trim());
  }); return out;
}
function isHttps(req) { return req.headers['x-forwarded-proto'] === 'https' || !!req.socket.encrypted; }
function sessionCookie(sid, remove, req) {
  const parts = [`sid=${remove ? '' : sid}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (isHttps(req)) parts.push('Secure');
  parts.push(remove ? 'Max-Age=0' : `Max-Age=${SESSION_TTL/1000}`);
  return parts.join('; ');
}
function currentUser(req) {
  const sid = parseCookies(req).sid;
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s) return null;
  if (s.expires < Date.now()) { sessions.delete(sid); return null; }
  return s.user;
}
function requireAuth(req, res) {
  const u = currentUser(req);
  if (!u) {
    res.writeHead(401, { 'Content-Type':'application/json; charset=utf-8', 'Access-Control-Allow-Origin':'*' });
    res.end(JSON.stringify({ error:'unauthorized' }));
    return null;
  }
  return u;
}

const MIME = { '.html':'text/html; charset=utf-8', '.js':'application/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8',
  '.csv':'text/csv; charset=utf-8', '.ico':'image/x-icon',
  '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png', '.gif':'image/gif', '.svg':'image/svg+xml' };

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type':'application/json; charset=utf-8', 'Access-Control-Allow-Origin':'*' });
  res.end(body);
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  // 防目录穿越
  const filePath = path.normalize(path.join(STATIC_DIR, urlPath));
  if (!filePath.startsWith(STATIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', c => buf += c);
    req.on('end', () => { try { resolve(JSON.parse(buf || '{}')); } catch(e){ resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0];

  // ---- 登录态查询（无需鉴权） ----
  if (urlPath === '/api/me' && req.method === 'GET') {
    const u = currentUser(req);
    return sendJSON(res, 200, { user: u, isAdmin: u ? ADMINS.includes(u) : false });
  }

  // ---- 登录 ----
  if (urlPath === '/api/login' && req.method === 'POST') {
    const body = await readBody(req);
    const u = String(body.user || '').trim(), p = String(body.pass || '');
    const ok = USERS.some(([nu, np]) => nu === u && np === p);
    if (!ok) return sendJSON(res, 401, { ok:false, error:'invalid' });
    const sid = crypto.randomBytes(18).toString('hex');
    sessions.set(sid, { user:u, expires: Date.now() + SESSION_TTL });
    res.writeHead(200, { 'Content-Type':'application/json; charset=utf-8', 'Set-Cookie': sessionCookie(sid, false, req), 'Access-Control-Allow-Origin':'*' });
    return res.end(JSON.stringify({ ok:true, user:u }));
  }

  // ---- 登出 ----
  if (urlPath === '/api/logout' && req.method === 'POST') {
    const sid = parseCookies(req).sid; if (sid) sessions.delete(sid);
    res.writeHead(200, { 'Content-Type':'application/json; charset=utf-8', 'Set-Cookie': sessionCookie('', true, req), 'Access-Control-Allow-Origin':'*' });
    return res.end(JSON.stringify({ ok:true }));
  }

  // ---- 实时事件流 SSE（需登录） ----
  if (urlPath === '/api/events' && req.method === 'GET') {
    if (!requireAuth(req, res)) return;
    res.writeHead(200, {
      'Content-Type':'text/event-stream; charset=utf-8',
      'Cache-Control':'no-cache',
      'Connection':'keep-alive',
      'Access-Control-Allow-Origin':'*'
    });
    res.write('retry: 3000\n\n');
    res.write(': connected\n\n');
    clients.add(res);
    startHeartbeat();
    req.on('close', () => { clients.delete(res); });
    return;
  }

  // ---- API（需登录） ----
  if (urlPath === '/api/followups' && req.method === 'GET') {
    if (!requireAuth(req, res)) return;
    return sendJSON(res, 200, readStore());
  }
  const m = urlPath.match(/^\/api\/followups\/(\d+)$/);
  if (m) {
    if (!requireAuth(req, res)) return;
    const id = m[1];
    const from = req.headers['x-client-id'] || null;
    if (req.method === 'GET') {
      const store = readStore();
      return sendJSON(res, 200, store[id] || null);
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      const u = currentUser(req);
      const body = await readBody(req);
      delete body.disabled;   // 停用状态只能通过专用接口修改，普通 PUT 不允许改
      delete body.history;    // 历史只由服务端记录，防止客户端伪造
      if(!body.leadStatus || body.leadStatus==='undefined') body.leadStatus = '待开发';
      const store = readStore();
      const prev = store[id] || {};
      store[id] = Object.assign({}, prev, body, { updated: new Date().toISOString() });
      logHistory(store[id], '编辑资料', u);
      writeStore(store);
      broadcast(from);
      syncToGitHub('edit');
      return sendJSON(res, 200, { ok:true, id, item: store[id] });
    }
    if (req.method === 'DELETE') {
      const store = readStore();
      delete store[id];
      writeStore(store);
      broadcast(from);
      syncToGitHub('delete');
      return sendJSON(res, 200, { ok:true });
    }
  }

  // ---- 停用客户（任意登录账号） ----
  const dm = urlPath.match(/^\/api\/followups\/(\d+)\/disable$/);
  if (dm && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    const id = dm[1];
    const u = currentUser(req);
    const store = readStore();
    store[id] = Object.assign(store[id] || { leadStatus:'待开发', priority:'中', owner:'', notes:[] }, { disabled:true, updated: new Date().toISOString() });
    logHistory(store[id], '停用客户', u);
    writeStore(store);
    broadcast(req.headers['x-client-id'] || null);
    syncToGitHub('disable');
    return sendJSON(res, 200, { ok:true, id });
  }
  // ---- 启用客户（仅管理员） ----
  const em = urlPath.match(/^\/api\/followups\/(\d+)\/enable$/);
  if (em && req.method === 'POST') {
    const u = currentUser(req);
    if (!u || !ADMINS.includes(u)) {
      res.writeHead(403, { 'Content-Type':'application/json; charset=utf-8', 'Access-Control-Allow-Origin':'*' });
      return res.end(JSON.stringify({ error:'forbidden' }));
    }
    const id = em[1];
    const store = readStore();
    if (store[id]) store[id].disabled = false;
    else store[id] = { disabled:false, leadStatus:'待开发', priority:'中', owner:'', notes:[] };
    store[id].updated = new Date().toISOString();
    logHistory(store[id], '启用客户', u);
    writeStore(store);
    broadcast(req.headers['x-client-id'] || null);
    syncToGitHub('enable');
    return sendJSON(res, 200, { ok:true, id });
  }

  // ---- 批量分配（仅管理员） ----
  if (urlPath === '/api/followups/batch-assign' && req.method === 'POST') {
    const u = currentUser(req);
    if (!u || !ADMINS.includes(u)) {
      res.writeHead(403, { 'Content-Type':'application/json; charset=utf-8', 'Access-Control-Allow-Origin':'*' });
      return res.end(JSON.stringify({ error:'forbidden' }));
    }
    const body = await readBody(req);
    const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(n => n > 0) : [];
    const owner = String(body.owner || '').trim();
    if (!owner) return sendJSON(res, 400, { ok:false, error:'owner required' });
    const store = readStore();
    let n = 0;
    ids.forEach(id => {
      const key = String(id);
      const cur = store[key] || {};
      cur.owner = owner; if(!cur.leadStatus || cur.leadStatus==='undefined') cur.leadStatus = '待开发'; cur.updated = new Date().toISOString();
      logHistory(cur, '分配归属→'+owner, u); store[key] = cur; n++;
    });
    writeStore(store);
    broadcast(req.headers['x-client-id'] || null);
    syncToGitHub('batch-assign');
    return sendJSON(res, 200, { ok:true, count:n });
  }

  // ---- 批量释放归属（仅管理员）：将客户设为未分配 ----
  if (urlPath === '/api/followups/batch-release' && req.method === 'POST') {
    const u = currentUser(req);
    if (!u || !ADMINS.includes(u)) {
      res.writeHead(403, { 'Content-Type':'application/json; charset=utf-8', 'Access-Control-Allow-Origin':'*' });
      return res.end(JSON.stringify({ error:'forbidden' }));
    }
    const body = await readBody(req);
    const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(n => n > 0) : [];
    if (ids.length === 0) return sendJSON(res, 400, { ok:false, error:'ids required' });
    const store = readStore();
    let n = 0;
    ids.forEach(id => {
      const key = String(id);
      const cur = store[key] || {};
      cur.owner = ''; cur.updated = new Date().toISOString();
      logHistory(cur, '释放归属', u); store[key] = cur; n++;
    });
    writeStore(store);
    broadcast(req.headers['x-client-id'] || null);
    syncToGitHub('batch-release');
    return sendJSON(res, 200, { ok:true, count:n });
  }

  // ---- 批量修改线索状态 / 优先级（登录即可，作用于所选客户） ----
  if (urlPath === '/api/followups/batch-update' && req.method === 'POST') {
    const u = currentUser(req);
    if (!u) {
      res.writeHead(401, { 'Content-Type':'application/json; charset=utf-8', 'Access-Control-Allow-Origin':'*' });
      return res.end(JSON.stringify({ error:'unauthorized' }));
    }
    const body = await readBody(req);
    const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(n => n > 0) : [];
    if (ids.length === 0) return sendJSON(res, 400, { ok:false, error:'ids required' });
    const ls = body.leadStatus && body.leadStatus!=='undefined' ? body.leadStatus : null;
    const pr = body.priority && body.priority!=='undefined' ? body.priority : null;
    if (!ls && !pr) return sendJSON(res, 400, { ok:false, error:'nothing to update' });
    const store = readStore();
    let n = 0;
    const parts = [];
    if (ls) parts.push('状态→'+ls);
    if (pr) parts.push('优先级→'+pr);
    const action = '批量修改('+parts.join('，')+')';
    ids.forEach(id => {
      const key = String(id);
      const cur = store[key] || { leadStatus:'待开发', priority:'中', owner:'', notes:[] };
      if (ls) cur.leadStatus = ls;
      if (pr) cur.priority = pr;
      cur.updated = new Date().toISOString();
      logHistory(cur, action, u);
      store[key] = cur; n++;
    });
    writeStore(store);
    broadcast(req.headers['x-client-id'] || null);
    syncToGitHub('batch-update');
    return sendJSON(res, 200, { ok:true, count:n });
  }

  // ---- 静态 ----
  if (req.method === 'GET') {
    // 线索数据含手机号等敏感信息，未登录禁止下载
    if (urlPath === '/crm-data.js' && !currentUser(req)) {
      res.writeHead(401, { 'Content-Type':'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error:'unauthorized' }));
    }
    return serveStatic(req, res);
  }

  res.writeHead(405); res.end('method not allowed');
});

// 进程退出前（如 Render 缩容 / 重新部署发来 SIGTERM）尽量把最后一次变更刷回 GitHub
function flushAndExit(code) {
  ghSaveChain
    .then(() => process.exit(code))
    .catch(() => process.exit(code));
  setTimeout(() => process.exit(code), 2500).unref();
}
process.on('SIGTERM', () => flushAndExit(0));
process.on('SIGINT', () => flushAndExit(0));

ensureDataBranch().then(() => restoreFromGitHub()).finally(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`宠物CRM后端已启动: http://0.0.0.0:${PORT} (监听所有网卡，可用于公网部署)`);
  });
});
