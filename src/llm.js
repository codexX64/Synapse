'use strict';
/* ============================================================
   Le modèle qui rédige : réponses, titres, fiche.

   Deux familles, parce que c'est tout ce qui existe vraiment :
     ollama      l'API d'Ollama (/api/generate), sur ta machine
     compatible  l'API « chat completions » d'OpenAI, que parlent
                 Kimi, OpenAI, Mistral, Groq, OpenRouter, vLLM…

   Les VECTEURS restent chez Ollama quoi qu'il arrive : la recherche en
   dépend, et la plupart des API de conversation n'en fournissent pas.
   Changer de rédacteur ne doit jamais casser la mémoire.

   Réglages (variables d'environnement, posées par le Hub) :
     LLM_FOURNISSEUR  ollama | kimi | openai | compatible   (défaut ollama)
     LLM_URL          adresse de l'API (défaut selon le fournisseur)
     LLM_CLE          clé d'API
     LLM_MODELE       modèle (défaut selon le fournisseur)

   Un fournisseur distant sans clé retombe sur Ollama, et le dit : un
   réglage à moitié rempli ne doit pas éteindre les réponses.
   ============================================================ */

const CONNUS = {
  kimi:   { url: 'https://api.moonshot.ai/v1', modele: 'kimi-k2-0905-preview', nom: 'Kimi' },
  openai: { url: 'https://api.openai.com/v1', modele: 'gpt-4o-mini', nom: 'OpenAI' },
};

const CTX = Number(process.env.OLLAMA_NUM_CTX || 8192);
const GARDE = process.env.ANSWER_KEEP_ALIVE || '30m';
const nettoie = t => String(t || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();

function reglage(env = process.env) {
  const f = String(env.LLM_FOURNISSEUR || 'ollama').trim().toLowerCase();
  const ollama = { famille: 'ollama', nom: 'Ollama', url: env.OLLAMA_URL || '', modele: env.ANSWER_MODEL || 'qwen3:8b' };
  if (!f || f === 'ollama') return ollama;
  const connu = CONNUS[f] || {};
  const url = String(env.LLM_URL || connu.url || '').replace(/\/+$/, '');
  const cle = String(env.LLM_CLE || '');
  const modele = env.LLM_MODELE || connu.modele || '';
  const nom = connu.nom || 'API compatible';
  if (!cle || !url || !modele) {
    return { ...ollama, repli: `${nom} choisi mais ${!cle ? 'sans clé' : !url ? 'sans adresse' : 'sans modèle'} : Ollama répond en attendant` };
  }
  return { famille: 'compatible', nom, url, cle, modele };
}

/* Ce que l'interface affiche : jamais la clé. */
function etat(env = process.env) {
  const r = reglage(env);
  return { fournisseur: r.nom, modele: r.modele, distant: r.famille === 'compatible', repli: r.repli || null };
}

async function erreurDe(o) {
  const j = await o.json().catch(() => ({}));
  return new Error((j.error && (j.error.message || j.error)) || j.message || 'HTTP ' + o.status);
}

/**
 * Une réponse complète.
 * { system, prompt, json, maxTokens, temperature, timeout, signal }
 */
async function genere(o, env = process.env) {
  const r = reglage(env);
  const signal = o.signal || AbortSignal.timeout(o.timeout || 60000);
  if (r.famille === 'ollama') {
    const rep = await fetch(r.url + '/api/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: r.modele, prompt: o.prompt, ...(o.system ? { system: o.system } : {}),
        stream: false, think: false, keep_alive: GARDE, ...(o.json ? { format: 'json' } : {}),
        options: { temperature: o.temperature ?? 0.2, num_predict: o.maxTokens || 400, num_ctx: CTX },
      }),
      signal,
    });
    const j = await rep.json().catch(() => ({}));
    if (!rep.ok || j.error) throw new Error(j.error || 'HTTP ' + rep.status);
    return nettoie(j.response);
  }
  const rep = await fetch(r.url + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + r.cle },
    body: JSON.stringify({
      model: r.modele,
      messages: [...(o.system ? [{ role: 'system', content: o.system }] : []), { role: 'user', content: o.prompt }],
      temperature: o.temperature ?? 0.2, max_tokens: o.maxTokens || 400,
      ...(o.json ? { response_format: { type: 'json_object' } } : {}),
    }),
    signal,
  });
  if (!rep.ok) throw await erreurDe(rep);
  const j = await rep.json();
  return nettoie(j.choices?.[0]?.message?.content);
}

/**
 * La même, jeton par jeton. `surJeton(t)` reçoit chaque morceau de texte.
 * Une pensée affichée malgré la consigne (<think>…</think>) n'est pas diffusée.
 */
async function flux(o, surJeton, env = process.env) {
  const r = reglage(env);
  const signal = o.signal || AbortSignal.timeout(o.timeout || 60000);
  let rep;
  if (r.famille === 'ollama') {
    rep = await fetch(r.url + '/api/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: r.modele, prompt: o.prompt, ...(o.system ? { system: o.system } : {}),
        stream: true, think: false, keep_alive: GARDE,
        options: { temperature: o.temperature ?? 0.2, num_predict: o.maxTokens || 400, num_ctx: CTX },
      }),
      signal,
    });
  } else {
    rep = await fetch(r.url + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + r.cle },
      body: JSON.stringify({
        model: r.modele, stream: true,
        messages: [...(o.system ? [{ role: 'system', content: o.system }] : []), { role: 'user', content: o.prompt }],
        temperature: o.temperature ?? 0.2, max_tokens: o.maxTokens || 400,
      }),
      signal,
    });
  }
  if (!rep.ok) throw await erreurDe(rep);
  const dec = new TextDecoder();
  let buf = '', dansPensee = false, tout = '';
  const pousse = brut => {
    let t = '', reste = brut;
    while (reste) {
      if (dansPensee) {
        const f = reste.indexOf('</think>');
        if (f < 0) { reste = ''; break; }
        dansPensee = false; reste = reste.slice(f + 8);
      } else {
        const d = reste.indexOf('<think>');
        if (d < 0) { t += reste; break; }
        t += reste.slice(0, d); dansPensee = true; reste = reste.slice(d + 7);
      }
    }
    if (t) { tout += t; surJeton(t); }
  };
  for await (const morceau of rep.body) {
    buf += dec.decode(morceau, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      let ligne = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!ligne) continue;
      if (r.famille === 'ollama') {
        const j = JSON.parse(ligne);
        if (j.error) throw new Error(j.error);
        pousse(j.response || '');
      } else {
        if (!ligne.startsWith('data:')) continue;
        ligne = ligne.slice(5).trim();
        if (ligne === '[DONE]') return tout;
        const j = JSON.parse(ligne);
        if (j.error) throw new Error(j.error.message || j.error);
        pousse(j.choices?.[0]?.delta?.content || '');
      }
    }
  }
  return tout;
}

module.exports = { genere, flux, etat, reglage, CONNUS };
