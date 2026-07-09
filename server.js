// 米哈游兑换码 & 线下活动 H5 页面 —— 零依赖 Node 服务
// 功能：托管前端 / 提供 /api/data / 手动与每日自动更新 / 尝试从米游社抓取最新资讯
// 运行：node server.js   （默认端口 8787，可用 PORT 环境变量覆盖）
// Railway 触发时间戳: 2026-07-09T08:53:00+08:00

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'data', 'data.json');
const PUBLIC_DIR = ROOT;
const PORT = process.env.PORT || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ---------- 数据读写 ----------
function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    console.error('读取 data.json 失败：', e.message);
    return null;
  }
}
function saveData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('写入 data.json 失败：', e.message);
    return false;
  }
}

// ---------- 米游社动态抓取（尝试） ----------
// 说明：米游社官方接口有风控，部署机器若被挡会抛错，此时我们回退到上一次有效数据。
// 这里实现两套抓取：1) 官方 bbs-api 新闻列表；2) 兜底 Web 搜索无法在服务端做，故仅维护本地种子+人工更新。
const GAME_META = {
  genshin: { gids: 2, name: '原神', community: 'https://www.miyoushe.com/ys/' },
  sr: { gids: 6, name: '崩坏：星穹铁道', community: 'https://www.miyoushe.com/sr/' },
  zzz: { gids: 8, name: '绝区零', community: 'https://www.miyoushe.com/zzz/' },
};

async function fetchMiyousheNews(gids) {
  // 多套候选地址：米游社官方接口有风控/版本差异，任一可用即採用
  const urls = [
    `https://bbs-api.mihoyo.com/post/wapi/getNewsList?gids=${gids}&page_size=20&type=1`,
    `https://bbs-api.mihoyo.com/post/wapi/getNewsList?app_sn=bbs&gids=${gids}&page_size=20&type=1`,
    `https://bbs-api.mihoyo.com/post/wapi/getNewsList?gids=${gids}&page_size=20&type=2`,
  ];
  let lastErr;
  for (const url of urls) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
          Referer: 'https://www.miyoushe.com/',
          Origin: 'https://www.miyoushe.com',
          Accept: 'application/json, text/plain, */*',
        },
        signal: ctrl.signal,
      });
      if (!res.ok) { lastErr = new Error('HTTP ' + res.status); continue; }
      const json = await res.json();
      const list = json?.data?.list || json?.data?.posts || [];
      if (!list.length) { lastErr = new Error('空列表'); continue; }
      return list.map((p) => ({
        title: p?.post?.subject || p?.official?.title || p?.subject || '',
        publishedTs: (p?.post?.created_at || p?.official?.created_at || p?.created_at || 0) * 1000,
        url: `https://www.miyoushe.com/../article/${p?.post?.post_id || p?.official?.id || p?.post_id || ''}`,
        cover: p?.post?.cover || p?.official?.cover || '',
        summary: (p?.post?.summary || p?.official?.summary || p?.summary || '').slice(0, 120),
      }));
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('全部候选地址失败');
}

// 从抓取到的官方动态里，筛选出“线下活动”相关（标题/摘要含关键词）且在一个月内发布的
function pickOfflineEvents(news, now) {
  const ONE_MONTH = 30 * 24 * 3600 * 1000;
  const KW = ['线下', '快闪', '展会', '漫展', '嘉年华', '展览', '展台', '打卡', '联动', 'FES', 'BW', 'GAF', '参展'];
  return news
    .filter((n) => n.title && n.publishedTs)
    .filter((n) => now - n.publishedTs <= ONE_MONTH)
    .filter((n) => KW.some((k) => (n.title + n.summary).includes(k)))
    .map((n) => ({
      title: n.title,
      published: new Date(n.publishedTs).toISOString().slice(0, 10),
      publishedTs: n.publishedTs,
      eventStart: '',
      eventEnd: '',
      location: '',
      summary: n.summary || '',
      url: n.url,
      source: '米游社官方动态',
    }));
}

// 筛选“兑换码”相关动态（前瞻/礼包），并提取可能的码（尽力而为）
function pickCodePosts(news, now) {
  const ONE_WEEK = 7 * 24 * 3600 * 1000;
  const KW = ['兑换码', '前瞻', '礼包码', '兑换'];
  return news
    .filter((n) => n.title && n.publishedTs)
    .filter((n) => now - n.publishedTs <= ONE_WEEK)
    .filter((n) => KW.some((k) => (n.title + n.summary).includes(k)));
}

// 尝试从文本中提取疑似兑换码（大写字母+数字，长度6-18，不含纯中文）
function extractCodes(text) {
  const matches = text.match(/[A-Z0-9]{6,18}/g) || [];
  return [...new Set(matches)].filter((m) => /[A-Z]/.test(m) && /[0-9]/.test(m));
}

// ---------- 更新流程 ----------
async function doUpdate() {
  const data = loadData() || { meta: {}, games: {} };
  const now = Date.now();
  let changed = false;
  let liveCount = 0;

  for (const slug of Object.keys(GAME_META)) {
    const meta = GAME_META[slug];
    const game = data.games?.[slug] || (data.games[slug] = {});
    try {
      const news = await fetchMiyousheNews(meta.gids);
      if (!news.length) continue;
      liveCount++;
      // 线下活动：覆盖式刷新（取最新一批官方动态）
      const events = pickOfflineEvents(news, now);
      if (events.length) {
        game.events = events.slice(0, 8);
        changed = true;
      }
      // 兑换码：尝试从一周内官方帖提取；提取不到则保留历史
      const codePosts = pickCodePosts(news, now);
      const codes = [];
      for (const cp of codePosts) {
        const found = extractCodes(cp.title + ' ' + cp.summary);
        for (const c of found) {
          codes.push({
            code: c,
            reward: cp.title,
            published: new Date(cp.publishedTs).toISOString().slice(0, 10),
            source: '米游社官方动态',
            reliable: true,
          });
        }
      }
      if (codes.length) {
        game.codes = codes.slice(0, 8);
        changed = true;
      }
    } catch (e) {
      // 抓取失败：保留原有数据（符合“无有效内容则用之前有效内容填充”）
      console.warn(`[${meta.name}] 米游社抓取失败，保留上次数据：`, e.message);
    }
  }

  data.meta = data.meta || {};
  data.meta.updatedAt = new Date().toISOString();
  data.meta.mode = liveCount > 0 ? 'live' : 'fallback';
  data.meta.note = liveCount > 0
    ? `已从米游社抓取 ${liveCount} 款游戏的官方动态并刷新。`
    : '本次未能从米游社取得最新数据（接口受限或网络问题），已保留上一次有效内容。';

  if (changed || liveCount > 0) saveData(data);
  return data.meta;
}

// ---------- HTTP 服务 ----------
function sendFile(res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    addCors(res);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(buf);
  });
}

const RAILWAY_URL = 'https://mihoyo-codes-production.up.railway.app';
const ALLOWED_ORIGINS = [
  RAILWAY_URL,
  'https://mihoyo.oldgao.com',
  'https://roseion.github.io',
  'http://localhost:' + PORT,
];

function addCors(res) {
  const origin = res.req.headers.origin || '';
  const allowed = ALLOWED_ORIGINS.some((o) => origin.includes(new URL(o).host));
  res.setHeader('Access-Control-Allow-Origin', allowed ? origin : ALLOWED_ORIGINS[0]);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function serveApi(res, status, obj) {
  addCors(res);
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(u.pathname);

  // CORS 预检
  if (req.method === 'OPTIONS') {
    addCors(res);
    res.writeHead(204);
    return res.end();
  }

  // 健康检查（Railway HTTP 代理需要快速响应）
  if (pathname === '/up' || pathname === '/health') {
    addCors(res);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  // API: 取数据
  if (pathname === '/api/data' && req.method === 'GET') {
    const data = loadData();
    if (!data) return serveApi(res, 500, { error: '数据文件缺失' });
    return serveApi(res, 200, data);
  }

  // API: 手动更新
  if (pathname === '/api/update' && req.method === 'POST') {
    try {
      const meta = await doUpdate();
      return serveApi(res, 200, { ok: true, meta });
    } catch (e) {
      return serveApi(res, 500, { ok: false, error: e.message });
    }
  }

  // 静态资源
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  // 防目录穿越
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  if (pathname === '/') filePath = path.join(PUBLIC_DIR, 'index.html');
  sendFile(res, filePath);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`米哈游活动/兑换码 H5 已启动： http://localhost:${PORT}`);
  // 启动即执行一次自动更新尝试
  doUpdate().then((m) =>
    console.log(`[自动更新] 模式=${m.mode} | ${m.note}`)
  );
});

// 每日自动更新（本地时间 09:00）
function scheduleDaily() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(9, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const delay = next - now;
  setTimeout(async () => {
    const m = await doUpdate();
    console.log(`[每日更新] 模式=${m.mode} | ${m.note}`);
    scheduleDaily();
  }, delay);
}
scheduleDaily();
