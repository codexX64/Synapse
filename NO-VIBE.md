# Code quality record — SYNAPSE

Method: Project Baseline Requirements & Security Manual, Part III (chapters 37-49)
Reviewed: 2026-10-19   ·   Owner: Codex64

## Behaviour freeze
Point de départ : `v1.9.5`. Ensemble de référence relevé avant toute modification : 64 essais du service, tous verts, et l’inventaire des 67 routes. Sur l’arbre final : 85 essais du service et 69 du socle embarqué, tous verts ; des 64 de départ, 57 passent inchangés, et les 7 qui manquent sont ceux du module de comptes de la 1.x (`src/comptes.test.js`), retiré avec lui quand les comptes sont passés au socle (constat C1 de SECURITY.md), leurs cas repris par les essais du socle et par la reprise des comptes (`test/serveur.test.mjs`, « reprise des comptes de SYNAPSE 1.x »).

Diff de l’API publique : les 51 routes de la mémoire, `/mcp` et la santé gardent leurs chemins, leurs méthodes et la forme de leurs réponses. Changements voulus, chacun le correctif d’un constat de SECURITY.md : les 14 routes `/v1/auth/*` et `/v1/admin/users*` de la 1.x remplacées par celles du socle (`/api/compte/*`, C1) ; un champ ou un paramètre non déclaré, un type ou une longueur hors bornes → 400 (C5) ; un corps trop grand → 413, une écriture sans JSON → 415 (C5) ; une méthode non servie → 405 au lieu de 404 ; l’entrée d’un autre espace → 404 au lieu de 403, et des liens filtrés (C7) ; l’export entier plafonné à deux par minute. Le champ `hash` qu’envoie le client fourni reste admis.

Démarrage et parcours de bout en bout sur l’arbre final, le 2026-10-19 : `outils/exercice-incident.mjs` → 26 vérifications réussies ; parcours de l’interface dans Chromium (accueil, paramètres, compte, porte de connexion) → aucune erreur ni violation de la politique de contenu, l’enregistrement des réglages passe le schéma.

## Layer status
| Chapter | Subject | Status | What changed |
|---|---|---|---|
| 39 | Comment layer | DONE | 30 en-têtes de fichier encadrés de signes égal et 41 titres de section en tirets ou en égal ramenés à leur texte (`06b1cd3`) ; trois commentaires réécrits pour dire leur raison, dont deux qui renvoyaient à une consigne plutôt qu’au besoin et un qui prêtait à la recherche d’un jeton une comparaison à temps constant qu’elle ne fait pas ; les commentaires restants disent une raison (contrat d’un client, choix de seuil, menace), aucun ne raconte le code |
| 40 | Naming and vocabulary | DONE | vocabulaire hérité gardé là où il est contrat : routes, tables et champs en anglais (`ingest`, `recall`, `neurons`, `entries`), lus par les clients ; domaine et ajouts en français (espace, cerveau, fiche, trait, rangement, renfort) ; `handleMcp` devient `repondreMcp` (`3cead9f`) ; les `obj` des lectures de réponses de modèle disparaissent avec leur aide commune |
| 41 | Formatting, layout and whitespace | DONE | aucun formateur dans le dépôt, aucun introduit ; serveur : 2 espaces, apostrophes simples, points-virgules, comme le socle ; `ui/index.html` garde son écriture compacte d’origine (la reformater changerait chaque ligne sans rien corriger) ; `git diff --check` depuis l’arbre vide : propre ; aucun caractère invisible |
| 42 | Gratuitous abstraction | DONE | aucune interface à une seule implémentation ; une seule lecture d’un objet JSON dans une réponse de modèle, au lieu de trois copies (`234d235`) ; les schémas des routes en une table (`src/schemas.js`) plutôt qu’un contrôle par route |
| 43 | Defensive noise | DONE | chaque erreur avalée dit pourquoi, et une entrée injoignable le dit dans l’inspecteur au lieu d’attendre (`2508607`) ; une relecture n’avale plus une erreur de schéma (`460435e`) ; 106 `catch` rangés ci-dessous selon ce que fait leur bloc ; aucun message vague, aucune journalisation d’entrée ou de sortie de fonction |
| 44 | Control flow and idiom | DONE | retours anticipés ; identité exigée avant tout, puis paramètres validés, puis portée, espace ou rôle en tête de chaque route ; 405 avec Allow pour une méthode non servie |
| 45 | Types, signatures and data shapes | DONE | JavaScript sans TypeScript ; contrat d’erreur : `ErreurHttp` du socle, traduite une fois à la frontière (`traiter`), le reste devient un 500 générique ; schémas au même validateur que le socle |
| 46 | Dependencies, configuration, fitting the repository | DONE | aucune dépendance npm, contrôlé en CI ; three.js r128 et deux polices OFL figés dans `ui/vendor` avec provenance et empreintes ; clé maîtresse d’une installation seule en secret Docker, jamais dans le `.env` |
| 47 | Tests | DONE | 18 cassures volontaires, chacune détectée (ci-dessous) ; une passait d’abord inaperçue et a donné un essai (`8d23578`) ; table des droits de chaque route (`e9d60db`) ; runbook d’incident joué par les essais (`0ac9ff7`) |
| 48 | Documentation, furniture and version control | DONE | README (démarrage avec la clé en secret, rotation, sauvegardes, incident, jetons, schémas), notice de confidentialité, `.env.example`, Compose, Dependabot, vérification CI relus ; un sujet par commit, sans mention d’outil, en UTC |

`catch` restants, par raison (`rg -o 'catch\s*(\(\s*\w*\s*\))?\s*\{|\.catch\(' src ui client outils test`, 106), classés à la lecture de chaque bloc :

| Raison | Nombre | Où |
|---|---|---|
| valeur de repli explicite (réponse illisible d’un modèle, d’Ollama ou de Telegram, réglage absent, stockage du navigateur indisponible) | 41 | `src/llm.js`, `src/search.js`, `src/config.js`, `src/moi.js`, `src/apprentissage.js`, `src/embed.js`, `src/cli.js`, `src/server.js`, `src/rangement.js`, `client/`, `ui/` |
| montrée à l’écran, rendue au demandeur ou portée dans l’état du service, avec sa cause | 33 | `ui/`, `src/server.js`, `src/tickets.js`, `src/planif.js`, `src/tache.js`, `src/rangement.js`, `src/moi.js`, `src/apprentissage.js`, `src/embed.js`, `src/neurons.js` |
| sans effet voulu, la raison écrite dans le bloc (déjà retiré, déjà fermé, rien à effacer) | 15 | `client/`, `src/db.js`, `src/llm.js`, `src/config.js`, `src/moi.js`, `src/apprentissage.js`, `src/tache.js`, `src/neurons.js`, `outils/`, essais |
| relevée, traduite en erreur du domaine ou transmise | 11 | `src/server.js`, `src/cli.js`, `src/embed.js`, `src/eval.js`, essais |
| repli du client fourni sur son spool disque (le client n’échoue jamais pour son appelant) | 4 | `client/` |
| journalisée | 2 | `src/activite.js`, `src/planif.js` |

## Tests
Cassures volontaires (REQ-CODE-005) : chacune posée seule, les essais du service lancés en entier, le fichier rétabli (`mutations.py`, hors dépôt), sur l’arbre final.

| Cassure | Fichier | Essais en échec | Premier essai qui échoue |
|---|---|---|---|
| un service lit l’espace privé d’un autre | `src/server.js` | 4 | « écriture : son espace ou un espace commun, jamais celui d'un autre » |
| un jeton de service passe pour un humain admin | `src/server.js` | 1 | « jeton d'un service : ni les gestes de la portée admin, ni ceux réservés aux humains » |
| un paramètre de requête n’est plus contrôlé | `src/server.js` | 1 | « schémas : champ ou paramètre inconnu, type faux, paramètre répété → 400 ; un inconnu n'apprend rien des routes » |
| un corps n’est plus validé | `src/server.js` | 3 | « « Retrouver une résolution passée » : la signature donnée par le Hub ramène le correctif » |
| un paramètre répété passe | `src/server.js` | 1 | « schémas : champ ou paramètre inconnu, type faux, paramètre répété → 400 ; un inconnu n'apprend rien des routes » |
| un jeton faux ne compte plus | `src/server.js` | 1 | « jetons de service : un jeton refusé ne retombe pas sur la session, il est compté et journalisé » |
| un refus de jeton n’est plus journalisé | `src/server.js` | 1 | « refus d'un jeton : au journal de sécurité, une ligne par appelant et par route » |
| l’entrée d’un autre espace se lit | `src/server.js` | 1 | « lecture d'une entrée : celle d'un autre espace est introuvable, et un lien n'en montre pas le titre » |
| un lien montre le titre d’une entrée d’un autre espace | `src/server.js` | 1 | « lecture d'une entrée : celle d'un autre espace est introuvable, et un lien n'en montre pas le titre » |
| l’export entier sans plafond | `src/server.js` | 1 | « export entier : portée admin seule, deux par minute » |
| l’IA sans débit par appelant | `src/server.js` | 1 | « IA : trente questions par minute et par appelant » |
| l’IA distante sans plafond du jour | `src/llm.js` | 1 | « IA distante : plafond du jour, puis refus dit et journalisé » |
| une réponse démesurée du modèle est lue entière | `src/llm.js` | 1 | « IA : une réponse démesurée est abandonnée, pas gardée en mémoire » |
| une balise du texte referme les données | `src/llm.js` | 2 | « données closes : les balises ne se referment pas depuis le texte, la règle le dit » |
| un jeton de cerveau passe sans le bon calcul | `src/cerveaux.js` | 1 | « un jeton de cerveau ne vaut que pour son nom, et seulement avec la bonne clé » |
| le jeton Telegram est gardé en clair | `src/config.js` | 1 | « session humaine : lecture permise, écriture sous jeton anti-CSRF et rôle, réglages sous renfort » |
| une source signe au nom d’une autre | `src/ingest.js` | 1 | « provenance : celle du jeton, l'origine annoncée reste à part » |
| la base reste lisible de tous | `src/db.js` | 1 | « base : dossier et fichiers lisibles du seul service » |

Cassures manquées : 0 (la cassure du refus consigné passait d’abord inaperçue : un essai l’a ajoutée, `8d23578`).

## Repository style profile
Node 24 sans dépendance, CommonJS côté serveur (`'use strict'`), le socle en module ES chargé par `import()` ; 2 espaces, apostrophes simples, points-virgules ; une route = une entrée de la table `routes` de `src/server.js`, son schéma dans `src/schemas.js` ; accès en tête de route par `can`, `canIncident`, `nsAllowed`, `exigerHumain` ; réponses par `send(res, code, objet)` ; erreurs du client en `ErreurHttp` ; essais `node:test`, instances lancées comme en production (`test/instance.mjs`), aides du socle pour les comptes (`socle/essai/`) ; interface : un fichier par page, HTML, CSS et script ensemble, texte inséré par `esc()` ; commentaires en français, qui disent une raison ; commits d’une ligne, un sujet chacun.

Aides existantes réutilisées plutôt que réinventées : lecture bornée du corps, schémas, limiteur persistant, coffre, journal, sauvegarde et en-têtes du socle ; `texteBorne`/`jsonBorne` et `objetJson` de `src/llm.js` pour toute réponse de modèle.

## Detection sweep
Annexe B.5, sur l’arbre final (`b5.sh`, hors dépôt ; `ui/vendor` et `socle/` exclus, le socle ayant son propre relevé) :

```
B.5.1	0 lignes
B.5.2	0 lignes
B.5.3	0 lignes
B.5.4	0 lignes
B.5.5	0 lignes
B.5.6	0 lignes
B.5.7	12
B.5.8	2 lignes
    ./src/rangement.js:49:function doublons(db, { ns = null, seuil = 0.94, max = 40 } = {}) {
    ./src/planif.js:19:function doitTourner(cfg, now = new Date()) {
B.5.9	0 lignes
B.5.10	0 lignes
B.5.11	3 lignes
    ./ui/index.html:1524:        const data=(bloc.match(/^data: (.*)$/m)||[])[1];
    ./ui/index.html:1525:        if(!type||data==null)continue;
    ./ui/index.html:1885:    MOI.data=await apiMoi('/v1/moi');
B.5.12	89
B.5.12b	15
B.5.13	0 lignes
B.5.14	0 lignes
B.5.15	0 lignes
41.1.1	0 lignes
41.2.1	0 lignes
45.1.1	0 lignes
47.1.1	0 lignes
48.3.1	0 lignes
48.3.2	7
48.3.3	0 lignes
48.4.1	0 lignes
```

Justification de chaque résultat non nul : B.5.7, des symboles d’interface (boutons ⚙ ✕ ✎ ✷ et glyphes de la fiche) et les marques ✓ / ✗ de deux essais anciens ; B.5.8, `doublons` et `doitTourner` sont des mots français (le motif lit « do ») ; B.5.11, `data` est le nom du champ du protocole SSE que l’interface lit, et `MOI.data` l’état de la fiche ; B.5.12 et B.5.12b, les `catch` rangés plus haut ; 48.3.2, des attributs `placeholder` de champs de formulaire et l’exemple d’adresse du manifeste (plage de documentation).

## Verification (chapter 49)
- [x] Full suite passes and matches the baseline — 85 essais du service et 69 du socle, verts ; les 57 essais de départ qui restent passent inchangés, les 7 autres partis avec le module de comptes de la 1.x (« Behaviour freeze »)
- [x] Public API diff empty — inventaire des routes relu ligne à ligne : aucune route de la mémoire changée de chemin, de méthode ou de forme ; les seuls écarts sont les correctifs listés plus haut
- [x] Characterisation tests deleted after use — aucun essai de caractérisation écrit : la référence était la suite existante, et chaque changement de comportement voulu a son essai de non-régression, gardé
- [x] Read-aloud test passed — en-têtes, commentaires et messages d’erreur relus à voix haute : ils disent une raison ou un fait, sans formule
- [x] Blind-comparison test passed — les fichiers repris ne se distinguent plus du reste du dépôt par leurs bandeaux, leurs noms ou leurs `catch`
- [x] Commit history: one concern per commit, repository style, no attribution trailers — `git log --format=%b v1.9.5..main | grep -c .` → 0 ; identité, fuseau et mentions d’outil contrôlés en CI
- [x] REQ-CODE-001 to REQ-CODE-006 all PASS — voir SECURITY.md

## Suivi du 2026-10-25 (2.0.2)
Socle 6f2c864 embarqué sans adaptation du code (son API ne change que par ajouts : `confirmerIdentite`, `raisonCle` exporté, gamme Lavande). La mémoire prend des jetons de mise en page (`--haut`, `--bas`) au lieu de hauteurs répétées dans chaque panneau ; les paramètres prennent `--ecart` au lieu de 14 px ; les textes d'aide sont des paragraphes ; la page du compte reprend la coque du socle au lieu d'une barre à elle. Parcours du navigateur et vitrine écrits sur le modèle de ceux de ProxLab et de NEXARC ; essai du relais de confiance écrit comme le leur. 87 essais du service et 77 du socle, verts ; parcours : 112 écrans × largeurs par gamme, 0 défaut.

## Suivi du 2026-10-28 (3.0.0) : hiérarchie des cerveaux
Point de départ : `v2.0.2`, 163 essais verts, 1 sauté. Arbre final : 182 verts, 1 sauté. Les 163 de départ passent inchangés ; seul `test/balayage.test.mjs` gagne les 14 routes nouvelles (une catégorie ajoutée : lues par une personne, même en lecture, jamais par un service).

Vérifié :
- schéma v2 additif : aucune table ni colonne retirée ou renommée ; une base écrite par le `db.js` de la 2.0.2 (copie figée dans `test/anciens/`) migre sans perte, et sa reprise produit la fiche attendue ;
- tamis : importance, étiquette forcée, étiquette interdite, remontée à valider, sous-domaines, convergence (une source qui se répète ne converge pas avec elle-même), corrélation au global ;
- accès : une IA ne lit jamais le cerveau brut d'une autre hors projet ouvert ; projet clos, l'accès croisé s'arrête ; un compte ne lit ni ne règle l'arbre d'un autre ; le commun se règle par un admin ;
- les liens `consolide` et `correle` ne se posent que par le tamis (signé `@tamis`, nom qu'aucun jeton ne peut porter) ; l'espace `h:` refuse toute écriture directe ;
- jeton de compte : montré une fois, stocké en empreinte, écrit dans l'arbre de son créateur seulement.

Pas encore vérifié :
- **volume réel** : mesuré sur bases synthétiques seulement (ci-dessous). La mesure sur la base de production (735 Mo) se fait sur une copie, hors service.
- une source effacée ne met pas encore à jour le corps des fiches qui la citaient (les liens partent, le texte reste).
- le choix des domaines du commun qu'un compte consulte (abonnements) n'est pas fait : une personne lit tout le commun.
- l'interface ne montre pas encore la hiérarchie : phase 3.4.
- le manifeste `hub.json` n'expose pas encore les routes de la hiérarchie : phase 3.2.

### Mesure du tamis (2026-10-28, base synthétique, 12 sources, une clé sur cinq très fréquente, un cœur)
Première écriture du tamis : la convergence recomptait toutes les entrées portant la clé, et une fiche était refaite et revectorisée à chaque contribution. Profil : `converger` 9,8 s sur 15,2 s. Reprise 6 à 7,5 ms par entrée et en hausse avec la taille ; écriture p50 6 à 10 ms.

Correctif : table `h_convergence` (cerveau, clé, origine, dernière date) tenue à chaque passage ; une fiche existante reçoit une ligne et un lien, sans être refaite ni revectorisée (texte plafonné à 60 lignes, liens sans plafond).

| Base | Reprise | Écriture p50 | Écriture p95 |
|---|---|---|---|
| 5 000 entrées | 1,94 ms/entrée | 0,44 ms | 8,7 ms |
| 20 000 entrées | 1,92 ms/entrée | 0,43 ms | 8,7 ms |

Le coût ne dépend plus de la taille. Essai de garde : une clé répétée 800 fois par une seule source ne rend pas l'écriture plus chère.

La reprise ne bloque plus le démarrage : elle tourne en tâche de fond par lots de 200, derrière un curseur en base (`meta.hierarchie_reprise`) qui survit à un redémarrage. `/healthz` dit `hierarchie: reprise | prete`, sans compte. Cas limite assumé : la fenêtre de convergence lit la date de la dernière contribution par origine ; une entrée archivée après coup compte encore jusqu'à ce que cette date sorte de la fenêtre.

### Mesure sur une copie de la base de production (2026-10-28)
142 308 entrées (141 990 de vigie), 734 Mo, un cœur, 512 Mo. Reprise 365,8 s (2,57 ms par entrée) ; tamis à l'écriture p50 2,53 ms, p95 4,49 ms, p99 17 ms ; mémoire 88 Mo ; base +106 Mo.

Ce que la mesure a montré, et corrigé depuis :
- **tout remontait** (141 990 remontées) : vigie étiquette chaque alerte `securite`, qui forçait la remontée et fixait l'importance à 90. `securite` n'est plus une étiquette forcée par défaut (seule `decision` l'est) et ne touche plus l'importance ; la gravité dite par la source (`meta.gravite` chez vigie, `meta.severity` ailleurs) la fixe.
- **la même alerte répétée** (« Menace extérieure non bloquée : <ip> (score N) », jusqu'à 30 000 par jour en rafale) : un motif (genre et titre, adresses et nombres neutralisés) ne remonte qu'une fois par `repetition_heures` (24 par défaut, réglable par cerveau), les répétitions sont comptées dans `h_motifs`.
- **fausses convergences** : le Hub relaie sous son nom les alertes des autres services ; vigie et son relais faisaient deux origines pour un fait. Une alerte du Hub qui reprend mot pour mot le titre d'une entrée d'un autre service à dix minutes près est rangée chez ce service.
- **fiches illisibles** (2 161 liens sur « port:21 ») : dix exemples liés par origine au plus, toutes les mentions comptées dans `h_fiches` et dans la première ligne de la fiche.
- **agent « inconnu »** : le cerveau prend le nom de la source.

Rejoué sur la forme réelle (alertes vigie en rafale, gravité « élevé », relais du Hub) : 4 remontées pour 5 430 alertes (une par motif), 0 fausse fiche, 0,56 ms par entrée. À remesurer sur la copie de production avant l'étiquette.

## Suivi du 2026-10-28 (3.1.0) : la page Cerveaux
Page `/cerveaux` (un fichier, `ui/cerveaux.html`, même gamme et même contrat d'API que les autres pages), accès ⬡ dans l'en-tête de la mémoire. Constellation en Canvas 2D : le global en nébuleuse colorée par domaine au centre, les communs en couronne, les sous-domaines un cran plus loin, les membres en amas hexagonaux à la taille logarithmique de leur volume, l'enceinte en anneau de points ; une remontée se voit comme une particule de l'enfant vers le parent (arbre relu toutes les 8 s, seuls les compteurs se mettent à jour si la structure n'a pas changé). Panneau gauche : arbre, projets partagés, instance (mode, versements, jetons de compte). Fiche d'un cerveau : recherche qui monte, fiches, remontées à valider, tamis, rattachement.

Vérifié dans Chromium contre la vitrine (enrichie de dix cerveaux, deux sous-domaines, des convergences et une rafale d'alertes répétées) : 1440, 1024, 768 et 360 px, aucune erreur de console, aucun texte brut ; création d'un projet et d'un domaine depuis la page. 189 essais du service et du socle verts.

Pas encore vérifié : le rendu sur la base de production ; le parcours `outils/parcours-navigateur.mjs` ne couvre pas encore cette page.

## Suivi du 2026-10-28 (3.2.0) : une sphère par cerveau, dans la vue de la mémoire
La page séparée `/cerveaux` de la 3.1.0 est retirée : la hiérarchie se voit dans la vue de la mémoire elle-même. La sphère du centre reste ce qu'elle était (ses cartes, ses vues, sa barre de question) et devient le cerveau global ; autour d'elle, une sphère par cerveau de la hiérarchie (communs de domaine en couronne, IA et services en orbite, sous-domaines un cran plus loin), faite des mêmes cartes (mêmes textures, aucune copie), avec une enveloppe de points à la couleur du domaine et des brins vers le cerveau où elle remonte. Clic sur une carte : l'inspecteur habituel ; clic sur le nom d'un cerveau : la caméra le suit, la rotation s'arrête. En galaxie et en carte 2D, les sphères s'effacent. `/v1/graph` dit pour chaque neurone les cerveaux où il est présent et montre, dans l'espace de l'infrastructure, les fiches du compte de l'appelant.

Vérifié dans Chromium contre la vitrine (16 cerveaux, deux sous-domaines) : la couronne entière dans la vue de départ, le suivi d'un cerveau, aucune erreur de console. 190 essais verts, dont le graphe (cerveaux de chaque neurone, fiches présentes, entrée remontée dans deux cerveaux).

Pas encore vérifié : le rendu sur la base de production (260 cartes au plus par sphère de cerveau) ; les performances sur un téléphone avec beaucoup de cerveaux. Les réglages du tamis, les projets et les jetons de compte n'ont plus d'écran : ils restent accessibles par l'API (`/v1/hierarchie/*`) en attendant leur place dans cette vue.

## Suivi du 2026-10-28 (3.3.0) : aller d'un cerveau à l'autre, librement
Barre des cerveaux sous l'en-tête (un bouton par cerveau dans l'ordre de l'arbre, ◀ ▶), qui s'allume sur le cerveau où l'on est. Déplacement libre dans la scène : clic droit glissé ou Maj + glisser déplace le point regardé, deux doigts au téléphone déplacent et zooment, ZQSD ou WASD font voler, R et F montent et descendent ; ← et → passent au cerveau précédent ou suivant, ↑ au cerveau parent, Échap revient à la vue d'ensemble. Dès qu'on se déplace librement, la rotation automatique s'arrête. Le clavier ne fait rien tant qu'on écrit dans un champ.

Vérifié dans Chromium contre la vitrine : trois fois → mène à kimi, ↑ à IA, le clic droit glissé et le vol déplacent le point regardé, un bouton de la barre amène au cerveau voulu, Échap revient au global, les touches restent dans le champ de question ; rendu à 1440 et 390 px, aucune erreur de console. 190 essais verts.

## Suivi du 2026-10-28 (3.3.1) : une carte ouverte dans son cerveau
Une carte choisie dans la sphère d'un cerveau ouvrait son double dans la grande sphère : la caméra quittait le cerveau. Elle va maintenant sur cette carte-là, vue de l'extérieur de la sphère du cerveau, et la suit ; la carte grossit, l'inspecteur s'ouvre, le nom du cerveau se masque le temps de la lecture. RESET CAM et le double-clic recadrent sur elle ; Échap ferme et laisse dans le cerveau. Une carte de la grande sphère se comporte comme avant.

Vérifié dans Chromium contre la vitrine : clic sur une carte de vigie à l'écran, caméra à 15 unités de cette carte (105 de son double central), inspecteur ouvert, nom masqué puis revenu après Échap, toujours dans vigie ; aucune erreur. 190 essais verts.

## Suivi du 2026-10-28 (3.3.2) : plus de cerveau vide
En production, la scène montre 1 400 cartes sur 145 387, choisies par liens puis récence : vigie (141 990 entrées) prenait toutes les places et vox (2 entrées) s'affichait en sphère vide. `/v1/graph` réserve maintenant à chaque cerveau ses 24 entrées les plus récentes (placées chez lui ou remontées jusqu'à lui) avant de compléter avec le reste, sans dépasser la limite. Côté scène, un cerveau sans carte à montrer n'est plus dessiné ni proposé dans la barre ; un commun vide qui a des cerveaux en dessous reste un point de jonction sans enveloppe.

Vérifié : essai unitaire (300 alertes de vigie, 2 entrées de vox, scène de 50 : vox présent, limite tenue, chaque carte sait où elle est) ; scène et point de jonction dans Chromium sans erreur. 191 essais verts.

## Suivi du 2026-10-28 (3.4.0) : toutes les entrées dans la scène
La scène montrait 1 400 cartes sur 145 387 entrées : une carte est une image, et 145 000 images ne tiennent pas dans un navigateur. Chaque entrée est maintenant aussi un point coloré par son type, sur la sphère de son cerveau et sur la grande sphère (un nuage de points par cerveau, un seul appel de dessin chacun). La surface d'une sphère suit son nombre d'entrées, pour garder le même espacement ; un cerveau est plafonné à 85 % du global, qui reste le plus gros. La couronne s'écarte selon la taille réelle des sphères ; caméra, brouillard et distance de vue suivent. Les cartes restent par-dessus pour les entrées les plus parlantes ; un point cliqué ouvre son entrée dans l'inspecteur, la caméra va dessus. La fin du chargement ne reprend plus la caméra à quelqu'un qui navigue déjà.

`GET /v1/graph/points` : toutes les entrées en colonnes (identifiant, cerveau, type), 1,42 Mo pour 145 000 ; 742 ms au premier calcul, 23 ms ensuite tant que la mémoire ne change pas (cache ; type calculé une fois par combinaison genre, niveau, étiquettes). Recalcul après une écriture : environ 550 ms sur 145 000 entrées, un cœur.

Défaut de la 3.0 corrigé : `/healthz` restait sur `"hierarchie":"reprise"` pour toujours, les entrées écrites après la reprise comptant comme restantes. Le reste ne compte plus que les entrées sans place ; quand il est nul, le curseur saute à la dernière entrée. Vu sur la vitrine : `"prete"` pendant qu'elle reçoit des alertes.

Vérifié dans Chromium contre la vitrine à 30 079 entrées (`outils/vitrine.mjs <port> soma 30000`, file de vectorisation débridée pour la seule vitrine) : 60 167 points, un point de vigie ouvert dans l'inspecteur, cible de caméra exactement sur le point, 60 clics au hasard sur vigie (13 cartes, 33 points, 14 vides), aucune erreur. 192 essais verts.

Pas encore vérifié : la fluidité sur une vraie carte graphique avec 145 000 entrées (environ 290 000 points) ; la machine de test dessine sans carte graphique, à moins d'une image par seconde. Le recalcul de la route des points après chaque écriture (environ 550 ms) sera à rendre incrémental si vigie écrit en continu.

## Suivi du 2026-10-29 (3.4.1) : seuls les points des entrées
Retirés de la vue sphère : l'enveloppe de points décoratifs autour de chaque sphère de cerveau, et la poussière lointaine (360 points gris entre 95 et 155 unités, là où sont maintenant les cerveaux). Une sphère se forme de ses seuls points, un par entrée : tout point visible en vue sphère est une entrée qu'on peut ouvrir. La poussière de la vue galaxie, invisible en vue sphère, est gardée.

Vérifié dans Chromium : en vue sphère, les 17 nuages visibles sont tous des nuages d'entrées, aucun décor ; aucune erreur.

## Suivi du 2026-10-29 (3.5.0) : des points lumineux reliés, et la galaxie des cerveaux
Au-delà de 1 400 entrées (`SEUIL_CARTES`), plus aucune carte : chaque entrée est un point lumineux (texture ronde et douce, couleur de son type, fusion additive), et les points d'une sphère sont reliés à leurs voisins. Sur une spirale de Fibonacci, les voisins d'un point sont aux écarts d'indice de Fibonacci : on garde les deux plus courts, la toile se tisse sans calcul de proximité. En dessous du seuil, les cartes comme avant, sans nuage.

Vue galaxie : chaque cerveau a aussi sa forme galaxie (quatre bras spiralés, densité uniforme sur le disque, filaments le long des bras), le global au centre, les autres autour avec les mêmes brins ; la forme sphère et la forme galaxie se relaient en fondu au changement de vue. Barre des cerveaux, clic sur un point, déplacement et vol au clavier fonctionnent aussi en galaxie.

Vérifié dans Chromium contre la vitrine à 6 079 entrées : mode points actif, aucune carte visible, 17 cerveaux avec leurs deux formes, la barre des cerveaux en galaxie, aucune erreur.

Pas encore vérifié : le rendu sur une vraie carte graphique avec 149 000 entrées (environ 300 000 points sous chaque forme, 900 000 segments de filaments en tout) ; la mémoire graphique estimée est de l'ordre de 60 Mo.
