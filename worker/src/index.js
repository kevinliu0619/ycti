/**
 * YCTI 统计写入代理（Cloudflare Worker）
 *
 * 前端 POST /r  { code, lang }
 *   → 服务端带 PAT 往 GitHub results 分支写一条记录
 *   → GitHub Actions 定时聚合成 stats.json（原链路不变）
 *
 * 安全要点：
 *   1. GitHub PAT 只存在 Worker 加密变量 GH_PAT，浏览器永远看不到
 *   2. 只接受 32 个合法人格 code + 合法语言，杜绝写入垃圾
 *   3. 校验 Origin，只允许 ycti.fun / www.ycti.fun
 *   4. 单 IP 每分钟最多 10 次（尽力而为的轻量限流，不依赖 KV）
 */

const REPO = 'kevinliu0619/ycti';
const BRANCH = 'results';

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // 健康检查：用来验证自定义域名是否可达
    if (url.pathname === '/ping') {
      return json({ ok: true, ts: Date.now(), repo: REPO, branch: BRANCH }, cors);
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
    const content = btoa(JSON.stringify({ code, lang }));

    let gh;
    try {
      gh = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${env.GH_PAT}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'YCTI-Worker',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message: `record: ${code}`, content, branch: BRANCH }),
      });
    } catch (e) {
      return json({ ok: false, error: 'github_unreachable', detail: String(e).slice(0, 120) }, cors, 502);
    }

    if (!gh.ok) {
      const detail = (await gh.text()).slice(0, 200);
      return json({ ok: false, error: 'github_write_failed', status: gh.status, detail }, cors, 502);
    }

    return json({ ok: true, code, ts }, cors);
  },
};