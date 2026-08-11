// 宠物行业 CRM 轻量后端：静态资源 + 跟进数据 REST API（零依赖，数据存于本地 JSON）
const http = require('http');
const fs = require('fs');
const path = require('path');

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

  // ---- 实时事件流 SSE ----
  if (urlPath === '/api/events' && req.method === 'GET') {
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

  // ---- API ----
  if (urlPath === '/api/followups' && req.method === 'GET') {
    return sendJSON(res, 200, readStore());
  }
  const m = urlPath.match(/^\/api\/followups\/(\d+)$/);
  if (m) {
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
  if (req.method === 'GET') return serveStatic(req, res);

  res.writeHead(405); res.end('method not allowed');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`宠物CRM后端已启动: http://0.0.0.0:${PORT} (监听所有网卡，可用于公网部署)`);
});
