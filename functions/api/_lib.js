/* 共用常量与 KV 辅助。文件名以 _ 开头，Cloudflare Pages 不会把它当成路由。 */

export const FREE_UNLOCKS = 2;      // 每位访客最多「花钱生成」几张角色卡
export const MSG_LIMIT = 10;        // 每个角色最多对话几条
export const LLM_BASE = 'https://api.deepseek.com';
export const LLM_MODEL = 'deepseek-chat';

// 白名单：只有这几位直接开放，其余需要显式解锁
export const FREE_CHARS = new Set(['史强','汪淼','章北海','智子','雷迪亚兹','关一帆','AA']);

// 手写人设（质量最高，解锁不消耗额度）
export const HANDWRITTEN = new Set(['罗辑','程心','叶文洁','史强','章北海','维德','智子']);

export const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

export async function readState(env, client) {
  const st = await env.SANTI.get('q:' + client, 'json');
  return st || { unlocked: [], spent: 0, msgs: {}, unlimited: false };
}
export async function writeState(env, client, st) {
  await env.SANTI.put('q:' + client, JSON.stringify(st));
}
/* 所有自动生成的人设存在同一个 key 下 —— 一次读就能拿到全部，
   比每个角色一个 key 省很多 KV 读次数（免费额度 10 万次/天）。 */
export async function readAllPersonas(env) {
  return (await env.SANTI.get('personas:auto', 'json')) || {};
}
export async function writePersona(env, name, p) {
  const all = await readAllPersonas(env);
  all[name] = p;
  await env.SANTI.put('personas:auto', JSON.stringify(all));
}
/* 状态判定：手写 → written；静态文件或 KV 里已有 → cached；否则 locked */
export function personaState(name, autoMap, staticMap) {
  if (HANDWRITTEN.has(name)) return 'written';
  if ((staticMap && staticMap[name]) || autoMap[name]) return 'cached';
  return 'locked';
}

/** 读静态人设（与浏览器下载的是同一份，不重复维护） */
export async function readStaticPersonas(request, env) {
  try {
    const r = await env.ASSETS.fetch(new URL('/ragdata/personas.json', request.url));
    return await r.json();
  } catch (e) { return {}; }
}

/** 从静态资源里读 manifest，拿到角色名单与台词条数 */
export async function readManifest(request, env) {
  const url = new URL('/ragdata/manifest.json', request.url);
  const r = await env.ASSETS.fetch(url);
  return await r.json();
}

/** 调 DeepSeek，返回原始 Response（stream 时是 SSE 流，直接透传） */
export function callDeepSeek(env, { messages, temperature = 0.8, max_tokens = 800, stream = true }) {
  return fetch(LLM_BASE + '/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + (env.DEEPSEEK_API_KEY || ''),
    },
    body: JSON.stringify({ model: LLM_MODEL, messages, temperature, max_tokens, stream }),
  });
}

/** 非流式调用，直接拿文本 */
export async function askOnce(env, messages, temperature = 0, max_tokens = 700) {
  const r = await callDeepSeek(env, { messages, temperature, max_tokens, stream: false });
  if (!r.ok) throw new Error('DeepSeek ' + r.status + ': ' + (await r.text()).slice(0, 200));
  const d = await r.json();
  return (d.choices && d.choices[0] && d.choices[0].message.content) || '';
}

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
