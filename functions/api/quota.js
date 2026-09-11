import { json, CORS, readState, FREE_UNLOCKS, MSG_LIMIT } from './_lib.js';

export async function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

export async function onRequestGet({ request, env }) {
  const client = String(new URL(request.url).searchParams.get('client') || 'anon').slice(0, 64);
  const st = await readState(env, client);
  return json({
    unlimited: !!st.unlimited,
    unlocked: st.unlocked.length,
    spent: st.spent || 0,
    unlock_limit: FREE_UNLOCKS,
    msgs: st.msgs || {},
    msg_limit: MSG_LIMIT,
  });
}
