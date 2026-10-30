'use strict';
/* Ce que l'assistant de configuration du socle demande (première
   installation, puis seulement les réglages nouveaux d'une mise à jour), et
   le format attendu de chaque variable. SYNAPSE lit ses variables au
   chargement de ses modules : src/entree.mjs complète process.env avec les
   valeurs posées avant de charger le serveur. */

const SPEC_SYNAPSE = {
  ollamaUrl: { env: 'OLLAMA_URL', type: 'url', defaut: 'http://ollama:11434' },
  modeleVecteurs: { env: 'EMBED_MODEL', type: 'chaine', motif: /^[\w.:\-/]{1,120}$/, defaut: 'nomic-embed-text' },
  modeleReponse: { env: 'ANSWER_MODEL', type: 'chaine', motif: /^[\w.:\-/]{1,120}$/, defaut: 'qwen3:8b' },
  fournisseur: { env: 'LLM_FOURNISSEUR', type: 'choix', parmi: ['ollama', 'kimi', 'openai', 'compatible'], defaut: 'ollama' },
  llmUrl: { env: 'LLM_URL', type: 'url' },
  llmModele: { env: 'LLM_MODELE', type: 'chaine', motif: /^[\w.:\-/@]{1,120}$/ },
  llmCle: { env: 'LLM_CLE', type: 'secret', min: 16 },
  appelsJour: { env: 'LLM_APPELS_JOUR', type: 'entier', min: 1, max: 100000, defaut: 500 },
  vecteursMax: { env: 'VECTEURS_MAX', type: 'entier', min: 1000, max: 10000000, defaut: 120000 },
};

const REGLAGES_SYNAPSE = [
  { env: 'OLLAMA_URL', groupe: 'Modèles', libelle: 'Adresse d’Ollama', exemple: 'http://ollama:11434', depuis: '3.8.0',
    aide: 'Calcule les vecteurs de la recherche et répond aux questions. Injoignable : la recherche plein texte marche quand même.' },
  { env: 'EMBED_MODEL', groupe: 'Modèles', libelle: 'Modèle des vecteurs', depuis: '3.8.0' },
  { env: 'ANSWER_MODEL', groupe: 'Modèles', libelle: 'Modèle des réponses (Ollama)', depuis: '3.8.0' },
  { env: 'LLM_FOURNISSEUR', groupe: 'IA distante (facultatif)', libelle: 'Fournisseur des réponses', depuis: '3.8.0',
    noms: { ollama: 'Ollama (local)', kimi: 'Kimi', openai: 'OpenAI', compatible: 'API compatible OpenAI' } },
  { env: 'LLM_URL', groupe: 'IA distante (facultatif)', libelle: 'Adresse de l’API', depuis: '3.8.0', aide: 'Vide : celle du fournisseur.' },
  { env: 'LLM_MODELE', groupe: 'IA distante (facultatif)', libelle: 'Modèle distant', depuis: '3.8.0' },
  { env: 'LLM_CLE', groupe: 'IA distante (facultatif)', libelle: 'Clé d’API', depuis: '3.8.0' },
  { env: 'LLM_APPELS_JOUR', groupe: 'IA distante (facultatif)', libelle: 'Appels par jour au plus', depuis: '3.8.0', avance: true, aide: 'Plafond de dépense ; Ollama, local, n’est pas compté.' },
  { env: 'VECTEURS_MAX', groupe: 'Modèles', libelle: 'Morceaux vectorisés au plus', depuis: '3.8.0', avance: true },
];

module.exports = { SPEC_SYNAPSE, REGLAGES_SYNAPSE };
