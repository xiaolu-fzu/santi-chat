import { json, CORS, readState, writeState } from './_lib.js';

export async function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: '请求体不合法' }, 400); }
  const client = String(body.client || 'anon').slice(0, 64);
  const code = String(body.code || '').trim();
  const want = env.ACCESS_CODE || 'LJH';
  if (code !== want) return json({ ok: false, error: '口令不正确' }, 403);
  const st = await readState(env, client);
  st.unlimited = true;
  await writeState(env, client, st);
  return json({ ok: true, unlimited: true });
}
