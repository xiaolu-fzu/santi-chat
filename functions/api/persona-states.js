import { json, CORS, readState, readAllPersonas, personaState, readStaticPersonas, FREE_CHARS } from './_lib.js';

export async function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

export async function onRequestGet({ request, env }) {
  const client = String(new URL(request.url).searchParams.get('client') || 'anon').slice(0, 64);
  const st = await readState(env, client);
  const auto = await readAllPersonas(env);
  const stat = await readStaticPersonas(request, env);
  const mf = await (await env.ASSETS.fetch(new URL('/ragdata/manifest.json', request.url))).json();
  const roster = mf.roster || {};

  const out = {}, hasCard = {};
  for (const n of Object.keys(roster)) {
    const raw = personaState(n, auto, stat);
    hasCard[n] = raw === 'written' || raw === 'cached';
    // 白名单外 → 一律锁；已解锁过的 → 恢复真实状态
    out[n] = (FREE_CHARS.has(n) || st.unlocked.includes(n)) ? raw : 'locked';
  }
  return json({ states: out, free: [...FREE_CHARS], has_card: hasCard, roster });
}
