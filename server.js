// 米哈游兑换码 & 线下活动 H5 页面 —— 零依赖 Node 服务
// 功能：托管前端 / 提供 /api/data / 手动与每日自动更新 / 从米游社官方接口抓取联名/活动/兑换码
// 运行：node server.js   （默认端口 8787，可用 PORT 环境变量覆盖）
// Railway 触发时间戳: 2026-07-09T17:46:00+08:00

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'data', 'data.json');
const PUBLIC_DIR = ROOT;
const PORT = process.env.PORT || 3000;

// 手动刷新密码（公网/本地均需，防误触与滥用）。部署时在环境变量中设定；
// 这里写入的仅为默认值，运行时以环境变量 REFRESH_KEY 为准。
const REFRESH_KEY = process.env.REFRESH_KEY || '522529';

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
    console.error('读取 data.json 失败:', e.message);
    return null;
  }
}
function saveData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('写入 data.json 失败:', e.message);
    return false;
  }
}

// ---------- 米游社官方接口抓取（2026-07-09 实测可用） ----------
// game_id 映射（bbs-api.miyoushe.com/searchPosts?gids=N 验证）：
//   gids=1 → 原神  |  gids=5 → 崩坏：星穹铁道  |  gids=6 → 绝区零
// 注意：gids 搜索接口对原神/绝区零会返回跨游戏污染内容（崩坏3 / 星铁官方帖），
// 故正式抓取改用已实测确认的官方版块 forum_id：原神=28 | 星穹铁道=53 | 绝区零=58 （2026-07-18 验证）
// API: https://bbs-api.miyoushe.com/post/wapi/searchPosts?gids={gids}&keyword={kw}&page_size=10
// 关键字段: post.is_official=true 为官方账号 post.certification.type=1 为认证
// URL格式: https://miyoushe.com/{game_slug}/article/{post_id}
// game_slug: ys=原神  sr=星穹铁道  zzz=绝区零

const GAME_META = {
  genshin: {
    gids: 1,
    name: '原神',
    slug: 'ys',
    community: 'https://www.miyoushe.com/ys/',
  },
  sr: {
    gids: 5,
    name: '崩坏：星穹铁道',
    slug: 'sr',
    community: 'https://www.miyoushe.com/sr/',
  },
  zzz: {
    gids: 6,
    name: '绝区零',
    slug: 'zzz',
    community: 'https://www.miyoushe.com/zzz/',
  },
  // 以下三款游戏不在米游社，无官方 BBS API，保持空结构
  // 数据来源由前端 __SEED__ 种子数据 + 人工维护
  wuwa:    { gids: null, name: '鸣潮',     slug: 'wuwa',      community: 'https://www.kurogame.com/' },
  endfield:{ gids: null, name: '终末地',   slug: 'endfield', community: 'https://ak.hypergryph.com/' },
  yuhuan:  { gids: null, name: '异环',     slug: 'yuhuan',    community: 'https://www.taptap.com/app/198030' },
};

// 兑换码为人工维护种子数据：米游社官方兑换码发布于直播画面/图片/专门兑换页/游戏内邮件，
// 不在帖子正文纯文本中，正则自动提取不可行（实测 30 条绝区零官方帖正文 0 条含明文码）。
// 在此维护各游戏当前可用兑换码；每日更新只刷新联名/活动，绝不在此处清空种子。
// 字段：{ code: 'XXXXXX', reward: '说明', published: 'YYYY-MM-DD', source: '官方/手动', reliable: true }
const SEED_CODES = {
  genshin:  [],
  sr:       [],
  zzz:      [],
  wuwa:     [],
  endfield: [],
  yuhuan:   [],
};

const BBS_API = 'https://bbs-api.miyoushe.com';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Referer': 'https://bbs-api.miyoushe.com/',
  'Accept': 'application/json, text/plain, */*',
};

// 通用的带超时 fetch
async function safeFetch(url, ms = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { headers: HEADERS, signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// 从米游社搜索官方联名/公告帖
// slug: 米游社区分（ys=原神 sr=星穹铁道 zzz=绝区零）
// keywords: 搜索关键词列表（依次尝试，第一个有结果即停）
// isOfficial: 是否只取官方认证帖
async function searchOfficialPosts(gids, slug, keywords, isOfficial = true) {
  for (const kw of keywords) {
    try {
      const url = `${BBS_API}/post/wapi/searchPosts?gids=${gids}&keyword=${encodeURIComponent(kw)}&page_size=15`;
      const json = await safeFetch(url);
      const posts = json?.data?.posts || [];
      if (!posts.length) continue;

      // 过滤官方认证帖（官方认证type=1 或 is_official=true）
      const filtered = isOfficial
        ? posts.filter((p) => p?.post?.post_status?.is_official || p?.user?.certification?.type === 1)
        : posts;

      return filtered.map((p) => {
        const post = p.post || p;
        const officialLabel = p.user?.certification?.label || '';
        // URL slug：优先跟随官方账号 label（跨版块发帖时），其次跟随版块
        const urlSlug = resolveOfficialGameSlug(officialLabel) || resolveForumSlug(p.forum) || slug;
        return {
          title: post.subject || '',
          publishedTs: (post.created_at || 0) * 1000,
          postUrl: `https://miyoushe.com/${urlSlug}/article/${post.post_id}`,
          postId: post.post_id,
          cover: post.cover || p.cover?.url || '',
          summary: (post.content || '').replace(/\{\"insert.*?\}\}/g, '').slice(0, 150),
          official: post.post_status?.is_official || false,
          officialLabel,
          stat: p.stat || {},
          forum: p.forum || {},
        };
      });
    } catch (e) {
      console.warn(`  [gids=${gids}] 关键词"${kw}" 搜索失败: ${e.message}`);
    }
  }
  return [];
}

// forum_id → slug 映射（经实测确认）
const FORUM_ID_MAP = {
  1:  'ys',   // 甲板 - 原神
  4:  'ys',   // 原神另一版块
  6:  'ys',   // 原神官方活动版（实测偶见崩坏3帖，按 slug 归原神）
  26: 'sr',   // 星穹铁道相关
  28: 'ys',   // 原神官方版（2026-07-18 实测：含原神祈愿/周边官方帖）
  29: 'sr',
  34: 'sr',   // 星穹铁道生活版
  53: 'sr',   // 星穹铁道官方版（2026-07-18 实测确认）
  58: 'zzz',  // 绝区零官方版（2026-07-18 实测确认；原映射 52/53 均非绝区零）
};

function resolveForumSlug(forum) {
  if (!forum) return 'ys';
  if (forum.id && FORUM_ID_MAP[forum.id]) return FORUM_ID_MAP[forum.id];
  if (forum.game_id) {
    const map = { 1: 'ys', 5: 'sr', 6: 'zzz' };
    return map[forum.game_id] || 'ys';
  }
  return 'ys';
}

// 从版块直接拉官方帖
async function fetchForumPosts(forumId, slug, pageSize = 10) {
  try {
    const url = `${BBS_API}/post/wapi/getForumPostList?forum_id=${forumId}&is_good=false&is_hot=false&page_size=${pageSize}&sort_type=1`;
    const json = await safeFetch(url);
    const posts = json?.data?.list || [];
    return posts
      .filter((p) => p?.post?.post_status?.is_official)
      .map((p) => {
        const post = p.post;
        const officialLabel = p.user?.certification?.label || '';
        const urlSlug = resolveOfficialGameSlug(officialLabel) || resolveForumSlug(p.forum) || slug;
        return {
          title: post.subject || '',
          publishedTs: (post.created_at || 0) * 1000,
          postUrl: `https://miyoushe.com/${urlSlug}/article/${post.post_id}`,
          postId: post.post_id,
          cover: post.cover || p.cover?.url || '',
          summary: (post.content || '').replace(/\{\"insert.*?\}\}/g, '').slice(0, 150),
          official: true,
          officialLabel: p.user?.certification?.label || '',
          stat: p.stat || {},
          forum: p.forum || {},
        };
      });
  } catch (e) {
    console.warn(`  [forum=${forumId}] 版块抓取失败: ${e.message}`);
    return [];
  }
}

// 从帖子列表中筛选"联名/联动"相关（标题/摘要含关键词）且在两个月内
function pickCollabPosts(posts, now) {
  const TWO_MONTHS = 60 * 24 * 3600 * 1000;
  const KW = ['联名', '联动', '合作', '×', 'X ', '品牌', '跨界', '授权'];
  return posts
    .filter((p) => p.title && p.publishedTs)
    .filter((p) => now - p.publishedTs <= TWO_MONTHS)
    .filter((p) => KW.some((k) => (p.title + p.summary).includes(k)));
}

// 从帖子列表中筛选"线下活动"相关
function pickOfflinePosts(posts, now) {
  const TWO_MONTHS = 60 * 24 * 3600 * 1000;
  const KW = ['线下', '快闪', '展会', '漫展', '嘉年华', '展览', '展台', '打卡', 'FES', 'BW2026', 'BW2025', 'GAF', '参展', '主题店'];
  return posts
    .filter((p) => p.title && p.publishedTs)
    .filter((p) => now - p.publishedTs <= TWO_MONTHS)
    .filter((p) => KW.some((k) => (p.title + p.summary).includes(k)));
}

// 筛选"兑换码/前瞻"相关（两周内）
function pickCodePosts(posts, now) {
  const TWO_WEEKS = 14 * 24 * 3600 * 1000;
  const KW = ['兑换码', '前瞻', '礼包码', 'cdk', 'CDK', '码', '码：'];
  return posts
    .filter((p) => p.title && p.publishedTs)
    .filter((p) => now - p.publishedTs <= TWO_WEEKS)
    .filter((p) => KW.some((k) => (p.title + p.summary).includes(k)));
}

// 从 URL 中提取 post_id（如 https://miyoushe.com/sr/article/76461582）
function extractPostId(url) {
  const m = String(url || '').match(/article\/(\d+)/);
  return m ? m[1] : '';
}

// 尝试从文本中提取疑似兑换码
function extractCodes(text) {
  const matches = text.match(/[A-Z0-9]{6,18}/g) || [];
  return [...new Set(matches)].filter((m) => /[A-Z]/.test(m) && /[0-9]/.test(m));
}

// 统一输出格式（联名活动）
function formatCollab(p) {
  return {
    postId: p.postId || '',
    title: p.title,
    published: new Date(p.publishedTs).toISOString().slice(0, 10),
    url: p.postUrl,
    summary: p.summary,
    official: p.official,
    officialLabel: p.officialLabel,
    viewCount: p.stat?.view_num || 0,
    replyCount: p.stat?.reply_num || 0,
    likeCount: p.stat?.like_num || 0,
  };
}

// 统一输出格式（线下活动）
function formatOffline(p) {
  return {
    postId: p.postId || '',
    title: p.title,
    published: new Date(p.publishedTs).toISOString().slice(0, 10),
    url: p.postUrl,
    summary: p.summary,
    source: p.officialLabel || '米游社官方',
  };
}

// 官方认证账号 label → 游戏 slug 映射
// API 返回的 label 有多种变体（如"崩坏：星穹铁道" vs "崩坏：星铁..."）
// 所以优先用关键词模糊匹配而非精确匹配。
function resolveOfficialGameSlug(officialLabel, defaultSlug) {
  if (!officialLabel) return defaultSlug;
  // 模糊匹配（label 包含关键词，区分"原神"vs"崩坏"防止混淆）
  if (/^原神/.test(officialLabel)) return 'genshin';
  if (/崩坏.*星/.test(officialLabel)) return 'sr';   // 星穹铁道 / 星铁...
  if (/绝区零/.test(officialLabel)) return 'zzz';
  if (/(?<!星)崩坏3/.test(officialLabel)) return 'honkai3rd'; // 排除"崩坏：星铁"只匹配"崩坏3"
  if (/未定/.test(officialLabel)) return '未定';
  return defaultSlug;
}

// 是否为"星穹铁道官方账号"（含所有变体）
function isHSROfficial(officialLabel) {
  if (!officialLabel) return false;
  return /崩坏.*星/.test(officialLabel); // 匹配"崩坏：星穹铁道官方账号"等变体
}

// ---------- 更新流程（米游社三游戏：原神/星铁/绝区零） ----------
async function doUpdate() {
  const data = loadData() || { meta: {}, games: {} };
  const now = Date.now();
  let changed = false;
  let liveCount = 0;
  // 跨游戏归因池：在各游戏抓取后暂存，再写入对应游戏
  const crossCollabs = [];
  const crossEvents = [];

  // 已知有效版块（2026-07-18 实测确认）：
  //   genshin: forum_id=28 (原神官方版)  |  sr: forum_id=53 (星穹铁道官方版)  |  zzz: forum_id=58 (绝区零官方版)
  const FORUM_MAP = { genshin: 28, sr: 53, zzz: 58 };
  // 搜索关键词优先级
  const COLLAB_KWS = ['联名', '联动', '合作'];
  const CODE_KWS   = ['兑换码', '前瞻', '礼包'];

  for (const slug of ['genshin', 'sr', 'zzz']) {
    const meta = GAME_META[slug];
    if (!meta.gids) continue; // 非米游社游戏跳过

    const game = data.games?.[slug] || (data.games[slug] = {});

    try {
      console.log(`[${meta.name}] 开始抓取...`);

      let posts = [];

      // 策略1（genshin/zzz）：搜索 API（精准匹配本游戏官方内容，避免跨版块混入）
      // 策略1（sr）：官方版块（forum_id=53 直接获取）
      // 策略2（通用）：官方版块补充（兜底遗漏）
      if (slug === 'genshin' || slug === 'zzz') {
        // gids 搜索接口对原神/绝区零返回跨游戏污染内容（崩坏3 / 星铁），故改用
        // 已实测确认的官方版块（FORUM_MAP: 原神=28 / 绝区零=58）为主源。
        const forumId = FORUM_MAP[slug];
        const forumPosts = await fetchForumPosts(forumId, meta.slug, 20);
        if (forumPosts.length) {
          posts = forumPosts;
          console.log(`  官方版块(${forumId}): +${forumPosts.length} 条`);
        }
      } else {
        // sr：优先官方版块（forum_id=53）
        const forumId = FORUM_MAP[slug];
        const forumPosts = await fetchForumPosts(forumId, meta.slug, 20);
        if (forumPosts.length) { posts = forumPosts; console.log(`  官方版块: +${forumPosts.length} 条`); }
        // 搜索 API 补充
        const searchPosts = await searchOfficialPosts(meta.gids, meta.slug, [...COLLAB_KWS, ...CODE_KWS], true);
        if (searchPosts.length) {
          const seen = new Set(posts.map((p) => p.postId));
          const newPosts = searchPosts.filter((p) => !seen.has(p.postId));
          posts.push(...newPosts);
          if (newPosts.length) console.log(`  搜索补充: +${newPosts.length} 条`);
        }
      }

      if (!posts.length) {
        console.warn(`[${meta.name}] 无有效帖子，尝试补全...`);
        const retry = await searchOfficialPosts(meta.gids, meta.slug, ['公告', '活动', '福利'], false);
        if (retry.length) posts = retry;
      }

      if (!posts.length) {
        console.warn(`[${meta.name}] 抓取为空，保留历史数据`);
        continue;
      }

      liveCount++;

      // --- 联名活动（按官方账号 label 归因到正确游戏） ---
      // 关键：无论过滤后是 0 还是 N 条，都强制覆盖 game.collabs，
      // 否则旧数据（如 zzz 残留的 HSR 帖）会一直保留。
      const collabs = pickCollabPosts(posts, now);
      {
        const reAssigned = collabs.map((p) => ({
          ...p,
          _assignedSlug: resolveOfficialGameSlug(p.officialLabel, slug),
        }));

        // 对于 zzz：排除星穹铁道官方账号发的帖（HSR 联动，应归到 sr）
        // 对于 genshin：排除崩坏3资讯发布的帖（来自 honkai3rd 官方）
        const filtered = reAssigned.filter((p) => {
          if (slug === 'zzz' && isHSROfficial(p.officialLabel)) return false;
          if (slug === 'genshin' && /(?<!星)崩坏3/.test(p.officialLabel)) return false;
          return true;
        });

        const localCollabs = filtered
          .filter((p) => p._assignedSlug === slug)
          .map(formatCollab);
        if (localCollabs.length || (game.collabs && game.collabs.length)) {
          game.collabs = localCollabs.slice(0, 6);
          changed = true;
          if (localCollabs.length) console.log(`  联名(本游戏): +${localCollabs.length} 条`);
          else console.log(`  联名(本游戏): 0 条（已清空旧数据）`);
        }

        const crossPost = filtered.filter((p) => p._assignedSlug !== slug);
        if (crossPost.length) {
          crossCollabs.push(...crossPost.map((p) => ({ ...p, _fromSlug: slug })));
        }
      }

      // --- 线下活动（按官方账号 label 归因，zzz 排除 HSR 帖） ---
      const events = pickOfflinePosts(posts, now);
      {
        const reAssigned = events.map((p) => ({
          ...p,
          _assignedSlug: resolveOfficialGameSlug(p.officialLabel, slug),
        }));
        // zzz 排除星穹铁道官方账号的帖；genshin 排除崩坏3资讯发布的帖
        const filtered = reAssigned.filter((p) => {
          if (slug === 'zzz' && isHSROfficial(p.officialLabel)) return false;
          if (slug === 'genshin' && /(?<!星)崩坏3/.test(p.officialLabel)) return false;
          return true;
        });
        const localEvents = filtered
          .filter((p) => p._assignedSlug === slug)
          .map(formatOffline);
        if (localEvents.length || (game.events && game.events.length)) {
          game.events = localEvents.slice(0, 8);
          changed = true;
          if (localEvents.length) console.log(`  线下(本游戏): +${localEvents.length} 条`);
          else console.log(`  线下(本游戏): 0 条（已清空旧数据）`);
        }
        const crossEvent = filtered.filter((p) => p._assignedSlug !== slug);
        if (crossEvent.length) {
          crossEvents.push(...crossEvent.map((p) => ({ ...p, _fromSlug: slug })));
        }
      }

      // --- 兑换码（人工维护种子：米游社帖正文无明文码，自动提取不可行） ---
      // 自动提取仅作尽力补充；种子与自动皆空时保留已有数据，不强制清空。
      const codePosts = pickCodePosts(posts, now);
      const autoCodes = [];
      for (const cp of codePosts) {
        const found = extractCodes(cp.title + ' ' + cp.summary);
        for (const c of found) {
          autoCodes.push({
            code: c,
            reward: cp.title,
            published: new Date(cp.publishedTs).toISOString().slice(0, 10),
            source: '米游社官方',
            reliable: cp.official,
          });
        }
      }
      const seed = (data.seedCodes && data.seedCodes[slug]) || SEED_CODES[slug] || [];
      const merged = [...seed];
      for (const c of autoCodes) {
        if (!merged.some((m) => m.code === c.code)) merged.push(c);
      }
      if (merged.length || (game.codes && game.codes.length)) {
        game.codes = merged.slice(0, 12);
        changed = true;
        if (merged.length) console.log(`  兑换码: +${merged.length} 条（种子${seed.length}/自动${autoCodes.length}）`);
      }
    } catch (e) {
      console.warn(`[${meta.name}] 抓取失败，保留上次数据: ${e.message}`);
    }
  }

  // ========== 跨游戏归因：将跨版块发的帖写入对应游戏 ==========
  const CROSS_GAMES = ['genshin', 'sr', 'zzz'];
  const seenPostIds = new Set();

  // 先收集所有本游戏 collabs 的 postId（去重用）
  for (const g of CROSS_GAMES) {
    const existing = data.games?.[g]?.collabs || [];
    for (const c of existing) seenPostIds.add(c.postId || extractPostId(c.url));
  }

  // 将跨游戏 collabs 写入对应游戏（去重，不覆盖已有）
  for (const cp of crossCollabs) {
    const targetSlug = cp._assignedSlug;
    if (!CROSS_GAMES.includes(targetSlug)) continue; // honkai3rd/未定等跳过
    if (seenPostIds.has(cp.postId)) continue;       // 已在目标游戏出现过则跳过
    seenPostIds.add(cp.postId);
    const targetGame = data.games[targetSlug] || (data.games[targetSlug] = {});
    if (!targetGame.collabs) targetGame.collabs = [];
    // 插入到前面（最新的优先）
    const formatted = formatCollab(cp);
    targetGame.collabs.unshift(formatted);
    if (targetGame.collabs.length > 6) targetGame.collabs = targetGame.collabs.slice(0, 6);
    changed = true;
    console.log(`  ↳ [${GAME_META[targetSlug]?.name || targetSlug}] 归因联名: "${cp.title.slice(0, 30)}"`);
  }

  // 跨游戏线下活动同理
  for (const ep of crossEvents) {
    const targetSlug = ep._assignedSlug;
    if (!CROSS_GAMES.includes(targetSlug)) continue;
    if (seenPostIds.has(ep.postId)) continue;
    seenPostIds.add(ep.postId);
    const targetGame = data.games[targetSlug] || (data.games[targetSlug] = {});
    if (!targetGame.events) targetGame.events = [];
    targetGame.events.unshift(formatOffline(ep));
    if (targetGame.events.length > 8) targetGame.events = targetGame.events.slice(0, 8);
    changed = true;
  }

  // 非米游社三游戏（wuwa/endfield/yuhuan）不自动抓取，保持种子数据
  data.meta = data.meta || {};
  data.meta.updatedAt = new Date().toISOString();
  data.meta.mode = liveCount > 0 ? 'live' : 'fallback';
  data.meta.note = liveCount > 0
    ? `已从米游社抓取 ${liveCount} 款游戏（${['genshin','sr','zzz'].slice(0,liveCount).map(s=>GAME_META[s].name).join('、')}）的联名/活动/兑换码数据。`
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

  // 健康检查(Railway HTTP 代理需要快速响应)
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

  // API: 手动更新（需密码，公网/本地均校验）
  if (pathname === '/api/update' && req.method === 'POST') {
    const provided = (new URL(req.url, 'http://localhost')).searchParams.get('key') || req.headers['x-refresh-key'] || '';
    if (provided !== REFRESH_KEY) {
      return serveApi(res, 401, { ok: false, error: '密码错误' });
    }
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
  console.log(`米哈游活动/兑换码 H5 已启动: http://localhost:${PORT}`);
  // 启动即执行一次自动更新尝试
  doUpdate().then((m) =>
    console.log(`[自动更新] 模式=${m.mode} | ${m.note}`)
  );
});

// 每日自动更新(本地时间 09:00)
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
