import { json, CORS, readState, writeState, readAllPersonas, writePersona,
         readStaticPersonas, HANDWRITTEN, FREE_UNLOCKS, askOnce } from './_lib.js';

export async function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

const handwritten = readStaticPersonas;   // 与浏览器下载的是同一份静态文件

/* GET ?name=X —— 只查询，绝不生成（生成要花钱，必须用户确认） */
export async function onRequestGet({ request, env }) {
  const name = String(new URL(request.url).searchParams.get('name') || '').trim();
  if (!name) return json({ state: 'locked' });
  const hw = await handwritten(request, env);
  if (hw[name]) return json({ name, persona: hw[name], state: 'written' });
  const auto = await readAllPersonas(env);
  if (auto[name]) return json({ name, persona: auto[name], state: 'cached' });
  const mf = await (await env.ASSETS.fetch(new URL('/ragdata/manifest.json', request.url))).json();
  return json({ name, persona: null, state: 'locked', lines: (mf.roster || {})[name] || 0 });
}

/* POST { client, name, samples } —— 显式生成角色卡
   台词样本由浏览器从本地数据里抽好传上来，后端不需要存整本小说 */
export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ state: 'error', error: '请求体不合法' }, 400); }
  const name = String(body.name || '').trim();
  const client = String(body.client || 'anon').slice(0, 64);
  if (!name) return json({ state: 'error', error: '缺少 name' }, 400);

  const hw = await handwritten(request, env);
  if (hw[name]) return json({ name, persona: hw[name], state: 'written' });   // 手写的不重新生成

  const auto = await readAllPersonas(env);
  if (auto[name]) {                                                          // 已有缓存，免费放行
    const st = await readState(env, client);
    if (!st.unlocked.includes(name)) { st.unlocked.push(name); await writeState(env, client, st); }
    return json({ name, persona: auto[name], state: 'cached', spent: st.spent || 0, unlock_limit: FREE_UNLOCKS });
  }

  const st = await readState(env, client);
  const already = st.unlocked.includes(name);
  if (!st.unlimited && !already && (st.spent || 0) >= FREE_UNLOCKS) {
    return json({
      code: 'unlock_limit', used: st.spent || 0, limit: FREE_UNLOCKS,
      message: '生成新角色卡已达上限（' + FREE_UNLOCKS + ' 张）',
    }, 403);
  }

  const samples = String(body.samples || '').slice(0, 6000);
  if (!samples) return json({ state: 'error', error: '缺少台词样本' }, 400);

  const prompt = PERSONA_GEN.replace('{name}', name).replace('{samples}', samples);
  let p;
  try {
    const raw = await askOnce(env, [{ role: 'user', content: prompt }], 0, 900);
    const m = raw.match(/\{[\s\S]*\}/);
    p = JSON.parse(m ? m[0] : raw);
    p = {
      title: String(p.title || ''), persona: String(p.persona || ''),
      style: String(p.style || ''), knowledge_cutoff: String(p.knowledge_cutoff || ''),
    };
  } catch (e) {
    return json({ state: 'error', error: '生成失败：' + String(e).slice(0, 160) }, 502);
  }
  await writePersona(env, name, p);
  if (!already) { st.unlocked.push(name); st.spent = (st.spent || 0) + 1; await writeState(env, client, st); }
  return json({ name, persona: p, state: 'cached', spent: st.spent || 0, unlock_limit: FREE_UNLOCKS });
}

const PERSONA_GEN = `下面是从长篇小说《三体》中抽取的角色「{name}」的台词样本（含上下文）。

请据此写出这个角色的扮演设定。**只依据材料，不要编造原著里没有的信息**；材料不足的字段就写得保守些。

严格输出如下 JSON（不要任何额外文字、不要 markdown 代码块）：
{
  "title": "身份或头衔，一句话",
  "persona": "性格、经历、立场，100-200 字，用第二人称「你」来写",
  "style": "说话风格，30-60 字",
  "knowledge_cutoff": "这个角色在原著中的时间线边界，一句话"
}

【台词样本】
{samples}`;
