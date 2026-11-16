/**
 * YCTI 统计写入代理（Cloudflare Worker）
 *
 * 前端 POST /r  { code, lang }
 *   → 服务端带 PAT 往 GitHub results 分支写一条记录
 *   → 立刻用 git trees API 全量重算 stats.json（幂等，不会像增量那样算重）
 *   → GitHub Actions 的定时聚合保留为兜底/校正
 *
 * 为什么不再只靠 Actions：该仓库的 schedule 被 GitHub 限流，
 * 配了每 2 小时实际平均 6 小时才跑一次，用户看到的是"数据没更新"。
 *
 * 安全要点：
 *   1. GitHub PAT 只存在 Worker 加密变量 GH_PAT，浏览器永远看不到
 *   2. 只接受 32 个合法人格 code + 合法语言，杜绝写入垃圾
 *   3. 校验 Origin，只允许 ycti.fun / www.ycti.fun
 *   4. 单 IP 每分钟最多 10 次（尽力而为的轻量限流，不依赖 KV）
 */

const REPO = 'kevinliu0619/ycti';
const BRANCH = 'results';        // 答卷记录分支
const STATS_BRANCH = 'main';     // stats.json 所在分支
const STATS_PATH = 'stats.json';

const ALLOWED_ORIGINS = new Set([
  'https://ycti.fun',
  'https://www.ycti.fun',
]);

// 32 个人格 code，与 imgs/*.webp 一一对应
const CODES = new Set([
  '3776', '6CAN', 'AFRO', 'AQUA', 'ASAKA', 'BOO!', 'BROKE', 'CARB',
  'CHAOS', 'CHEF', 'CHILL', 'CHOO', 'COZY', 'DASH', 'DOGGO', 'DRIVE',
  'LONE', 'LURK', 'MOM', 'MONO', 'NOM', 'OWL', 'PAGE', 'SAGE',
  'SEYANA', 'SHIP', 'SPA', 'SUNNY', 'TSUN', 'USOYARE', 'WAN!', 'WEEP',
]);

const LANGS = new Set(['zh', 'ja']);
const MAX_BODY = 200;

// results/YYYY-MM-DD/<ts>_<rand6>_<CODE>.json
const RECORD_PATH = /^results\/\d{4}-\d{2}-\d{2}\/[^/]+_([A-Z0-9!]+)\.json$/;

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : 'https://ycti.fun';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(obj, cors, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors },
  });
}

function ghHeaders(pat, withContentType) {
  const h = {
    Authorization: `Bearer ${pat}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'YCTI-Worker',
  };
  if (withContentType) h['Content-Type'] = 'application/json';
  return h;
}

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64decode(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * 全量重算 stats.json。
 * 用 git trees 一次拿到 results 分支全部路径（1 个请求），统计总数与各 code 数量，
 * 再读一次当前 stats.json 拿 sha 和 langs，写回。
 * 因为是"重算"而非"累加"，重复执行不会算重（之前 1062 vs 945 的教训）。
 */
async function syncStats(pat, lang) {
  const H = ghHeaders(pat);

  const tr = await fetch(
    `https://api.github.com/repos/${REPO}/git/trees/${BRANCH}?recursive=1`,
    { headers: H }
  );
  if (!tr.ok) return { ok: false, step: 'tree', status: tr.status };

  const tree = (await tr.json()).tree || [];
  const results = {};
  let total = 0;
  for (const e of tree) {
    if (e.type !== 'blob') continue;
    const m = RECORD_PATH.exec(e.path);
    if (!m) continue;
    total++;
    results[m[1]] = (results[m[1]] || 0) + 1;
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await fetch(
      `https://api.github.com/repos/${REPO}/contents/${STATS_PATH}?ref=${STATS_BRANCH}`,
      { headers: H }
    );
    if (!cur.ok) return { ok: false, step: 'get', status: cur.status };
    const data = await cur.json();

    let langs = {};
    try {
      langs = JSON.parse(b64decode(data.content)).langs || {};
    } catch (e) {
      langs = {};
    }
    langs[lang] = (langs[lang] || 0) + 1;

    const body = JSON.stringify({
      message: `stats: ${total} (+1 ${lang})`,
      content: b64encode(JSON.stringify({ total, results, langs })),
      sha: data.sha,
      branch: STATS_BRANCH,
    });

    const put = await fetch(
      `https://api.github.com/repos/${REPO}/contents/${STATS_PATH}`,
      { method: 'PUT', headers: ghHeaders(pat, true), body }
    );
    if (put.ok) return { ok: true, total };
    if (put.status !== 409) {
      return { ok: false, step: 'put', status: put.status, detail: (await put.text()).slice(0, 160) };
    }
    // 409 = 别人刚改过 stats.json，重读 sha 再来
  }
  return { ok: false, step: 'conflict' };
}

// 轻量限流：单 isolate 内存计数。多 isolate 时是"至少"效果，够用即可。
const hits = new Map();

function rateLimited(ip) {
  const window = Math.floor(Date.now() / 60000);
  const key = ip + '|' + window;
  const n = (hits.get(key) || 0) + 1;
  hits.set(key, n);
  if (hits.size > 5000) hits.clear();
  return n > 10;
}

// ============================================================
// /s —— 分享卡诊断页（临时）
// 微信/QQ 抓 GitHub Pages 不成功时，用这个「小、快、边缘可达」的页面做 A/B。
// 同时把每次命中记到 results 分支的 probe/ 下，用来确认抓取器到底来没来。
// ============================================================
const SHARE_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>YCTI · 摇曳露营人格测试</title>
<meta name="description" content="测测你最像摇曳露营里的谁">
<link rel="image_src" href="https://api.ycti.fun/share-card.jpg">
<meta property="og:type" content="website">
<meta property="og:site_name" content="YCTI">
<meta property="og:title" content="YCTI · 摇曳露营人格测试">
<meta property="og:description" content="测测你最像摇曳露营里的谁">
<meta property="og:url" content="https://api.ycti.fun/s">
<meta property="og:image" content="https://api.ycti.fun/share-card.jpg">
<meta property="og:image:type" content="image/jpeg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<style>body{margin:0;background:#141428;color:#e8e0d8;font-family:sans-serif;
display:flex;align-items:center;justify-content:center;height:100vh;text-align:center}</style>
</head><body><img src="https://api.ycti.fun/share-card.jpg" alt="YCTI"
 style="position:absolute;left:-9999px;width:1200px;height:630px">
<div><h1 style="font-size:22px">YCTI · 摇曳露营人格测试</h1>
<p style="color:#9a8c7a">分享卡诊断页 · <a href="https://ycti.fun/" style="color:#e8a850">去测试</a></p></div>
</body></html>`;

async function logProbe(pat, request) {
  if (!pat) return;
  const ua = request.headers.get('User-Agent') || '';
  const rec = {
    ts: new Date().toISOString(),
    path: new URL(request.url).pathname,
    ua: ua.slice(0, 200),
    country: request.headers.get('CF-IPCountry') || '',
    isWeChat: /MicroMessenger|WeChat/i.test(ua),
    isQQ: /QQ\//i.test(ua),
  };
  const name = 'probe/' + Date.now() + '_' + Math.random().toString(36).slice(2, 7) + '.json';
  try {
    await fetch('https://api.github.com/repos/' + REPO + '/contents/' + name, {
      method: 'PUT',
      headers: ghHeaders(pat, true),
      body: JSON.stringify({
        message: 'probe: share hit',
        content: b64encode(JSON.stringify(rec)),
        branch: BRANCH,
      }),
    });
  } catch (e) {}
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // 分享卡诊断页（临时 A/B 用）
    if (url.pathname === '/s') {
      if (env.GH_PAT && ctx && ctx.waitUntil) {
        ctx.waitUntil(logProbe(env.GH_PAT, request).catch(() => {}));
      }
      return new Response(SHARE_HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    // 分享图：由 Worker 取一次 GitHub Pages 的图，之后长期缓存在 CF 边缘
    if (url.pathname === '/share-card.jpg') {
      if (env.GH_PAT && ctx && ctx.waitUntil) {
        ctx.waitUntil(logProbe(env.GH_PAT, request).catch(() => {}));
      }
      const r = await fetch('https://ycti.fun/share-card.jpg', {
        cf: { cacheEverything: true, cacheTtl: 604800 },
      });
      const h = new Headers(r.headers);
      h.set('Cache-Control', 'public, max-age=604800');
      h.set('Content-Type', 'image/jpeg');
      return new Response(r.body, { status: r.status, headers: h });
    }

    // 健康检查：用来验证自定义域名是否可达
    if (url.pathname === '/ping') {
      return json({ ok: true, ts: Date.now(), repo: REPO, branch: BRANCH }, cors);
    }

    // 统计读取：用 PAT 现读最新 stats.json
    // 为什么不让前端直接读 raw.githubusercontent：它有 5 分钟 CDN 缓存，
    // 答卷后页面几乎立刻看到"没更新"；这个域名在国内也常被污染。
    if (url.pathname === '/stats') {
      if (request.method !== 'GET') {
        return json({ ok: false, error: 'method_not_allowed' }, cors, 405);
      }
      if (!env.GH_PAT) {
        return json({ ok: false, error: 'server_misconfigured' }, cors, 500);
      }
      let cur;
      try {
        cur = await fetch(
          `https://api.github.com/repos/${REPO}/contents/${STATS_PATH}?ref=${STATS_BRANCH}`,
          { headers: ghHeaders(env.GH_PAT) }
        );
      } catch (e) {
        return json({ ok: false, error: 'github_unreachable' }, cors, 502);
      }
      if (!cur.ok) {
        return json({ ok: false, error: 'stats_unavailable', status: cur.status }, cors, 502);
      }
      const data = await cur.json();
      let body;
      try {
        body = b64decode(data.content);
      } catch (e) {
        return json({ ok: false, error: 'decode_failed' }, cors, 502);
      }
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=30',
          ...cors,
        },
      });
    }

    if (url.pathname !== '/r') {
      return json({ ok: false, error: 'not_found' }, cors, 404);
    }
    if (request.method !== 'POST') {
      return json({ ok: false, error: 'method_not_allowed' }, cors, 405);
    }
    if (!ALLOWED_ORIGINS.has(origin)) {
      return json({ ok: false, error: 'bad_origin' }, cors, 403);
    }

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (rateLimited(ip)) {
      return json({ ok: false, error: 'rate_limited' }, cors, 429);
    }

    const len = Number(request.headers.get('Content-Length') || 0);
    if (len > MAX_BODY) {
      return json({ ok: false, error: 'body_too_large' }, cors, 413);
    }

    let code = '';
    let lang = 'zh';
    try {
      const body = await request.json();
      code = String(body.code || '').trim();
      lang = String(body.lang || 'zh').trim();
    } catch (e) {
      return json({ ok: false, error: 'bad_json' }, cors, 400);
    }

    if (!CODES.has(code)) {
      return json({ ok: false, error: 'bad_code' }, cors, 400);
    }
    if (!LANGS.has(lang)) lang = 'zh';

    if (!env.GH_PAT) {
      return json({ ok: false, error: 'server_misconfigured' }, cors, 500);
    }

    const ts = Math.floor(Date.now() / 1000);
    const date = new Date(ts * 1000).toISOString().slice(0, 10);
    const rnd = Math.random().toString(36).slice(2, 8);
    const path = `results/${date}/${ts}_${rnd}_${code}.json`;

    let gh;
    try {
      gh = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
        method: 'PUT',
        headers: ghHeaders(env.GH_PAT, true),
        body: JSON.stringify({
          message: `record: ${code}`,
          content: b64encode(JSON.stringify({ code, lang })),
          branch: BRANCH,
        }),
      });
    } catch (e) {
      return json({ ok: false, error: 'github_unreachable', detail: String(e).slice(0, 120) }, cors, 502);
    }

    if (!gh.ok) {
      const detail = (await gh.text()).slice(0, 200);
      return json({ ok: false, error: 'github_write_failed', status: gh.status, detail }, cors, 502);
    }

    // 记录写入成功 → 后台立刻重算 stats.json（失败不影响这次答卷，Actions 定时任务会兜底）
    if (ctx && ctx.waitUntil) {
      ctx.waitUntil(
        syncStats(env.GH_PAT, lang).catch(() => {})
      );
    }

    return json({ ok: true, code, ts }, cors);
  },
};