// 前端逻辑：拉取 /api/data，渲染兑换码与线下活动卡片
const $ = (s) => document.querySelector(s);

// Railway 后端地址（GitHub Pages 部署时需要跨域调用；Railway 自身部署时用相对路径）
const RAILWAY_API = 'https://mihoyo-codes-production.up.railway.app';

// 是否在 Railway 上（相对路径可用）
const isRailway = location.hostname.includes('railway.app');
const API_BASE = isRailway ? '' : RAILWAY_API;

const GAME_LOGO = { genshin: '原', sr: '星', zzz: '零' };

const state = { data: null };

function fmtUpdated(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `更新于 ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function cardShell(game, innerHtml) {
  const t = game.theme || {};
  // 渐变永远作为底色；图片作为叠加层（图片失败时渐变兜底）
  const cardStyle = [
    `--card-grad:${t.gradient || '#1b3a6b'}`,
    '--card-bg-image:' + (t.bgImage ? `url('${escapeHtml(t.bgImage)}')` : 'none'),
  ].join(';');
  return `
    <article class="card" style="${cardStyle}">
      <div class="card-bg"></div>
      <div class="card-logo">${GAME_LOGO[game.slug] || '·'}</div>
      <div class="card-body">
        <p class="card-game">${escapeHtml(game.name)}</p>
        <p class="card-tagline">${escapeHtml(game.tagline || '')}</p>
        ${innerHtml}
      </div>
    </article>`;
}

function renderCodes(game) {
  const codes = game.codes || [];
  let body;
  if (!codes.length) {
    body = `<div class="card-empty">近一周内暂无新的国服兑换码<br/>已用最近一条存档填充（见下方活动区或稍后点“更新”）</div>`;
  } else {
    body = codes
      .map((c) => {
        const note = c.note
          ? `<div class="code-meta"><span class="warn">⚠ ${escapeHtml(c.note)}</span></div>`
          : `<div class="code-meta">${escapeHtml(c.reward || '')}${c.published ? ' · 发布 ' + escapeHtml(c.published) : ''}</div>`;
        return `
          <div class="code-row">
            <span class="code-val">${escapeHtml(c.code)}</span>
            <button class="code-copy" data-code="${escapeHtml(c.code)}">复制</button>
          </div>
          ${note}`;
      })
      .join('');
  }
  return cardShell(game, body);
}

function renderEvents(game) {
  const events = game.events || [];
  let body;
  if (!events.length) {
    body = `<div class="card-empty">近一个月内暂无新的线下活动公布</div>`;
  } else {
    body = events
      .map((e) => {
        const tags = [];
        if (e.published) tags.push(`<span class="tag time">发布 ${escapeHtml(e.published)}</span>`);
        const span = [e.eventStart, e.eventEnd].filter(Boolean).join(' ~ ');
        if (span) tags.push(`<span class="tag">活动 ${escapeHtml(span)}</span>`);
        if (e.location) tags.push(`<span class="tag">${escapeHtml(e.location)}</span>`);
        return `
          <a class="event-item" href="${escapeHtml(e.url || '#')}" target="_blank" rel="noopener">
            <p class="event-title">${escapeHtml(e.title)}</p>
            <div class="event-tags">${tags.join('')}</div>
            <p class="event-summary">${escapeHtml(e.summary || '')}</p>
            <span class="event-more">查看原文${e.source ? ' · ' + escapeHtml(e.source) : ''}</span>
          </a>`;
      })
      .join('');
  }
  return cardShell(game, body);
}

function render() {
  const d = state.data;
  if (!d || !d.games) return;
  const games = Object.values(d.games);
  $('#codeGrid').innerHTML = games.map(renderCodes).join('');
  $('#eventGrid').innerHTML = games.map(renderEvents).join('');

  $('#navUpdated').textContent = fmtUpdated(d.meta?.updatedAt);
  if (d.meta?.mode === 'fallback') {
    $('#navUpdated').textContent += ' · 沿用上次数据';
  }

  // 绑定复制
  document.querySelectorAll('.code-copy').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const code = btn.getAttribute('data-code');
      copyText(code).then((ok) => {
        showToast(ok ? `已复制：${code}` : '复制失败，请手动复制');
      });
    });
  });
}

function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text).then(() => true).catch(() => legacyCopy(text));
  }
  return Promise.resolve(legacyCopy(text));
}
function legacyCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) {
    return false;
  }
}

let toastTimer;
function showToast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2200);
}

async function loadData() {
  // 优先用内嵌种子数据（保证 file:// 打开或接口失败时也能渲染出内容）
  let data = window.__SEED__ || null;
  let source = 'seed';
  try {
    const res = await fetch(API_BASE + '/api/data', { cache: 'no-store' });
    if (res.ok) {
      const live = await res.json();
      if (live && live.games && Object.keys(live.games).length) {
        data = live;
        source = (live.meta && live.meta.mode) || 'live';
      }
    }
  } catch (e) {
    /* 接口失败，沿用内嵌种子 */
  }
  if (!data) {
    showToast('数据加载失败，已显示内置内容');
    return;
  }
  state.data = data;
  state.source = source;
  render();
}

async function manualUpdate() {
  const btn = $('#updateBtn');
  const label = $('#updateLabel');
  const spin = $('#spinner');
  btn.disabled = true;
  label.textContent = '更新中';
  spin.hidden = false;
  try {
    const res = await fetch(API_BASE + '/api/update', { method: 'POST' });
    const json = await res.json();
    if (json.ok) {
      await loadData();
      showToast(json.meta?.mode === 'live' ? '已更新最新数据' : '已刷新（沿用上次有效数据）');
    } else {
      showToast('更新失败：' + (json.error || '未知错误'));
    }
  } catch (e) {
    showToast('更新请求失败');
  } finally {
    btn.disabled = false;
    label.textContent = '更新';
    spin.hidden = true;
  }
}

$('#updateBtn').addEventListener('click', manualUpdate);

// 首屏渲染 + 每 5 分钟静默刷新一次（保证打开页面始终较新）
loadData();
setInterval(loadData, 5 * 60 * 1000);
