// 宠物行业 CRM 轻量后端：静态资源 + 跟进数据 REST API（零依赖，数据存于本地 JSON）
const http = require('http');
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

function readStore() {
  try { 
    const obj = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    // 自动修复脏数据：leadStatus 为 undefined/"undefined"/空 时修正为"待开发"
    let dirty = false;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (!v || typeof v !== 'object') continue;
      if (!v.leadStatus || v.leadStatus === 'undefined') { v.leadStatus = '待开发'; dirty = true; }
    }
    if (dirty) writeStore(obj);
    return obj; 
  }
  catch (e) { return {}; }
}
function writeStore(obj) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(obj, null, 2), 'utf8');
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
  '.csv':'text/csv; charset=utf-8', '.ico':'image/x-icon' };

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
      const body = await readBody(req);
      delete body.disabled;   // 停用状态只能通过专用接口修改，普通 PUT 不允许改
      const store = readStore();
      store[id] = Object.assign(store[id] || {}, body, { updated: new Date().toISOString() });
      writeStore(store);
      broadcast(from);
      return sendJSON(res, 200, { ok:true, id, item: store[id] });
    }
    if (req.method === 'DELETE') {
      const store = readStore();
      delete store[id];
      writeStore(store);
      broadcast(from);
      return sendJSON(res, 200, { ok:true });
    }
  }

  // ---- 停用客户（任意登录账号） ----
  const dm = urlPath.match(/^\/api\/followups\/(\d+)\/disable$/);
  if (dm && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    const id = dm[1];
    const store = readStore();
    store[id] = Object.assign(store[id] || { leadStatus:'待开发', priority:'中', owner:'', notes:[] }, { disabled:true, updated: new Date().toISOString() });
    writeStore(store);
    broadcast(req.headers['x-client-id'] || null);
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
    writeStore(store);
    broadcast(req.headers['x-client-id'] || null);
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
      cur.owner = owner; if(!cur.leadStatus) cur.leadStatus = '待开发'; cur.updated = new Date().toISOString();
      store[key] = cur; n++;
    });
    writeStore(store);
    broadcast(req.headers['x-client-id'] || null);
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`宠物CRM后端已启动: http://0.0.0.0:${PORT} (监听所有网卡，可用于公网部署)`);
});
