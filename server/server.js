// 宠物行业 CRM 轻量后端：静态资源 + 跟进数据 REST API（零依赖，数据存于本地 JSON）
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8778;
const STATIC_DIR = path.join(__dirname, '..');          // pet-crm/
// 数据目录：默认存 server/data/；部署时可设 DATA_DIR 指向持久盘（Render Disk / Railway Volume）
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'followups.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readStore() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
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
    return sendJSON(res, 200, { user: currentUser(req) });
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
