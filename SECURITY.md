# Security compliance — SYNAPSE

Standard: Project Baseline Requirements & Security Manual, Edition 2.0 (258 controls)
Audited: 2026-10-19   ·   Owner: Codex64   ·   Status: NON-COMPLIANT

## Summary
| Part | Controls | Pass | Fail | N/A | Unknown |
|---|---|---|---|---|---|
| I — Baseline requirements | 68 | 52 | 14 | 2 | 0 |
| II — Security controls | 190 | 97 | 29 | 64 | 0 |
| Total | 258 | 149 | 43 | 66 | 0 |

Chaque FAIL restant est une action humaine de la liste ci-dessous (aucun défaut de code ouvert) ; la mise en production attend qu’elle soit vide.

## Authentication posture
Les personnes passent par le socle commun, embarqué avec ses essais et vérifié par ses empreintes : quatre facteurs cumulables sur chaque compte — mot de passe (Argon2id, 64 Mio, 3 passes, parallélisme 4, plancher 19 Mio / 2 / 1, rehachage transparent, liste de fuites locale, 12 à 1024 caractères), application TOTP (RFC 6238, secret scellé AES-256-GCM, rejeu refusé), clés d’accès WebAuthn (clé résidente, vérification de l’utilisateur exigée, vingt par compte) et dix codes de secours de 100 bits hachés en Argon2id ; politique par facteur réglable sans déploiement, clé d’accès requise pour les administrateurs par défaut ; aucun compte par défaut, comptes de la 1.x repris avec leurs facteurs. Sessions serveur de 256 bits en cookie __Host-, HttpOnly, Secure, SameSite=Strict, douze heures au plus et une heure d’inactivité, renouvelées à chaque changement de niveau, listées par appareil et fermables une à une ou toutes en une requête. Rôles : `lecture` lit la mémoire, `membre` corrige sa fiche et lance un rangement, `admin` règle Telegram et gère les comptes ; renfort (re-vérification de moins de cinq minutes) pour ce qui supprime ou touche un secret : application et validation d’un rangement, réglages et jeton Telegram. Une session humaine n’écrit jamais dans la mémoire. Les services n’ont pas de session : chacun présente un jeton de 192 bits gardé par son empreinte, à portée fermée (lecture, écriture, incidents, admin) ; le Hub sème le sien (`HUB_TOKEN_SEED`) et dérive par HMAC-SHA256 celui de chaque cerveau, vérifié en temps constant ; chaque espace `agent:<nom>` n’est lu et écrit que par son service ; un jeton refusé ne retombe jamais sur une session et compte pour l’adresse dans le limiteur persistant du socle.

## Findings (audit of 1.9.5, fixed in 2.0.0)
SYNAPSE 1.9.5 relue en lecture seule le 2026-10-19 (code, essais, balayage de l’annexe B, cassures volontaires, sondage exploratoire), classée par gravité ; chaque constat corrigé par le commit indiqué, avec son essai de non-régression.

| # | Gravité | Contrôles | Constat | Commits |
|---|---|---|---|---|
| C1 | CRITICAL | REQ-AUTH-001…013, REQ-SESS-*, SEC-CSRF-001 | Comptes humains propres à la 1.x : un compte créé par défaut au premier démarrage, ni clé d’accès, ni renfort, ni sessions révocables, ni jeton anti-CSRF ; pages sans politique de contenu. Remplacés par le socle commun, comptes repris. | 9eeb1ca, 66802ca |
| C2 | CRITICAL | SEC-AUTHZ-002, REQ-CFG-002 | La source « hub-admin » de la 1.x portait le jeton d’administration des comptes avec la portée admin sur toute l’API (export, import, purge, réglages). | 8427bd9 |
| C3 | HIGH | SEC-AUTHZ-001, SEC-AUTHZ-003, SEC-LLM-006 | Un service pouvait écrire dans l’espace d’un autre, relier ses entrées, parler au nom d’un autre agent, oublier ses neurones, et signer une entrée du nom d’une autre source. | fa4b0ba |
| C4 | HIGH | SEC-LLM-002, REQ-WEB-008, SEC-API-002 | IA sans plafond quotidien ni débit par appelant ; réponses du modèle, des vecteurs, de l’agrégateur et de Telegram lues sans borne. | 6c31d75 |
| C5 | HIGH | REQ-WEB-006, SEC-API-001, SEC-API-010, SEC-AUTHZ-003 | Aucun schéma : champs inconnus et paramètres non déclarés acceptés ; 2 Mo de corps pour toute route, lus avant tout contrôle de taille ; une relecture avalait une erreur de schéma. | 44bad24, 460435e, 871ee3e |
| C6 | MEDIUM | REQ-DATA-002, SEC-DB-004 | Jeton du bot Telegram gardé en clair dans la base. | 66802ca |
| C7 | MEDIUM | SEC-AUTHZ-001, SEC-LLM-006, SEC-AUTHZ-006 | L’entrée d’un autre espace répondait 403 (son existence se confirmait), et la liste de ses liens montrait le titre d’entrées d’espaces que l’appelant ne lit pas, par l’API comme par MCP. | ff2517d |
| C8 | MEDIUM | SEC-LLM-003 | Extraits de la mémoire, échanges et question posés à la suite des consignes, sans clôture ni règle : une entrée écrite par un service pouvait se faire passer pour une consigne. | 2f0b9c7 |
| C9 | MEDIUM | REQ-AUTH-010, REQ-DATA-004, SEC-LOG-001 | Jetons refusés comptés en mémoire (un redémarrage remettait le compteur à zéro) ; un geste refusé à un jeton (portée, espace d’un autre) ne laissait aucune trace au journal. | 20452d7, 0ddcd38 |
| C10 | MEDIUM | SEC-HDR-006, REQ-WEB-004, SEC-BE-010, SEC-XSS-006 | CORS avec cookies ; copie de rangement lisible par tous et nommée d’après son chemin ; détail interne dans les erreurs. | f6df072 |
| C11 | MEDIUM | SEC-SECRETS-004, SEC-DB-004 | Installée seule, la clé maîtresse vivait dans le `.env` ou naissait dans le volume de données, à côté de ce qu’elle scelle. | 9fb3394 |
| C12 | MEDIUM | SEC-PRIV-001, SEC-PRIV-003, REQ-DATA-006 | Aucune notice : ni ce qui est gardé (questions, fiche), ni combien de temps, ni ce qui part vers une IA distante. | 3c466e2 |
| C13 | LOW | REQ-CI-*, SEC-BE-009, SEC-INFRA-004 | Aucune intégration continue ; image sur une étiquette mobile, programmes setuid, conteneur inscriptible. | e8a8403, c83e750 |
| C14 | LOW | SEC-API-005, SEC-API-003, REQ-DATA-001 | Méthode non servie → 404 ; export entier sans plafond ; base lisible du groupe. | 54d7f70, 967781c, c514266 |
| C15 | LOW | REQ-CI-006, REQ-CODE-005, SEC-LOG-007 | Essais : seules quelques routes balayées pour les droits ; runbook jamais joué. | e9d60db, 0ac9ff7 |
| C16 | LOW | REQ-ANON-002, REQ-ANON-007 | Textes, consignes du modèle, essais et adresse par défaut nommaient un type d’installation et une machine ; une adresse privée dans un essai. | d7a2726, b1162f2, 7d8fae6 |
| C17 | LOW | — (fonctionnement) | L’action « Retrouver une résolution passée » du Hub envoyait des champs que `/v1/recall` ne lit pas : elle ne trouvait jamais rien. | a31636c |

Suivi du 2026-10-25 (2.0.2) : mise en page, constat d'usage — sur un téléphone, la barre du haut de la mémoire sortait de l'écran (FICHE, paramètres, compte et STATS injoignables) ; la console recouvrait le bas de l'instrumentation, le rappel des gestes et la fiche ; les libellés de la scène se recouvraient ; la page du compte posait sa barre et son contenu côte à côte. Socle 6f2c864 embarqué : un seul écart entre cartes (`--ecart`, 16 px, 12 px en Console et sur petit écran), deux colonnes finissant à la même ligne, la gamme Lavande, des pages Comptes et Sécurité qui posent l'une sous l'autre les cartes autrefois côte à côte (plus de carte « Appareils connectés » étirée à vide), et un contrôle de mise en page qui relève tout écart différent et toute colonne inégale ; ses essais rejoués et ses empreintes vérifiées, sans adaptation du code. La barre du haut passe sur deux lignes sous 640 px (`ui/index.html:287`) ; la console laisse 290 px de chaque côté, les panneaux s'arrêtent au-dessus d'elle à la hauteur qu'elle mesure (`ui/index.html:1566`), boutons de caméra et rappel des gestes regroupés à sa droite (`ui/index.html:191`) ; un libellé de la scène qui en recouvre un autre ou que le bord de l'écran couperait s'efface jusqu'à ce que la place soit libre (`ui/index.html:1751`) ; les paramètres prennent l'écart du socle (`ui/parametres.html:24`) ; la page du compte suit la coque du socle (`ui/compte.js:18`). La gamme choisie (SOCLE_THEME) s'applique aux pages du socle (porte et compte) ; la mémoire et les paramètres gardent leur apparence propre, voulue. Relais de confiance : le manifeste pose `SOCLE_PROXYS` à `172.16.0.0/12` par défaut (`hub.json`, réseau Docker du Hub) ; vide, SYNAPSE derrière Relay (HTTPS par le tunnel) se croyait en HTTP et refusait les clés d'accès. Essai `test/manifeste.test.mjs:54` (le défaut couvre une adresse du réseau du Hub, pas une du réseau local). Aucune route ne change ; aucun contrôle ne change de statut : les relais restent explicites (SEC-BE-002), le défaut rend seulement le HTTPS de Relay reconnu, donc les clés d'accès utilisables derrière lui. Les références de ligne du tableau sont recalées sur l'arbre. Essais : 87 du service (1 nouveau), 77 du socle ; parcours du navigateur (nouveau, `outils/parcours-navigateur.mjs`, vitrine `outils/vitrine.mjs`) dans les quatre gammes (SOMA, Console, Exploitation, Lavande) : 112 écrans × largeurs chacune, 0 défaut, 0 erreur de console.

## Control status
| ID | Severity | Status | Evidence | Notes |
|---|---|---|---|---|
| REQ-AUTH-001 | CRITICAL | PASS | `socle/src/comptes.js:25` ; mot de passe, TOTP, clés et codes de secours cumulables : essai `socle/test/parcours.test.js:159` | socle embarqué, ses essais rejoués par la vérification de SYNAPSE (`.github/workflows/verification.yml:29`, `.github/workflows/verification.yml:30`) ; comptes de la 1.x repris avec leurs facteurs (`src/migration-socle.js:16`, essai `test/serveur.test.mjs:154`) |
| REQ-AUTH-002 | CRITICAL | PASS | `socle/src/comptes.js:28` ; `socle/src/index.js:49` ; réglable sans déploiement : `socle/src/portail.js:476` | défaut : mot de passe et TOTP facultatifs, clé requise pour les administrateurs |
| REQ-AUTH-003 | CRITICAL | PASS | `socle/src/webauthn.js:26` ; vingt clés nommées : `socle/src/comptes.js:39` ; renommer et retirer : `socle/src/portail.js:316` | liste avec dates de création et d’usage dans la page du compte |
| REQ-AUTH-004 | CRITICAL | PASS | `socle/src/webauthn.js:46` ; origine `socle/src/webauthn.js:47` ; rpIdHash `socle/src/webauthn.js:103` | défi à usage unique lié à la session, UP et UV exigés, signature et compteur vérifiés |
| REQ-AUTH-005 | CRITICAL | PASS | `socle/src/comptes.js:732` ; renfort et fermeture des autres sessions : `socle/src/comptes.js:748` | la notification part à l’adresse vérifiée quand un relais existe (voir REQ-AUTH-014) |
| REQ-AUTH-006 | CRITICAL | PASS | `socle/src/comptes.js:993` ; jeton de 20 minutes, haché, unique : `socle/src/comptes.js:37` | essai `socle/test/parcours.test.js:242` ; rejoué par le runbook (`outils/exercice-incident.mjs:73`) |
| REQ-AUTH-007 | HIGH | PASS | `socle/src/comptes.js:40` ; 100 bits, haché Argon2id, usage unique : `socle/src/comptes.js:532` | alerte « secours.utilise » (courriel si relais, voir REQ-AUTH-014) |
| REQ-AUTH-008 | HIGH | PASS | `socle/src/totp.js:35` ; rejeu refusé : `socle/src/comptes.js:624` | RFC 6238, 6 chiffres, 30 s, ±1 pas, secret scellé AES-256-GCM |
| REQ-AUTH-009 | CRITICAL | PASS | aucune voie SMS ni code par courriel : `grep -rniwE "sms\|twilio" src ui socle/src` → 0 ; connexions possibles : `socle/src/comptes.js:465` | le lien de réinitialisation est remis par un administrateur, jamais envoyé seul |
| REQ-AUTH-010 | CRITICAL | PASS | humains : `socle/src/limiteur.js:20` (SQLite, par adresse et par compte, paliers de verrou, preuve de travail après trois échecs) ; jetons des services : chaque refus compte pour l’adresse dans le même limiteur persistant (`src/server.js:1227`, `src/server.js:1239`) : dix échecs bloquent l’adresse, même pour un bon jeton | essai `test/serveur.test.mjs:91` ; sondage P27 |
| REQ-AUTH-011 | HIGH | PASS | vérification leurre : `socle/src/argon.js:110` ; message unique | essai `socle/test/parcours.test.js:81` |
| REQ-AUTH-012 | HIGH | PASS | `socle/src/comptes.js:1032` : l’adresse n’existe que dans le jeton haché tant qu’elle n’est pas vérifiée ; `socle/src/comptes.js:1041` | l’adresse ne sert qu’aux alertes : ni identifiant, ni récupération, ni droit ; pas d’inscription libre (invitation seulement) |
| REQ-AUTH-013 | HIGH | PASS | `socle/src/comptes.js:831` | le premier compte naît administrateur et doit inscrire une clé avant tout accès complet (en HTTPS) |
| REQ-AUTH-014 | MEDIUM | FAIL | `socle/src/notifications.js:97` ; « ce n’était pas moi » : `socle/src/comptes.js:1019` | implémenté et essayé (`socle/test/courriel.test.js:63`) ; ne part que si un relais SMTP est configuré → action H2 |
| REQ-CRYPT-001 | CRITICAL | PASS | `socle/src/argon.js:15` ; 64 Mio, t=3, p=4 par défaut : `socle/src/index.js:42` | Argon2id natif de Node, sel de 16 octets par empreinte |
| REQ-CRYPT-002 | HIGH | PASS | `socle/src/argon.js:72` ; écrit dans la même requête : `socle/src/argon.js:129` | essai `socle/test/crypto.test.js:23` |
| REQ-CRYPT-003 | MEDIUM | N/A | bcrypt absent : `grep -rniwE "bcrypt" src ui socle/src` → 0 ; Argon2id seul |  |
| REQ-CRYPT-004 | HIGH | PASS | `socle/src/motdepasse.js:12`, `socle/src/motdepasse.js:13`, liste de fuites locale `socle/src/motdepasse.js:18` | contrôlé côté serveur, sans règle de composition ni rotation forcée |
| REQ-CRYPT-005 | HIGH | PASS | `socle/src/outils.js:16` ; jetons de service de 192 bits tirés par `crypto.randomBytes` (`src/cli.js:38`) ; jetons de cerveau vérifiés par HMAC-SHA256 en temps constant (`src/cerveaux.js:63`) ; `grep -rnE "Math\.random\|uuidv1" src socle/src` → 0 | `Math.random` ne sert qu’à l’animation de la vue 3D (`ui/index.html`), jamais à un secret |
| REQ-CRYPT-006 | MEDIUM | PASS | jetons des services gardés par leur empreinte SHA-256, jamais en clair (`src/server.js:234`) ; sessions : `socle/src/comptes.js:289` ; jeton Telegram, que SYNAPSE doit pouvoir rejouer, scellé et non haché (`src/config.js:81`) | un jeton de 192 bits aléatoires n’a pas besoin d’un hachage lent |
| REQ-SESS-001 | CRITICAL | PASS | `socle/src/http.js:105` ; __Host- en HTTPS : `socle/src/portail.js:51` | aucune session dans le stockage du navigateur (`localStorage` : thème et traits déjà vus) ; les services présentent un jeton, jamais un cookie |
| REQ-SESS-002 | CRITICAL | PASS | `socle/src/comptes.js:304` à la connexion, au renfort et à chaque changement de facteur ou de rôle | pas de jeton de rafraîchissement : sessions serveur |
| REQ-SESS-003 | HIGH | PASS | `socle/src/comptes.js:328` ; révocation : `socle/src/portail.js:325` et incident : `socle/src/portail.js:489` | appareil, adresse IP, première et dernière vue ; la réponse en flux revérifie la session à son ouverture (`src/server.js:1304`) |
| REQ-SESS-004 | HIGH | PASS | `socle/src/comptes.js:750` ; déconnexion serveur : `socle/src/portail.js:276` | runbook : `outils/exercice-incident.mjs:56` |
| REQ-SESS-005 | HIGH | PASS | `socle/src/comptes.js:344` ; routes de SYNAPSE sous renfort : réglages et jeton Telegram (`src/server.js:519`), application et validation d’un rangement qui supprime (`src/server.js:563`, `src/server.js:603`) | essai `test/serveur.test.mjs:44` |
| REQ-SESS-006 | MEDIUM | PASS | 12 h absolues, 60 min d’inactivité : `socle/src/index.js:40` | pas de JWT ; la réponse en flux revérifie la session à son ouverture |
| REQ-ANON-001 | CRITICAL | PASS | `git log --all --format="%an <%ae>" \| sort -u` et `--format="%cn <%ce>"` → une ligne chacun, le pseudonyme | posée par commit, jamais par une configuration du dépôt |
| REQ-ANON-002 | CRITICAL | FAIL | arbre : annexe B.1 → seulement les adresses fabriquées des essais (plage de documentation 192.0.2.0/24) et les noms de fichiers du `.gitignore` ; 0 occurrence de la liste d’anonymat | l’historique publié (jusqu’à v1.9.5) garde des termes de la liste et des fuseaux non UTC (annexe B.1.10, B.1.14) : seul l’exploitant peut décider, action H12 ; détail dans le rapport hors dépôt |
| REQ-ANON-003 | CRITICAL | FAIL | liste et crochet global à poser sur le poste ; contrôle CI par secret : `.github/workflows/verification.yml:76` | action H4 |
| REQ-ANON-004 | CRITICAL | PASS | commande de REQ-ANON-004 sur tout l’historique (`git log --all --format=%B \| grep -niE 'co-authored-by\|generated with\|assistant\|claude\|copilot\|cursor\|gpt\|🤖'`) → 0 | la même commande en CI sur chaque nouveau commit : `.github/workflows/verification.yml:71` |
| REQ-ANON-005 | HIGH | PASS | `package.json:2` sans champ auteur ; `LICENSE:3` | contact de sécurité : le signalement privé du dépôt (`src/server.js:39`) |
| REQ-ANON-006 | HIGH | PASS | `git log --all --name-only --format= \| grep -iE "\.(png\|jpe?g\|gif\|webp\|pdf\|docx?\|xlsx?\|mov\|mp4)$"` → 0 : aucune image ni document dans tout l’historique | polices et bibliothèque 3D : fichiers de tiers, sans métadonnée d’auteur (`ui/vendor/PROVENANCE.txt`) |
| REQ-ANON-007 | HIGH | PASS | comptes « ana », « leo », « lea », « bruno » ; services nommés comme les autres projets de la suite ; adresses de la plage de documentation (`src/sources.test.js:11`) ; jetons d’essai fabriqués (`test/instance.mjs:11`) |  |
| REQ-ANON-008 | MEDIUM | FAIL | nouveaux commits tous en UTC (`git log --format=%aI v1.9.5..main \| grep -v "+00:00$"` → 0) ; contrôle CI : `.github/workflows/verification.yml:70` | 30 commits de l’historique publié portent un fuseau non UTC : action H12 |
| REQ-ANON-009 | MEDIUM | FAIL | pages d’erreur sans chemin : `socle/src/http.js:171` ; santé sans version ni nom d’hôte (`src/server.js:324`) ; domaine et WHOIS hors dépôt | action H13 |
| REQ-ANON-010 | MEDIUM | PASS | identité stable et unique, dates réelles (TZ=UTC, jamais antidatées) | aucune politique de contribution externe |
| REQ-CFG-001 | CRITICAL | PASS | gitleaks sur tout l’historique, toutes références comprises, relancé à chaque génération de ce fichier → aucune fuite ; `git grep` de l’annexe B.2 → valeurs d’essai seulement | détail dans l’annexe B ci-dessous ; gitleaks en CI : `.github/workflows/verification.yml:48` |
| REQ-CFG-002 | CRITICAL | PASS | secrets jamais rendus : le jeton Telegram sort réduit à sa fin (`src/config.js:106`) ; jetons des services montrés une fois, à la création (`src/cli.js:38`) ; aucune construction : `ui/` est servi tel quel | sondage exploratoire ci-dessous (P22, P23) |
| REQ-CFG-003 | HIGH | FAIL | VM d’essai et production distinctes (règle de l’exploitant) | jetons du Hub, clé d’IA distante et bot Telegram séparés par environnement : action H6 |
| REQ-CFG-004 | HIGH | PASS | configuration du socle validée au démarrage (`socle/src/config.js:14`) ; toute route sans schéma arrête le démarrage (`src/server.js:1332`) ; jeton du Hub de 16 caractères au moins (`src/server.js:107`) | aucun mode de débogage ni contournement par variable |
| REQ-CFG-005 | HIGH | PASS | chaque secret, son lieu et sa rotation : section « Secrets inventory » ci-dessous ; SOCLE_CLE tournée et le jeton Telegram rescellé (`src/config.js:89`) ; secrets retirés sans arrêter le service (`src/cli.js:155`) | joué de bout en bout : `outils/exercice-incident.mjs:59` (26 vérifications, rejoué par les essais) |
| REQ-CI-001 | CRITICAL | FAIL | `.github/workflows/verification.yml:48` | Actions, crochet local et protection de poussée à activer : actions H3, H4 |
| REQ-CI-002 | HIGH | FAIL | CodeQL, requêtes « security-extended » : `.github/workflows/verification.yml:112` | bloquant une fois les Actions actives et le contrôle requis : action H3 |
| REQ-CI-003 | HIGH | FAIL | aucune dépendance npm, contrôlé en CI (`.github/workflows/verification.yml:38`) ; image de base épinglée par empreinte (`Dockerfile:6`) ; actions épinglées par commit ; mises à jour proposées, jamais appliquées seules (`.github/dependabot.yml:6`) | le dépôt est prêt ; l’exécution en CI, les alertes et le contrôle requis dépendent de GitHub : action H3 |
| REQ-CI-004 | HIGH | FAIL | `.github/workflows/verification.yml:89` | échoue tant que le secret n’existe pas : action H4 |
| REQ-CI-005 | MEDIUM | FAIL | permissions minimales `.github/workflows/verification.yml:15` ; actions épinglées par commit | protection de branche : action H3 |
| REQ-CI-006 | MEDIUM | PASS | chaque route du serveur balayée selon une table de droits — sans identité, jeton faux, jeton de service, session en lecture ; une route absente de la table fait échouer (essai `test/balayage.test.mjs:47`) ; autorisation objet par objet : `test/autorisations.test.mjs:20`, `test/autorisations.test.mjs:82` | cassures volontaires : NO-VIBE.md |
| REQ-WEB-001 | CRITICAL | FAIL | HSTS dès que la requête est chiffrée : `socle/src/http.js:88` | SYNAPSE est publiée par le Hub ou sur la boucle locale (`docker-compose.yml:44`) ; servie en HTTP tant qu’aucun relais TLS n’est posé : action H1 |
| REQ-WEB-002 | HIGH | PASS | chaque page : `src/server.js:1282` sur `socle/src/http.js:62` (script-src 'self' et un nonce par requête, object-src 'none', base-uri 'none', frame-ancestors 'none', aucun unsafe-eval) | style-src garde 'unsafe-inline' (styles calculés de la vue 3D), admis par SEC-HDR-002 ; essai `test/serveur.test.mjs:109` ; parcours navigateur du 2026-10-19 : aucune erreur ni violation de CSP |
| REQ-WEB-003 | HIGH | PASS | `socle/src/http.js:79`, Referrer-Policy, Permissions-Policy, X-Frame-Options, COOP, CORP, no-store, ni Server ni X-Powered-By (annexe B.4) | HSTS dès HTTPS (H1) |
| REQ-WEB-004 | HIGH | PASS | aucun en-tête CORS sans `CORS_ORIGIN` ; avec, une seule origine, jamais `*`, jamais de cookies (`src/server.js:288`) | `curl -sI -H "Origin: https://evil.example" /v1/stats` → aucun Access-Control-* (annexe B.4) |
| REQ-WEB-005 | HIGH | PASS | CSRF : `socle/src/portail.js:98` ; JSON exigé pour toute écriture : `socle/src/http.js:122` (`src/server.js:303`) ; aucun GET n’écrit ; SSRF : aucune adresse saisie par un utilisateur — Ollama, l’IA et l’agrégateur sont posés par l’exploitant, Telegram est un hôte fixe (`src/planif.js:37`) | sondage P12, P13, P19 |
| REQ-WEB-006 | CRITICAL | PASS | corps et paramètres de requête : un schéma par route (`src/schemas.js:47`), champ inconnu refusé (`socle/src/schema.js:69`), paramètre répété refusé (`src/server.js:1310`) ; une route sans schéma empêche le démarrage ; chaque appel du manifeste du Hub passe le schéma de sa route | essai `test/serveur.test.mjs:200`, essai `test/manifeste.test.mjs:27` ; sondage P14 à P17 |
| REQ-WEB-007 | HIGH | PASS | requêtes préparées partout ; aucun processus lancé par le serveur (`grep -rnwE "child_process\|execFile\|spawn" src` → 0) |  |
| REQ-WEB-008 | MEDIUM | PASS | débit global par adresse (`src/server.js:1383`) ; par appelant : ingestion 600/min, neurones et incidents 240/min, IA 30/min (`src/server.js:950`), relecture 4/min, export 2/min ; plafond quotidien d’appels à une IA distante, en base (`src/llm.js:36`) ; jetons refusés au limiteur persistant | essai `test/ia.test.mjs:49`, essai `test/serveur.test.mjs:237` ; processus unique de longue durée : les compteurs par appelant vivent en mémoire, ceux qui protègent l’authentification en base |
| REQ-DATA-001 | CRITICAL | PASS | SQLite embarqué, aucun port : `src/db.js:27` ; dossier en 0700 et base en 0600 : `src/db.js:29` | essai `test/serveur.test.mjs:250` |
| REQ-DATA-002 | HIGH | FAIL | secrets TOTP et jeton Telegram scellés AES-256-GCM, sous-clé par usage (`src/config.js:20` sur `socle/src/chiffre.js:60`) ; IA distante et Telegram en HTTPS vérifié | restent le chiffrement du disque des hôtes, HTTPS vers SYNAPSE elle-même et le trafic entre conteneurs du Hub : actions H1, H7 |
| REQ-DATA-003 | HIGH | FAIL | sauvegarde chiffrée pour une clé publique RSA : `src/cli.js:144` ; restauration ailleurs avec la clé privée seule : `src/cli.js:129` ; restauration réelle puis démarrage sur la base restaurée : `outils/exercice-incident.mjs:80` | planification quotidienne, copie hors hôte, trente jours de garde et exercice daté : actions H8, H16 |
| REQ-DATA-004 | HIGH | PASS | socle : connexions, facteurs, rôles, refus (`socle/src/portail.js:110`), verrous du limiteur ; SYNAPSE : jetons refusés (`src/server.js:1228`), gestes refusés à un jeton (`src/server.js:1262`), réglages, rangements appliqués, plafond de l’IA, gestes en ligne de commande (`src/cli.js:18`) | essai `test/autorisations.test.mjs:67` ; journal chaîné : `socle/src/journal.js:10` |
| REQ-DATA-005 | MEDIUM | PASS | vigie du socle : `socle/src/vigie.js:11` (connexions, refus, limites, erreurs internes) ; runbook d’une page ci-dessous, joué de bout en bout par `outils/exercice-incident.mjs:1` et rejoué par les essais (`test/incident.test.mjs:8`) | alertes hors de l’application par courriel : action H2 |
| REQ-DATA-006 | MEDIUM | PASS | `ui/confidentialite.txt:7` (chaque donnée, sa finalité, sa durée) ; questions posées gardées trente jours (`src/activite.js:19`, purge `src/server.js:129`) ; incidents purgés à douze mois par défaut | essai `test/serveur.test.mjs:137` |
| REQ-DATA-007 | MEDIUM | N/A | aucun envoi de fichier ni import depuis une adresse fournie par un utilisateur : corps JSON seulement (`socle/src/http.js:122`), `grep -rniwE "multipart\|busboy\|formidable\|multer" src ui socle/src` → 0 |  |
| REQ-CODE-001 | HIGH | PASS | essais de référence relevés avant la passe (voir NO-VIBE.md) ; surface publique inchangée hors correctifs voulus, chacun dit dans « Findings » : schémas (400), corps bornés (413, 415), 405, entrée d’un autre espace en 404 | voir NO-VIBE.md |
| REQ-CODE-002 | HIGH | PASS | voir NO-VIBE.md, couche des commentaires |  |
| REQ-CODE-003 | HIGH | PASS | voir NO-VIBE.md, couches structurelle et défensive |  |
| REQ-CODE-004 | HIGH | PASS | voir NO-VIBE.md, profil de style du dépôt |  |
| REQ-CODE-005 | MEDIUM | PASS | cassures volontaires, chacune détectée par au moins un essai : NO-VIBE.md, « Tests » |  |
| REQ-CODE-006 | MEDIUM | PASS | un sujet par commit, message d’une seule ligne dans le style du dépôt : `git log --format=%b v1.9.5..main \| grep -c .` → 0 (aucun corps, aucune ligne de fin) | aucune mention d’outil (REQ-ANON-004) |
| GOV-001 | HIGH | PASS | ce document : revue datée, périmètre (258 contrôles), résolution ligne par ligne, deux passes complètes | à refaire à chaque changement généré important |
| GOV-002 | MEDIUM | PASS | section « Inventory » ci-dessous : routes, données, tiers, secrets |  |
| GOV-003 | LOW | FAIL | `socle/src/portail.js:150` ; contact : `src/server.js:39` | essai `test/serveur.test.mjs:109` ; activer le signalement privé sur le dépôt : action H3 |
| GOV-004 | MEDIUM | FAIL | VM d’essai distincte de la production (règle de l’exploitant) ; données d’essai fabriquées, instances neuves par essai (`test/instance.mjs:14`) | jetons et clés distincts à confirmer : action H6 |
| GOV-005 | HIGH | FAIL | jeton CI éphémère et limité : `.github/workflows/publish.yml:15` | 2FA sur GitHub et les consoles des fournisseurs : action H3 |
| SEC-SECRETS-001 | CRITICAL | PASS | gitleaks sur tout l’historique → aucune fuite ; `git grep` de REQ-CFG-001 → valeurs d’essai seulement | gitleaks en CI (H3) |
| SEC-SECRETS-002 | CRITICAL | PASS | aucune variable publique ni construction : `ui/` servi tel quel ; `grep -rnE "sk-[A-Za-z0-9_-]{20}\|sk_live\|xox[bp]-\|ghp_" ui client` → 0 | la clé de l’IA distante ne quitte jamais le serveur (SEC-LLM-001) |
| SEC-SECRETS-003 | CRITICAL | PASS | `.gitignore:9`, `.gitignore:11` ; seuls `ui/` et `socle/web` sont servis, sous des chemins connus : `/.env` → 404 (sondage P21) |  |
| SEC-SECRETS-004 | HIGH | PASS | installé par le Hub : secrets posés depuis son coffre (`deploy/compose.hub.yml:53`) ; installé seul : secret Docker hors du volume (`docker-compose.yml:12`) ; fichiers acceptés : `socle/src/config.js:5` ; jeton Telegram scellé en base | jamais dans la CI |
| SEC-SECRETS-005 | HIGH | FAIL | une clé par usage : jeton par service, haché, révocable (`src/cli.js:168`) ; jeton de cerveau dérivé par service, qui ne vaut que pour lui (`src/server.js:246`) | clé d’IA dédiée et séparée par environnement : action H6 |
| SEC-SECRETS-006 | HIGH | FAIL | procédures de rotation ci-dessous ; SOCLE_CLE et jeton du Hub exercés (`outils/exercice-incident.mjs:59`) | clés et jetons vus pendant le développement, et jeton « hub-admin » de la 1.x : action H5 |
| SEC-SECRETS-007 | HIGH | PASS | clé maîtresse de 32 octets aléatoires : `socle/src/chiffre.js:24` ; jetons de 192 bits (`src/cli.js:38`) ; jeton Telegram contrôlé à sa forme (`src/config.js:24`) ; valeurs d’exemple refusées : `socle/src/config.js:54` |  |
| SEC-SECRETS-008 | MEDIUM | PASS | configuration du socle validée, démarrage refusé sur une valeur invalide ; route sans schéma refusée au démarrage ; aucun mode de débogage ; mode HTTP dégradé affiché en permanence : `socle/web/compte.js:589` |  |
| SEC-AUTH-001 | CRITICAL | PASS | voir REQ-CRYPT-001 |  |
| SEC-AUTH-002 | MEDIUM | PASS | voir REQ-CRYPT-004 |  |
| SEC-AUTH-003 | CRITICAL | PASS | voir REQ-AUTH-010 : humains par adresse et par compte, jetons des services par adresse, dans le même limiteur persistant |  |
| SEC-AUTH-004 | MEDIUM | PASS | voir REQ-AUTH-011 |  |
| SEC-AUTH-005 | CRITICAL | PASS | voir REQ-AUTH-006 ; lien depuis l’adresse publique : `socle/src/portail.js:56` | sans adresse publique, l’origine attestée par le navigateur de l’administrateur, contrôlée sur la même requête |
| SEC-AUTH-006 | MEDIUM | PASS | confirmation sur la nouvelle adresse et avis à l’ancienne : `socle/src/comptes.js:1047` | essai `socle/test/courriel.test.js:122` |
| SEC-AUTH-007 | HIGH | PASS | TOTP et clés pour tous, second facteur imposé aux administrateurs : `socle/src/comptes.js:178` | codes de secours toujours émis |
| SEC-AUTH-008 | HIGH | N/A | aucune connexion par fournisseur externe : `grep -rniwE "oauth\|openid\|oidc\|passport" src ui socle/src` → 0 |  |
| SEC-AUTH-009 | HIGH | PASS | les liens reçus par courriel demandent un geste : `socle/web/compte.js:452` ; uniques et courts : `socle/src/comptes.js:38` | aucune connexion sans mot de passe par courriel |
| SEC-AUTH-010 | CRITICAL | PASS | chaque route exige une identité avant tout (`src/server.js:1305`), puis vérifie portée, espace ou rôle en tête, avant de lire son corps | essai `test/balayage.test.mjs:53`, essai `test/balayage.test.mjs:63` |
| SEC-AUTH-011 | HIGH | PASS | jeton faux → 401, et un jeton présenté ne retombe jamais sur la session (`src/server.js:1238`) ; erreur imprévue réduite à un message générique : `src/server.js:1327` | sondage P2 |
| SEC-SESS-001 | CRITICAL | PASS | voir REQ-SESS-001 |  |
| SEC-SESS-002 | HIGH | PASS | `grep -rn "localStorage" ui socle/web/compte.js` → thème (`socle/web/compte.js:302`) et traits déjà vus de la fiche, jamais une session ni un jeton |  |
| SEC-SESS-003 | HIGH | PASS | 256 bits : `socle/src/comptes.js:289` | renouvelé à chaque changement de niveau |
| SEC-SESS-004 | HIGH | PASS | voir REQ-SESS-003, REQ-SESS-004 et REQ-SESS-006 |  |
| SEC-SESS-005 | CRITICAL | N/A | aucun JWT : `grep -rniwE "jwt\|jsonwebtoken\|jose" src ui socle/src` → 0 ; sessions serveur |  |
| SEC-SESS-006 | MEDIUM | N/A | aucun jeton de rafraîchissement : sessions serveur (voir SEC-SESS-005) |  |
| SEC-SESS-007 | MEDIUM | PASS | voir REQ-SESS-005 ; avis par courriel via le canal d’alerte | courriel : H2 |
| SEC-AUTHZ-001 | CRITICAL | PASS | propriétaire d’objet = espace : un service lit et écrit son espace et les espaces communs, jamais celui d’un autre (`src/server.js:1182`) ; l’entrée d’un autre espace est introuvable, ses liens filtrés (`src/server.js:455`, MCP `src/mcp.js:214`) ; les neurones forment la mémoire d’incidents partagée, lue par toute portée incidents, écrite et oubliée par leur seule source | essai `test/autorisations.test.mjs:20`, essai `test/autorisations.test.mjs:82`, essai `test/autorisations.test.mjs:59` ; sondage P3 à P6, P26 |
| SEC-AUTHZ-002 | CRITICAL | PASS | rôle humain lu en base par le socle (`socle/src/portail.js:120`) ; portées des jetons fermées (lecture, écriture, incidents, admin) ; gestes humains par rôle et renfort (`src/server.js:1252`) ; une session humaine n’écrit jamais dans la mémoire | essai `test/balayage.test.mjs:68` |
| SEC-AUTHZ-003 | HIGH | PASS | schémas stricts, champ inconnu refusé : `socle/src/schema.js:69` ; la provenance d’une entrée est celle du jeton, jamais du corps (`src/ingest.js:141`) ; l’agent nommé est celui de l’appelant, sauf pour le Hub qui relaie ses IA (`src/server.js:1352`) | essai `test/autorisations.test.mjs:30` ; sondage P6, P14, P15 |
| SEC-AUTHZ-004 | HIGH | PASS | route inconnue → 404, méthode non servie → 405 avec Allow (`src/server.js:1299`) ; une seule route publique : la santé | aucune route de débogage ni de semis ; table des droits : `test/balayage.test.mjs:17` |
| SEC-AUTHZ-005 | CRITICAL | N/A | aucune notion de locataire : une instance sert une infrastructure ; les espaces par service sont l’autorisation objet (SEC-AUTHZ-001) ; `grep -rniwE "tenants?\|organisations?" src socle/src` → 0 |  |
| SEC-AUTHZ-006 | LOW | PASS | identifiants d’entrées séquentiels, mais l’entrée d’un autre espace est introuvable (404) et ses liens filtrés : connaître un numéro n’ouvre rien | sondage P3 |
| SEC-AUTHZ-007 | HIGH | PASS | invariants tenus par le serveur : le rangement ne supprime qu’après validation humaine sous renfort, avec une copie de la base avant (`src/server.js:603`) ; seuil de doublon borné à 0,88 au moins (`src/config.js:72`) ; un neurone n’est oublié que par sa source |  |
| SEC-AUTHZ-008 | MEDIUM | PASS | rôle, portée et renfort exigés par le serveur, jamais par l’interface : chaque route est refusée appelée directement | essai `test/balayage.test.mjs:63` |
| SEC-INJ-001 | CRITICAL | PASS | requêtes préparées partout ; recherche plein texte : la requête FTS5 est construite de jetons nettoyés, passée en paramètre (`src/search.js:119`) | annexe B.3 ; sondage P25 |
| SEC-INJ-002 | HIGH | N/A | aucun ORM : node:sqlite, requêtes préparées seulement |  |
| SEC-INJ-003 | HIGH | N/A | aucune base documentaire : SQLite seulement ; JSON rangé en colonne texte |  |
| SEC-INJ-004 | CRITICAL | PASS | aucun processus lancé : `grep -rnwE "child_process\|execFile\|spawn" src` → 0 |  |
| SEC-INJ-005 | HIGH | PASS | `socle/src/http.js:205` ; aucun fichier écrit d’après une saisie : la base, et les copies de rangement nommées par le serveur |  |
| SEC-INJ-006 | HIGH | PASS | aucun gabarit côté serveur ; `grep -rnE "new Function\|node:vm" src socle/src` → 0 |  |
| SEC-INJ-007 | HIGH | N/A | aucun analyseur XML côté serveur : `grep -rniwE "xml2js\|sax\|libxml\|fast-xml\|xmldom" src socle/src` → 0 |  |
| SEC-INJ-008 | HIGH | PASS | JSON seulement ; clés de prototype refusées : `socle/src/schema.js:6` ; champs JSON libres (`meta`, `tags`, `context`) bornés en profondeur et contrôlés (`src/schemas.js:14`) ; réponses des modèles relues champ par champ | sondage P15 |
| SEC-XSS-001 | CRITICAL | PASS | interface : tout texte venu de la mémoire, d’un service ou du modèle passe par `esc()` avant d’entrer dans le DOM (`ui/index.html:456`, `ui/parametres.html:214`) ; page du compte construite par `h()` du socle (`socle/web/compte.js:11`) ; nombres et étiquettes fixes seuls insérés tels quels | relecture de chaque `innerHTML` de `ui/` le 2026-10-19 ; réponses de l’IA affichées en texte, seuls les renvois [n] mis en gras après échappement (`ui/index.html:1480`) |
| SEC-XSS-002 | HIGH | N/A | aucun texte riche ni Markdown rendu : réponses de l’IA, entrées et traits affichés en texte échappé (voir SEC-XSS-001) |  |
| SEC-XSS-003 | HIGH | PASS | aucun eval ni Function : `grep -rnE "eval\(\|new Function" ui socle/web` → 0 ; les seules affectations de `location` mènent à des chemins fixes (`/connexion`, `/`) |  |
| SEC-XSS-004 | HIGH | PASS | voir REQ-WEB-002 |  |
| SEC-XSS-005 | MEDIUM | PASS | seul échange : le Worker de preuve de travail, de même origine : `socle/web/compte.js:236` | aucune écoute de window message |
| SEC-XSS-006 | MEDIUM | PASS | erreurs imprévues réduites à un message générique ; message d’erreur de l’IA réduit à une cause courte et affiché échappé |  |
| SEC-XSS-007 | MEDIUM | N/A | aucune redirection pilotée par paramètre : `curl -sI "/connexion?next=https://evil.example"` → aucun Location (annexe B.4) |  |
| SEC-XSS-008 | MEDIUM | PASS | aucun script tiers ni CDN : three.js r128 et les polices servis par SYNAPSE depuis `ui/vendor`, avec provenance et empreintes contrôlées en CI (`.github/workflows/verification.yml:33`) ; `grep -rnE "src=\"https?://" ui/*.html` → 0 |  |
| SEC-HDR-001 | HIGH | FAIL | voir REQ-WEB-001 | action H1 |
| SEC-HDR-002 | HIGH | PASS | voir REQ-WEB-002 |  |
| SEC-HDR-003 | MEDIUM | PASS | voir REQ-WEB-003 |  |
| SEC-HDR-004 | LOW | PASS | `curl -sI /` : ni Server ni X-Powered-By (annexe B.4) |  |
| SEC-HDR-005 | MEDIUM | PASS | no-store sur l’API et les pages : `socle/src/http.js:150` ; seuls les fichiers publics, sous leur version (`/v/<version>/`), sont mis en cache (`src/server.js:1211`) | aucun CDN |
| SEC-HDR-006 | CRITICAL | PASS | voir REQ-WEB-004 |  |
| SEC-HDR-007 | HIGH | PASS | voir REQ-SESS-001 |  |
| SEC-CSRF-001 | HIGH | PASS | SameSite=Strict + origine + jeton : `socle/src/portail.js:98` appelé par chaque écriture de session | sondage P12, P13 ; les services présentent un jeton en en-tête, que le navigateur n’envoie jamais seul |
| SEC-CSRF-002 | MEDIUM | PASS | `socle/src/http.js:122` | 415 sur tout autre type |
| SEC-CSRF-003 | MEDIUM | PASS | voir REQ-WEB-005 : aucun GET n’écrit | un GET de SYNAPSE lit la base ; la question posée est seulement mesurée (activité) |
| SEC-CSRF-004 | CRITICAL | PASS | adresses que le serveur joint : Ollama, l’IA distante et l’agrégateur, posés par l’exploitant dans l’environnement ; Telegram, hôte fixe ; aucune adresse ne vient d’une requête |  |
| SEC-CSRF-005 | HIGH | PASS | webhooks sortants : Telegram seulement (envoi, aucun bot qui écoute) ; données reçues : uniquement de services authentifiés par leur jeton |  |
| SEC-CSRF-006 | MEDIUM | N/A | aucune redirection pilotée par paramètre : voir SEC-XSS-007 |  |
| SEC-API-001 | HIGH | PASS | voir REQ-WEB-006 |  |
| SEC-API-002 | HIGH | PASS | voir REQ-WEB-008 ; jetons refusés plafonnés par adresse (voir REQ-AUTH-010) |  |
| SEC-API-003 | MEDIUM | PASS | chaque liste bornée côté serveur : recherche 50, neurones 500 (`src/neurons.js:541`), graphe 1 400, historique d’incidents 500, et le schéma refuse au-delà de 1 000 ; seule liste sans page : l’export entier, portée admin et deux par minute (`src/server.js:879`) | sondage P17 |
| SEC-API-004 | HIGH | PASS | réponses construites champ par champ : entrée (`src/server.js:457`), jeton Telegram réduit à sa fin, sources sans empreinte de jeton ; santé sans volumétrie | sondage P22 |
| SEC-API-005 | MEDIUM | PASS | 405 avec Allow, TRACE compris ; aucune page de documentation ni de débogage | essai `test/serveur.test.mjs:227` ; sondage P20, P21 |
| SEC-API-006 | HIGH | N/A | aucun GraphQL : `grep -rniwE "graphql\|apollo" src ui socle/src` → 0 |  |
| SEC-API-007 | MEDIUM | PASS | un seul formateur d’erreurs : `socle/src/http.js:159` ; panne → 500 générique, détail au journal du conteneur seulement |  |
| SEC-API-008 | MEDIUM | N/A | aucune opération monétaire ni crédit : `grep -rniwE "stripe\|paypal\|checkout\|invoice\|payout\|refund" src ui socle/src` → 0 |  |
| SEC-API-009 | HIGH | PASS | MCP traité comme une route publique : jeton, schéma de la requête, et chaque outil revérifie l’espace et la portée de l’appelant (`src/mcp.js:214`) | sondage P26 |
| SEC-API-010 | MEDIUM | PASS | taille annoncée refusée en 413 avant lecture, puis bornée en lisant : `socle/src/http.js:128` ; 64 Kio par défaut, 128 à 512 Kio selon la route, `MAX_BODY` (2 Mo) pour l’ingestion, l’import et MCP (`src/schemas.js:45`) | essai `test/serveur.test.mjs:216` ; sondage P18 |
| SEC-DB-001 | CRITICAL | PASS | voir REQ-DATA-001 |  |
| SEC-DB-002 | HIGH | N/A | SQLite embarqué sans rôle ni identifiant : `src/db.js:27` |  |
| SEC-DB-003 | HIGH | FAIL | aucun trafic réseau vers la base ; secrets de facteurs et des réglages chiffrés | chiffrement du disque des hôtes : action H7 |
| SEC-DB-004 | MEDIUM | PASS | secrets TOTP et jeton Telegram scellés AES-256-GCM, sous-clé par usage ; clé maîtresse jamais dans le volume : secret du Hub, ou secret Docker hors du volume (`docker-compose.yml:12`) | copie restaurée relue en brut : secrets toujours scellés (`outils/exercice-incident.mjs:91`) |
| SEC-DB-005 | CRITICAL | PASS | voir SEC-INJ-001 |  |
| SEC-DB-006 | HIGH | FAIL | voir REQ-DATA-003 | action H8 |
| SEC-DB-007 | MEDIUM | PASS | essais sur données fabriquées ; aucun compte par défaut : jeton d’installation exigé (`socle/src/comptes.js:249`) |  |
| SEC-DB-008 | CRITICAL | N/A | le navigateur ne parle jamais à la base : SQLite côté serveur seulement |  |
| SEC-DB-009 | LOW | PASS | délai d’attente du verrou : `src/db.js:32` ; listes plafonnées | un seul processus, pas de pool nécessaire |
| SEC-DB-010 | LOW | PASS | voir REQ-DATA-004 : réglages, rangements appliqués, sauvegardes et secrets retirés au journal chaîné |  |
| SEC-FILE-001 | HIGH | N/A | aucun envoi de fichier : corps JSON seulement (`socle/src/http.js:122`) |  |
| SEC-FILE-002 | MEDIUM | N/A | aucun envoi de fichier ; corps JSON bornés (voir SEC-API-010) |  |
| SEC-FILE-003 | HIGH | N/A | aucun fichier d’utilisateur écrit ; seules écritures : la base et les copies de rangement, nommées par le serveur |  |
| SEC-FILE-004 | HIGH | N/A | aucun fichier d’utilisateur servi ; seuls `ui/` et `socle/web`, sous des chemins connus |  |
| SEC-FILE-005 | CRITICAL | N/A | aucun fichier d’utilisateur stocké |  |
| SEC-FILE-006 | MEDIUM | N/A | aucun fichier partagé entre utilisateurs |  |
| SEC-FILE-007 | LOW | N/A | aucune image acceptée |  |
| SEC-FILE-008 | HIGH | N/A | aucun import par adresse : les URL lues par le serveur sont posées par l’exploitant (voir SEC-CSRF-004) |  |
| SEC-PAY-001 | CRITICAL | N/A | aucun paiement : `grep -rniwE "stripe\|paypal\|checkout\|invoice\|payout\|refund" src ui socle/src` → 0 |  |
| SEC-PAY-002 | CRITICAL | N/A | aucun paiement : `grep -rniwE "stripe\|paypal\|checkout\|invoice\|payout\|refund" src ui socle/src` → 0 |  |
| SEC-PAY-003 | HIGH | N/A | aucun paiement : `grep -rniwE "stripe\|paypal\|checkout\|invoice\|payout\|refund" src ui socle/src` → 0 |  |
| SEC-PAY-004 | HIGH | N/A | aucun paiement : `grep -rniwE "stripe\|paypal\|checkout\|invoice\|payout\|refund" src ui socle/src` → 0 |  |
| SEC-PAY-005 | HIGH | N/A | aucun paiement : `grep -rniwE "stripe\|paypal\|checkout\|invoice\|payout\|refund" src ui socle/src` → 0 |  |
| SEC-PAY-006 | HIGH | PASS | vérification : 5 par heure par compte et par adresse (`socle/src/portail.js:38`) ; alertes : 30 par heure et par compte (`socle/src/notifications.js:98`) | destinataires et contenus jamais choisis par une requête |
| SEC-PAY-007 | MEDIUM | FAIL | le domaine d’expédition est celui du relais de l’exploitant | SPF, DKIM et DMARC à publier avec le relais : action H2 |
| SEC-PAY-008 | MEDIUM | PASS | aucun mot de passe dans un courriel ; liens uniques, hachés, de 30 minutes (`socle/src/comptes.js:38`) ou 72 heures pour fermer les sessions (`socle/src/notifications.js:27`) | le lien de révocation ne peut que fermer des sessions |
| SEC-NEXT-001 | CRITICAL | N/A | Node sans cadriciel, aucune dépendance (`package.json:7`) ; `grep -rniwE "next/\|nextjs\|getServerSideProps" src ui socle/src` → 0 |  |
| SEC-NEXT-002 | CRITICAL | N/A | Node sans cadriciel, aucune dépendance (`package.json:7`) ; `grep -rniwE "next/\|nextjs\|getServerSideProps" src ui socle/src` → 0 |  |
| SEC-NEXT-003 | HIGH | N/A | Node sans cadriciel, aucune dépendance (`package.json:7`) ; `grep -rniwE "next/\|nextjs\|getServerSideProps" src ui socle/src` → 0 |  |
| SEC-NEXT-004 | CRITICAL | N/A | Node sans cadriciel, aucune dépendance (`package.json:7`) ; `grep -rniwE "next/\|nextjs\|getServerSideProps" src ui socle/src` → 0 |  |
| SEC-NEXT-005 | HIGH | N/A | Node sans cadriciel, aucune dépendance (`package.json:7`) ; `grep -rniwE "next/\|nextjs\|getServerSideProps" src ui socle/src` → 0 |  |
| SEC-NEXT-006 | HIGH | N/A | Node sans cadriciel, aucune dépendance (`package.json:7`) ; `grep -rniwE "next/\|nextjs\|getServerSideProps" src ui socle/src` → 0 |  |
| SEC-NEXT-007 | HIGH | N/A | Node sans cadriciel, aucune dépendance (`package.json:7`) ; `grep -rniwE "next/\|nextjs\|getServerSideProps" src ui socle/src` → 0 |  |
| SEC-NEXT-008 | MEDIUM | N/A | Node sans cadriciel, aucune dépendance (`package.json:7`) ; `grep -rniwE "next/\|nextjs\|getServerSideProps" src ui socle/src` → 0 |  |
| SEC-NEXT-009 | MEDIUM | N/A | Node sans cadriciel, aucune dépendance (`package.json:7`) ; `grep -rniwE "next/\|nextjs\|getServerSideProps" src ui socle/src` → 0 |  |
| SEC-BAAS-001 | CRITICAL | N/A | `grep -rniwE "supabase\|firebase\|firestore" src ui socle/src` → 0 : SQLite embarqué |  |
| SEC-BAAS-002 | CRITICAL | N/A | `grep -rniwE "supabase\|firebase\|firestore" src ui socle/src` → 0 : SQLite embarqué |  |
| SEC-BAAS-003 | CRITICAL | N/A | `grep -rniwE "supabase\|firebase\|firestore" src ui socle/src` → 0 : SQLite embarqué |  |
| SEC-BAAS-004 | HIGH | N/A | `grep -rniwE "supabase\|firebase\|firestore" src ui socle/src` → 0 : SQLite embarqué |  |
| SEC-BAAS-005 | CRITICAL | N/A | `grep -rniwE "supabase\|firebase\|firestore" src ui socle/src` → 0 : SQLite embarqué |  |
| SEC-BAAS-006 | HIGH | N/A | `grep -rniwE "supabase\|firebase\|firestore" src ui socle/src` → 0 : SQLite embarqué |  |
| SEC-BAAS-007 | MEDIUM | N/A | `grep -rniwE "supabase\|firebase\|firestore" src ui socle/src` → 0 : SQLite embarqué |  |
| SEC-BAAS-008 | CRITICAL | N/A | `grep -rniwE "supabase\|firebase\|firestore" src ui socle/src` → 0 : SQLite embarqué |  |
| SEC-BAAS-009 | CRITICAL | N/A | `grep -rniwE "supabase\|firebase\|firestore" src ui socle/src` → 0 : SQLite embarqué |  |
| SEC-BAAS-010 | HIGH | N/A | `grep -rniwE "supabase\|firebase\|firestore" src ui socle/src` → 0 : SQLite embarqué |  |
| SEC-BAAS-011 | HIGH | N/A | `grep -rniwE "supabase\|firebase\|firestore" src ui socle/src` → 0 : SQLite embarqué |  |
| SEC-BE-001 | MEDIUM | PASS | en-têtes posés avant toute route, erreurs et 429 compris : `src/server.js:1281` | annexe B.4 ; essai `test/serveur.test.mjs:109` |
| SEC-BE-002 | MEDIUM | PASS | corps bornés ; 404 pour l’inconnu ; relais de confiance explicites : `socle/src/http.js:14` ; délais du serveur : `src/server.js:1391` ; réponses des modèles bornées (`src/llm.js:57`) | formateur d’erreurs unique |
| SEC-BE-003 | HIGH | PASS | voir SEC-INJ-004 et SEC-INJ-008 ; aucun import dynamique d’un chemin fourni | modules du navigateur importés depuis des chemins fixes |
| SEC-BE-004 | HIGH | PASS | aucune dépendance npm, contrôlé en CI (`.github/workflows/verification.yml:38`) : rien à verrouiller | Playwright ne sert qu’aux parcours hors dépôt |
| SEC-BE-005 | CRITICAL | N/A | aucun Django : serveur Node seul, aucun Python dans le dépôt (`git ls-files "*.py" \| wc -l` → 0) |  |
| SEC-BE-006 | HIGH | N/A | aucun Flask ni FastAPI : serveur Node seul, aucun Python dans le dépôt (`git ls-files "*.py" \| wc -l` → 0) |  |
| SEC-BE-007 | HIGH | N/A | aucun Python dans le dépôt : voir SEC-BE-006 |  |
| SEC-BE-008 | HIGH | N/A | aucun PHP : `git ls-files "*.php" \| wc -l` → 0 |  |
| SEC-BE-009 | MEDIUM | PASS | `Dockerfile:19` ; aucun programme setuid ni setgid (`Dockerfile:13`) ; conteneur en lecture seule, sans capacité, sans nouveaux privilèges (`deploy/compose.hub.yml:17`) ; base en 0600 |  |
| SEC-BE-010 | MEDIUM | PASS | `socle/src/http.js:159` ; santé réduite à « vivant » et à l’état des vecteurs, sans version ni nom d’hôte (`src/server.js:324`) | SYNAPSE démarre et répond sans Ollama : un service de confort, jamais une dépendance |
| SEC-WP-001 | CRITICAL | N/A | application Node écrite ici : `grep -rniwE "wordpress\|wp-admin\|wp-content\|xmlrpc" src ui socle/src` → 0 |  |
| SEC-WP-002 | HIGH | N/A | application Node écrite ici : `grep -rniwE "wordpress\|wp-admin\|wp-content\|xmlrpc" src ui socle/src` → 0 |  |
| SEC-WP-003 | HIGH | N/A | application Node écrite ici : `grep -rniwE "wordpress\|wp-admin\|wp-content\|xmlrpc" src ui socle/src` → 0 |  |
| SEC-WP-004 | MEDIUM | N/A | application Node écrite ici : `grep -rniwE "wordpress\|wp-admin\|wp-content\|xmlrpc" src ui socle/src` → 0 |  |
| SEC-WP-005 | MEDIUM | N/A | application Node écrite ici : `grep -rniwE "wordpress\|wp-admin\|wp-content\|xmlrpc" src ui socle/src` → 0 |  |
| SEC-WP-006 | CRITICAL | N/A | application Node écrite ici : `grep -rniwE "wordpress\|wp-admin\|wp-content\|xmlrpc" src ui socle/src` → 0 |  |
| SEC-WP-007 | HIGH | N/A | application Node écrite ici : `grep -rniwE "wordpress\|wp-admin\|wp-content\|xmlrpc" src ui socle/src` → 0 |  |
| SEC-WP-008 | MEDIUM | N/A | application Node écrite ici : `grep -rniwE "wordpress\|wp-admin\|wp-content\|xmlrpc" src ui socle/src` → 0 |  |
| SEC-INFRA-001 | HIGH | FAIL | voir REQ-WEB-001 | action H1 |
| SEC-INFRA-002 | MEDIUM | FAIL | aucun domaine dans le dépôt | DNS, CAA et verrou du registraire du domaine éventuel : action H13 |
| SEC-INFRA-003 | HIGH | FAIL | hôtes de l’exploitant | pare-feu, SSH par clé, mises à jour : action H9 |
| SEC-INFRA-004 | MEDIUM | FAIL | `Dockerfile:6` ; `Dockerfile:19` ; `deploy/compose.hub.yml:14` ; `deploy/compose.hub.yml:17` ; installé seul : interface publiée sur la boucle locale (`docker-compose.yml:44`) | crible de l’image (Grype en CI, Trivy au déploiement) à exécuter : actions H3, H14 |
| SEC-INFRA-005 | CRITICAL | N/A | aucun stockage objet : `grep -rniwE "s3\.\|gcs\|minio\|aws-sdk" src socle/src` → 0 |  |
| SEC-INFRA-006 | HIGH | N/A | aucun nuage : service auto-hébergé, aucune clé IAM ni compte de fournisseur d’infrastructure (`grep -rniwE "aws\|gcp\|azure\|iam" src` → 0) |  |
| SEC-INFRA-007 | HIGH | FAIL | permissions minimales, actions épinglées par commit, aucun secret pour les demandes de fusion | protection de branche et revue requise : action H3 |
| SEC-INFRA-008 | MEDIUM | FAIL | empreinte d’image, provenance et SBOM à la publication : `.github/workflows/publish.yml:87` | la publication tourne sur les Actions : action H3 |
| SEC-INFRA-009 | MEDIUM | N/A | aucune infrastructure décrite en code : `git ls-files "*.tf" "Pulumi.yaml" \| wc -l` → 0 |  |
| SEC-DEP-001 | HIGH | PASS | aucune dépendance npm ; image de base par empreinte (`Dockerfile:6`) ; actions par commit ; three.js figé à r128 avec son empreinte (`ui/vendor/EMPREINTES`) |  |
| SEC-DEP-002 | HIGH | FAIL | aucune dépendance npm ; image passée au crible à chaque publication (`.github/workflows/publish.yml:49`) | alertes Dependabot et contrôle requis : action H3 |
| SEC-DEP-003 | MEDIUM | PASS | aucune dépendance npm ; une seule bibliothèque du navigateur (three.js, vue 3D), figée et servie par SYNAPSE ; QR code et graphiques écrits ici (socle) |  |
| SEC-DEP-004 | MEDIUM | PASS | actions épinglées par commit ; image par empreinte ; mises à jour proposées en demandes de fusion, jamais fusionnées seules (`.github/dependabot.yml:6`) | revue requise avant fusion : protection de branche, action H3 |
| SEC-DEP-005 | MEDIUM | PASS | aucune installation de paquet npm : ni npm install ni script de cycle de vie, dans le dépôt comme dans l’image (`Dockerfile:15` sans installation) |  |
| SEC-DEP-006 | LOW | FAIL | `.github/workflows/publish.yml:88` | produit par la publication (H3) |
| SEC-DEP-007 | MEDIUM | PASS | voir SEC-XSS-008 |  |
| SEC-DEP-008 | LOW | FAIL | crible de l’image à chaque publication | abonnement aux avis GitHub : action H3 |
| SEC-LLM-001 | CRITICAL | PASS | clé de l’IA distante dans l’environnement du serveur seulement (`src/llm.js:73`) ; seul le serveur appelle le modèle ; `grep -rnE "sk-[A-Za-z0-9_-]{10,}" ui socle/web client` → 0 |  |
| SEC-LLM-002 | CRITICAL | FAIL | IA derrière un jeton ou une session ; 30 questions par minute et par appelant ; relectures 4 par minute ; plafond quotidien d’appels à une IA distante, compté en base avant l’appel (`src/llm.js:43`), une ligne de journal quand il est atteint ; jetons de sortie bornés | essai `test/ia.test.mjs:33` ; plafond de dépense chez le fournisseur : action H18 |
| SEC-LLM-003 | HIGH | PASS | mémoire, échanges et question clos entre deux balises qu’un texte ne peut pas refermer, avec la règle qu’aucune instruction n’y vaut (`src/llm.js:229`) ; le modèle ne décide de rien : il rédige un texte affiché, ou un JSON relu champ par champ (traits bornés, `src/apprentissage.js:185`) ; aucun outil, aucun secret dans son contexte | essai `test/ia.test.mjs:68`, essai `src/llm.test.js` (« données closes ») |
| SEC-LLM-004 | HIGH | PASS | sortie du modèle affichée en texte échappé (`ui/index.html:1480`) ; jamais exécutée ni utilisée en SQL ou en chemin ; balises de réflexion retirées (`src/llm.js:71`) |  |
| SEC-LLM-005 | CRITICAL | N/A | aucun outil ni agent côté SYNAPSE : le modèle reçoit un texte et rend un texte ou un JSON relu, sans appel de fonction (`grep -rniE "tool_choice\|function_call" src` → 0) ; les outils MCP sont exposés à des agents tiers et revérifient chaque appel côté serveur (SEC-API-009) |  |
| SEC-LLM-006 | HIGH | PASS | récupération filtrée par l’espace de l’appelant avant d’atteindre le modèle (`src/server.js:955`) ; aucun secret ni compte dans le contexte ; Ollama par défaut, sur le réseau de l’exploitant | réglage « sans entraînement » chez un fournisseur distant : action H18 |
| SEC-LLM-007 | MEDIUM | PASS | aucune IA publique : jeton ou session exigés ; le modèle est cantonné à la mémoire (« N’utilise que ces sources », `src/server.js:1105`) et n’est appelé que si la mémoire a de quoi répondre ; questions gardées trente jours pour enquêter sur un abus (`src/activite.js:19`) | débit et plafond : SEC-LLM-002 |
| SEC-LLM-008 | LOW | PASS | modèles choisis explicitement par l’exploitant (`src/llm.js:22`) ; index de vecteurs dans la même base SQLite, derrière les mêmes contrôles |  |
| SEC-LOG-001 | MEDIUM | PASS | voir REQ-DATA-004 ; chaque ligne : date, acteur, adresse, action, objet, résultat (`socle/src/journal.js:10`) | magasin persistant : le journal chaîné en base ; hors hôte : action H11 |
| SEC-LOG-002 | HIGH | PASS | `socle/src/journal.js:10` ; jamais un jeton ni une clé au journal : un réglage journalisé dit si le jeton Telegram a changé, jamais lequel ; les erreurs des modèles réduites à leur cause |  |
| SEC-LOG-003 | MEDIUM | FAIL | sortie standard conservée par Docker, hors de portée du service : `deploy/compose.hub.yml:22` | collecteur central hors hôte : action H11 |
| SEC-LOG-004 | MEDIUM | FAIL | règles : rafales d’échecs de connexion, jetons refusés, refus d’accès, verrous et limites, erreurs internes, connexion d’un administrateur (`socle/src/vigie.js:11`) | alertes hors de l’application par courriel : action H2 |
| SEC-LOG-005 | LOW | FAIL | santé du conteneur : `Dockerfile:24` ; sondes du Hub (`hub.json:871`) | surveillance externe : action H10 |
| SEC-LOG-006 | MEDIUM | PASS | runbook ci-dessous |  |
| SEC-LOG-007 | HIGH | PASS | sessions : fermeture globale `socle/src/portail.js:489` ; jeton Telegram retiré en ligne de commande, service en marche (`src/cli.js:155`) ; jeton du Hub changé au redéploiement ; SOCLE_CLE tournée sans réinscription | joué de bout en bout : `outils/exercice-incident.mjs:1` (26 vérifications) |
| SEC-PRIV-001 | MEDIUM | PASS | `ui/confidentialite.txt:7` avec durées ; purges automatiques : questions à trente jours, incidents à douze mois, `socle/src/comptes.js:1062` |  |
| SEC-PRIV-002 | MEDIUM | PASS | un cookie de session indispensable et un cookie de cérémonie, documentés ; aucun traceur (`ui/confidentialite.txt:79`) |  |
| SEC-PRIV-003 | MEDIUM | PASS | `ui/confidentialite.txt:61` nomme chaque destinataire, dont une IA distante et ce qu’elle reçoit ; servi par SYNAPSE (`/confidentialite.txt`) |  |
| SEC-PRIV-004 | MEDIUM | PASS | export : `socle/src/portail.js:343` complété par SYNAPSE (`src/server.js:1381`) ; effacement : `socle/src/comptes.js:932`, questions du compte effacées avec lui (`src/server.js:1382`) ; traits de la fiche corrigés ou oubliés d’un clic | essai `test/serveur.test.mjs:137` |
| SEC-PRIV-005 | HIGH | FAIL | voir REQ-DATA-002 | action H7 |
| SEC-PRIV-006 | LOW | FAIL | sous-traitants possibles, tous choisis par l’exploitant : IA distante (seulement si choisie), Telegram, relais SMTP | accord de traitement ou fournisseur européen : actions H15, H18 |
| SEC-PRIV-007 | MEDIUM | PASS | runbook : notification sous 72 heures |  |
| SEC-PRIV-008 | LOW | PASS | `ui/confidentialite.txt:104` | aucune catégorie particulière de données de lui-même |
| SEC-TEST-001 | MEDIUM | FAIL | `.github/workflows/verification.yml:112` | Actions : H3 |
| SEC-TEST-002 | HIGH | FAIL | voir REQ-CI-001 | actions H3, H4 |
| SEC-TEST-003 | HIGH | FAIL | image : `.github/workflows/publish.yml:49` | actions H3, H14 |
| SEC-TEST-004 | MEDIUM | FAIL | aucun passage DAST encore | ZAP en mode « baseline » contre la VM d’essai : action H14 |
| SEC-TEST-005 | LOW | FAIL | voir REQ-WEB-001 | notation après HTTPS : action H1 |
| SEC-TEST-006 | HIGH | PASS | voir REQ-CI-006 |  |
| SEC-TEST-007 | LOW | PASS | sondage exploratoire du 2026-10-19 (27 cas), rejoué à chaque génération de ce fichier : section « Exploratory probing » ci-dessous | chaque trouvaille de cet audit est devenue un essai de non-régression (voir « Findings ») |
| SEC-TEST-008 | LOW | N/A | ni argent, ni santé, ni large public : service auto-hébergé pour quelques comptes invités et les services du Hub ; aucun paiement (voir SEC-API-008) |  |

## Not applicable
| ID | Why, with proof |
|---|---|
| REQ-CRYPT-003 | bcrypt absent : `grep -rniwE "bcrypt" src ui socle/src` → 0 ; Argon2id seul |
| REQ-DATA-007 | aucun envoi de fichier ni import depuis une adresse fournie par un utilisateur : corps JSON seulement (`socle/src/http.js:122`), `grep -rniwE "multipart\|busboy\|formidable\|multer" src ui socle/src` → 0 |
| SEC-AUTH-008 | aucune connexion par fournisseur externe : `grep -rniwE "oauth\|openid\|oidc\|passport" src ui socle/src` → 0 |
| SEC-SESS-005 | aucun JWT : `grep -rniwE "jwt\|jsonwebtoken\|jose" src ui socle/src` → 0 ; sessions serveur |
| SEC-SESS-006 | aucun jeton de rafraîchissement : sessions serveur (voir SEC-SESS-005) |
| SEC-AUTHZ-005 | aucune notion de locataire : une instance sert une infrastructure ; les espaces par service sont l’autorisation objet (SEC-AUTHZ-001) ; `grep -rniwE "tenants?\|organisations?" src socle/src` → 0 |
| SEC-INJ-002 | aucun ORM : node:sqlite, requêtes préparées seulement |
| SEC-INJ-003 | aucune base documentaire : SQLite seulement ; JSON rangé en colonne texte |
| SEC-INJ-007 | aucun analyseur XML côté serveur : `grep -rniwE "xml2js\|sax\|libxml\|fast-xml\|xmldom" src socle/src` → 0 |
| SEC-XSS-002 | aucun texte riche ni Markdown rendu : réponses de l’IA, entrées et traits affichés en texte échappé (voir SEC-XSS-001) |
| SEC-XSS-007 | aucune redirection pilotée par paramètre : `curl -sI "/connexion?next=https://evil.example"` → aucun Location (annexe B.4) |
| SEC-CSRF-006 | aucune redirection pilotée par paramètre : voir SEC-XSS-007 |
| SEC-API-006 | aucun GraphQL : `grep -rniwE "graphql\|apollo" src ui socle/src` → 0 |
| SEC-API-008 | aucune opération monétaire ni crédit : `grep -rniwE "stripe\|paypal\|checkout\|invoice\|payout\|refund" src ui socle/src` → 0 |
| SEC-DB-002 | SQLite embarqué sans rôle ni identifiant : `src/db.js:27` |
| SEC-DB-008 | le navigateur ne parle jamais à la base : SQLite côté serveur seulement |
| SEC-FILE-001 | aucun envoi de fichier : corps JSON seulement (`socle/src/http.js:122`) |
| SEC-FILE-002 | aucun envoi de fichier ; corps JSON bornés (voir SEC-API-010) |
| SEC-FILE-003 | aucun fichier d’utilisateur écrit ; seules écritures : la base et les copies de rangement, nommées par le serveur |
| SEC-FILE-004 | aucun fichier d’utilisateur servi ; seuls `ui/` et `socle/web`, sous des chemins connus |
| SEC-FILE-005 | aucun fichier d’utilisateur stocké |
| SEC-FILE-006 | aucun fichier partagé entre utilisateurs |
| SEC-FILE-007 | aucune image acceptée |
| SEC-FILE-008 | aucun import par adresse : les URL lues par le serveur sont posées par l’exploitant (voir SEC-CSRF-004) |
| SEC-PAY-001 | aucun paiement : `grep -rniwE "stripe\|paypal\|checkout\|invoice\|payout\|refund" src ui socle/src` → 0 |
| SEC-PAY-002 | aucun paiement : `grep -rniwE "stripe\|paypal\|checkout\|invoice\|payout\|refund" src ui socle/src` → 0 |
| SEC-PAY-003 | aucun paiement : `grep -rniwE "stripe\|paypal\|checkout\|invoice\|payout\|refund" src ui socle/src` → 0 |
| SEC-PAY-004 | aucun paiement : `grep -rniwE "stripe\|paypal\|checkout\|invoice\|payout\|refund" src ui socle/src` → 0 |
| SEC-PAY-005 | aucun paiement : `grep -rniwE "stripe\|paypal\|checkout\|invoice\|payout\|refund" src ui socle/src` → 0 |
| SEC-NEXT-001 | Node sans cadriciel, aucune dépendance (`package.json:7`) ; `grep -rniwE "next/\|nextjs\|getServerSideProps" src ui socle/src` → 0 |
| SEC-NEXT-002 | Node sans cadriciel, aucune dépendance (`package.json:7`) ; `grep -rniwE "next/\|nextjs\|getServerSideProps" src ui socle/src` → 0 |
| SEC-NEXT-003 | Node sans cadriciel, aucune dépendance (`package.json:7`) ; `grep -rniwE "next/\|nextjs\|getServerSideProps" src ui socle/src` → 0 |
| SEC-NEXT-004 | Node sans cadriciel, aucune dépendance (`package.json:7`) ; `grep -rniwE "next/\|nextjs\|getServerSideProps" src ui socle/src` → 0 |
| SEC-NEXT-005 | Node sans cadriciel, aucune dépendance (`package.json:7`) ; `grep -rniwE "next/\|nextjs\|getServerSideProps" src ui socle/src` → 0 |
| SEC-NEXT-006 | Node sans cadriciel, aucune dépendance (`package.json:7`) ; `grep -rniwE "next/\|nextjs\|getServerSideProps" src ui socle/src` → 0 |
| SEC-NEXT-007 | Node sans cadriciel, aucune dépendance (`package.json:7`) ; `grep -rniwE "next/\|nextjs\|getServerSideProps" src ui socle/src` → 0 |
| SEC-NEXT-008 | Node sans cadriciel, aucune dépendance (`package.json:7`) ; `grep -rniwE "next/\|nextjs\|getServerSideProps" src ui socle/src` → 0 |
| SEC-NEXT-009 | Node sans cadriciel, aucune dépendance (`package.json:7`) ; `grep -rniwE "next/\|nextjs\|getServerSideProps" src ui socle/src` → 0 |
| SEC-BAAS-001 | `grep -rniwE "supabase\|firebase\|firestore" src ui socle/src` → 0 : SQLite embarqué |
| SEC-BAAS-002 | `grep -rniwE "supabase\|firebase\|firestore" src ui socle/src` → 0 : SQLite embarqué |
| SEC-BAAS-003 | `grep -rniwE "supabase\|firebase\|firestore" src ui socle/src` → 0 : SQLite embarqué |
| SEC-BAAS-004 | `grep -rniwE "supabase\|firebase\|firestore" src ui socle/src` → 0 : SQLite embarqué |
| SEC-BAAS-005 | `grep -rniwE "supabase\|firebase\|firestore" src ui socle/src` → 0 : SQLite embarqué |
| SEC-BAAS-006 | `grep -rniwE "supabase\|firebase\|firestore" src ui socle/src` → 0 : SQLite embarqué |
| SEC-BAAS-007 | `grep -rniwE "supabase\|firebase\|firestore" src ui socle/src` → 0 : SQLite embarqué |
| SEC-BAAS-008 | `grep -rniwE "supabase\|firebase\|firestore" src ui socle/src` → 0 : SQLite embarqué |
| SEC-BAAS-009 | `grep -rniwE "supabase\|firebase\|firestore" src ui socle/src` → 0 : SQLite embarqué |
| SEC-BAAS-010 | `grep -rniwE "supabase\|firebase\|firestore" src ui socle/src` → 0 : SQLite embarqué |
| SEC-BAAS-011 | `grep -rniwE "supabase\|firebase\|firestore" src ui socle/src` → 0 : SQLite embarqué |
| SEC-BE-005 | aucun Django : serveur Node seul, aucun Python dans le dépôt (`git ls-files "*.py" \| wc -l` → 0) |
| SEC-BE-006 | aucun Flask ni FastAPI : serveur Node seul, aucun Python dans le dépôt (`git ls-files "*.py" \| wc -l` → 0) |
| SEC-BE-007 | aucun Python dans le dépôt : voir SEC-BE-006 |
| SEC-BE-008 | aucun PHP : `git ls-files "*.php" \| wc -l` → 0 |
| SEC-WP-001 | application Node écrite ici : `grep -rniwE "wordpress\|wp-admin\|wp-content\|xmlrpc" src ui socle/src` → 0 |
| SEC-WP-002 | application Node écrite ici : `grep -rniwE "wordpress\|wp-admin\|wp-content\|xmlrpc" src ui socle/src` → 0 |
| SEC-WP-003 | application Node écrite ici : `grep -rniwE "wordpress\|wp-admin\|wp-content\|xmlrpc" src ui socle/src` → 0 |
| SEC-WP-004 | application Node écrite ici : `grep -rniwE "wordpress\|wp-admin\|wp-content\|xmlrpc" src ui socle/src` → 0 |
| SEC-WP-005 | application Node écrite ici : `grep -rniwE "wordpress\|wp-admin\|wp-content\|xmlrpc" src ui socle/src` → 0 |
| SEC-WP-006 | application Node écrite ici : `grep -rniwE "wordpress\|wp-admin\|wp-content\|xmlrpc" src ui socle/src` → 0 |
| SEC-WP-007 | application Node écrite ici : `grep -rniwE "wordpress\|wp-admin\|wp-content\|xmlrpc" src ui socle/src` → 0 |
| SEC-WP-008 | application Node écrite ici : `grep -rniwE "wordpress\|wp-admin\|wp-content\|xmlrpc" src ui socle/src` → 0 |
| SEC-INFRA-005 | aucun stockage objet : `grep -rniwE "s3\.\|gcs\|minio\|aws-sdk" src socle/src` → 0 |
| SEC-INFRA-006 | aucun nuage : service auto-hébergé, aucune clé IAM ni compte de fournisseur d’infrastructure (`grep -rniwE "aws\|gcp\|azure\|iam" src` → 0) |
| SEC-INFRA-009 | aucune infrastructure décrite en code : `git ls-files "*.tf" "Pulumi.yaml" \| wc -l` → 0 |
| SEC-LLM-005 | aucun outil ni agent côté SYNAPSE : le modèle reçoit un texte et rend un texte ou un JSON relu, sans appel de fonction (`grep -rniE "tool_choice\|function_call" src` → 0) ; les outils MCP sont exposés à des agents tiers et revérifient chaque appel côté serveur (SEC-API-009) |
| SEC-TEST-008 | ni argent, ni santé, ni large public : service auto-hébergé pour quelques comptes invités et les services du Hub ; aucun paiement (voir SEC-API-008) |

## Anonymity (REQ-ANON-001 to -010)
Arbre de travail : 0 occurrence de la liste d’anonymat commune, ce fichier et NO-VIBE.md compris ; les motifs de l’annexe B.1 n’y relèvent que des noms du `.gitignore`. Historique local complet (64 commits, tous les arbres, tous les messages, auteurs et validateurs) : une seule identité ; aucune mention d’outil ; aucun chemin de poste ; messages et identités sans terme de la liste. Exposition résiduelle, toute dans l’historique déjà publié (jusqu’à v1.9.5) : 10 lignes de diffs portant un terme de la liste, 94 lignes portant un terme d’installation personnelle, 30 commits datés hors UTC — retirés de l’arbre, pas de l’historique : action H12, détail dans le rapport hors dépôt. Aucun binaire image ni document dans tout l’historique. Le balayage est fait sur motifs et sur une liste finie : il ne prouve pas l’absence de ce que la liste ne nomme pas.

## Human actions required
Ce qu’aucun agent ne peut faire à la place de l’exploitant. Cette liste bloque la mise en production tant qu’elle n’est pas vide.

| # | Action | Contrôles | Étapes |
|---|---|---|---|
| H1 | Servir SYNAPSE en HTTPS | REQ-WEB-001, SEC-HDR-001, SEC-INFRA-001, SEC-TEST-005, REQ-DATA-002 | Dans le Hub : relais ou certificat de l’autorité locale pour SYNAPSE ; déclarer l’adresse du relais dans « Relais de confiance » (SOCLE_PROXYS) ; « Accès sans HTTPS » à Non ; vérifier `curl -sI https://<synapse>/ \| grep -i strict-transport-security` ; noter le résultat de testssl.sh. |
| H2 | Relais SMTP et adresses d’alerte | REQ-AUTH-014, SEC-PAY-007, SEC-LOG-004 | Réglages avancés de SYNAPSE dans le Hub : relais, port, chiffrement, identifiants, expéditeur, adresse publique ; SPF, DKIM et DMARC du domaine d’expédition ; chaque administrateur ajoute puis confirme son adresse dans Compte → Alertes. |
| H3 | GitHub | REQ-CI-001…005, GOV-003, GOV-005, SEC-INFRA-007/008, SEC-TEST-001…003, SEC-DEP-002/006/008 | Activer les Actions ; Settings → Branches : protéger `main` (pas de poussée forcée, contrôles requis : essais, secrets, identite, anonymat, analyse) ; Code security : Dependabot alerts, secret scanning et push protection, private vulnerability reporting ; 2FA sur le compte et sur chaque console de fournisseur. |
| H4 | Liste d’anonymat | REQ-ANON-003, REQ-CI-004, REQ-CI-001 | Sur le poste : gitleaks ; liste et crochet global `pre-commit` qui refuse un diff portant un terme ; sur GitHub : secret de dépôt `LISTE_ANONYMAT` (la liste commune). Vérifier qu’un commit d’essai portant un terme est refusé par le crochet, puis par la vérification. |
| H5 | Brûler les secrets vus pendant le développement | SEC-SECRETS-006 | Révoquer chez @BotFather tout jeton Telegram ayant servi ; régénérer chez son fournisseur toute clé d’IA distante utilisée en essai ; dans le Hub, régénérer le jeton de service de SYNAPSE (HUB_TOKEN) et le jeton d’administration des comptes (ADMIN_TOKEN, que portait la source « hub-admin » de la 1.x), puis redéployer ; tourner SOCLE_CLE une fois. |
| H6 | Clés restreintes, par environnement | REQ-CFG-003, SEC-SECRETS-005, GOV-004 | Une clé d’IA distante dédiée à SYNAPSE, limitée à l’inférence ; un bot Telegram dédié ; un jeu de jetons pour la VM d’essai, un autre pour la production. |
| H7 | Chiffrement des disques | REQ-DATA-002, SEC-DB-003, SEC-PRIV-005 | LUKS (ou chiffrement du stockage de l’hyperviseur) sur l’hôte qui porte le volume de SYNAPSE. |
| H8 | Sauvegardes et exercices | REQ-DATA-003, SEC-DB-006 | Paire RSA 3072 bits créée hors de la machine de SYNAPSE ; cron quotidien `docker exec -i <synapse> node src/cli.js sauvegarde < synapse-sauvegarde.pub > synapse-$(date -u +%F).sauv` ; copie hors hôte, trente jours ; restauration réelle sur la VM d’essai une fois par trimestre, datée ici. |
| H9 | Hôtes | SEC-INFRA-003 | Pare-feu (seuls les ports publiés), SSH par clé sans root, mises à jour de sécurité automatiques. |
| H10 | Disponibilité vue de l’extérieur | SEC-LOG-005 | Une sonde externe sur `/healthz`, ou décision écrite : service de réseau local seulement, sondes du Hub suffisantes. |
| H11 | Journaux centralisés | SEC-LOG-003 | Transférer les journaux du conteneur (dont le journal de sécurité) vers un collecteur hors de l’hôte. |
| H12 | Historique publié | REQ-ANON-002, REQ-ANON-008 | L’historique publié de `synapse` (jusqu’à v1.9.5) garde des termes d’identification et des fuseaux non UTC (rapport hors dépôt). Choisir : le laisser ; ou recréer le dépôt depuis l’arbre propre (supprimer l’ancien, vérifier les bifurcations, pousser l’historique réécrit) ; ou réécrire et forcer la poussée, avec ses conséquences. |
| H13 | Domaine | REQ-ANON-009, SEC-INFRA-002 | Si SYNAPSE reçoit un nom public : protection WHOIS, verrou du registraire, 2FA, enregistrement CAA. |
| H14 | Crible au déploiement | SEC-INFRA-004, SEC-TEST-003, SEC-TEST-004 | Sur la VM : `trivy image ghcr.io/codexx64/synapse:2.0.0` sans CRITICAL ni HIGH corrigeable ; `zap-baseline.py -t http://<vm>:<port>` ; résultats notés ici. |
| H15 | Sous-traitants hors UE | SEC-PRIV-006 | Si le relais SMTP ou Telegram sont retenus : accord de traitement accepté, ou choix d’un service européen ou auto-hébergé. |
| H16 | Clé maîtresse hors ligne | REQ-DATA-003, SEC-DB-006 | Garder une copie hors ligne de SOCLE_CLE, à part des sauvegardes de la base. |
| H18 | IA distante | SEC-LLM-002, SEC-LLM-006, SEC-PRIV-006 | Si une IA distante est choisie : plafond de dépense mensuel chez le fournisseur, réglage « pas d’entraînement sur les données », accord de traitement ; garder LLM_APPELS_JOUR sous ce plafond. |
| H19 | Passage à la 2.0 | — (mise en service) | Pousser la 2.0.0 puis, dans le Hub, Mettre à jour et Redéployer (SOCLE_CLE générée par le Hub) ; chaque compte repris régénère ses codes de secours (Compte → Codes de secours) ; un administrateur sans clé d’accès en inscrit une à sa première connexion. |

## Secrets inventory
| Secret | Where it lives | Scope | Rotation procedure | Last rotated |
|---|---|---|---|---|
| SOCLE_CLE (clé maîtresse) | coffre du Hub, ou `secrets/socle_cle` (installation seule), jamais dans le volume | scelle les secrets TOTP et le jeton Telegram | l’actuelle dans SOCLE_CLE_ANCIENNE, une neuve dans SOCLE_CLE, redémarrer, retirer l’ancienne ; rescellage vérifié par l’exercice du runbook | à la création |
| HUB_TOKEN (`HUB_TOKEN_SEED`) | coffre du Hub, environnement du conteneur | lecture et écriture du Hub ; clé des jetons de cerveau | régénérer dans le Hub, redéployer : l’ancien cesse de valoir (runbook, étape 3) | à la création |
| Jetons de cerveau (`cer_<nom>_…`) | calculés par le Hub, environnement de chaque service | l’espace de ce service et les espaces communs | changent avec HUB_TOKEN | à la création |
| Jetons de service créés en ligne de commande | base, par empreinte SHA-256 | une source, une portée | `node src/cli.js source rotate <nom>` : l’ancien cesse de valoir | — |
| ADMIN_TOKEN (`SOCLE_JETON_ADMIN_HUB`) | coffre du Hub | délégation des comptes au Hub (socle), rien dans l’API de SYNAPSE | régénérer dans le Hub, redéployer | à la création |
| Clé d’IA distante (`LLM_CLE`) | coffre du Hub, environnement | inférence | chez le fournisseur, puis dans le Hub, redéployer | — |
| Jeton du bot Telegram | base, scellé | envoi du bilan de rangement | @BotFather → revoke ; Paramètres → Telegram (admin, renfort) ; `node src/cli.js secrets retirer` | — |
| Identifiants SMTP (`SOCLE_SMTP_*`) | coffre du Hub | envoi des alertes de sécurité | chez le relais, puis dans le Hub | — |
| SOCLE_JETON_INSTALLATION | coffre du Hub, ou journaux du premier démarrage | premier compte seulement | sans effet une fois l’installation faite | à la création |

## Incident runbook
```bash
# 1. Détecter : Compte → Journal de sécurité (refus, verrous, jetons refusés, plafond de l'IA) ; Hub → SYNAPSE → Journaux
# 2. Fermer toutes les sessions sauf la sienne (administrateur, renfort)
curl -X POST https://<synapse>/api/compte/admin/sessions/fermer-tout -b <cookie> -H 'X-CSRF: <jeton>' -H 'Origin: https://<synapse>'
# 3. Couper les services : régénérer HUB_TOKEN dans le Hub (les jetons de cerveau changent avec lui), Redéployer ;
#    un jeton créé en ligne de commande : docker exec <synapse> node src/cli.js source rotate <nom>
# 4. Retirer le jeton Telegram, service en marche, puis le révoquer chez @BotFather ; régénérer la clé d'IA chez le fournisseur
docker exec <synapse> node src/cli.js secrets retirer
# 5. Forcer un nouveau mot de passe : Compte → Comptes → compte → Réinitialiser (lien à usage unique, 20 minutes)
# 6. Restaurer, depuis le poste qui garde la clé privée, puis remettre la base dans le volume
node src/cli.js restaurer synapse-sauvegarde.pem synapse.db < synapse-AAAA-MM-JJ.sauv
docker stop <synapse> && docker run --rm -v <volume>:/data -v "$PWD":/b busybox sh -c 'cp /b/synapse.db /data/synapse.db && rm -f /data/synapse.db-wal /data/synapse.db-shm && chown 10001:10001 /data/synapse.db && chmod 600 /data/synapse.db' && docker start <synapse>
#    Base sauvegardée avant une rotation : poser la clé d'alors dans SOCLE_CLE_ANCIENNE avant de démarrer
# 7. Vérifier la chaîne du journal : Compte → Journal de sécurité (« chaîne intacte »)
```
Qui : l’exploitant de l’instance tient chaque étape ; révoquer chez Telegram et le fournisseur d’IA ; support.github.com pour le dépôt. Communiquer : prévenir les comptes concernés ; si des données personnelles ont pu être lues (comptes, questions posées, fiche, échanges gardés en mémoire), notifier l’autorité de contrôle sous 72 heures à compter de la découverte. Joué de bout en bout le 2026-10-19 et à chaque vérification : `outils/exercice-incident.mjs`, 26 vérifications.

## Inventory
Routes publiques : `GET /healthz` (vivant, état des vecteurs), `GET /.well-known/security.txt`, `GET /api/compte/etat` et les cérémonies de connexion et d’installation du socle, les pages `/connexion` et `/compte`, les fichiers de `ui/` et `socle/web` sous leur version. Session ou jeton : 52 routes sous `/v1/` et `/mcp`, chacune avec son schéma (`src/schemas.js`) et balayée contre la table des droits (`test/balayage.test.mjs`) ; pages `/` et `/parametres` (session complète).

Données : `synapse.db` (comptes, sessions, jetons hachés, journal chaîné du socle ; mémoire — entrées, liens, vecteurs, neurones, incidents ; fiche de traits ; questions posées ; réglages au jeton Telegram scellé — sensibilité : personnelle et opérationnelle), copies de rangement (cinq), volume `/data` en 0700, base en 0600.

Tiers (chez l’exploitant sauf mention) : le Hub et les services qu’il relie (VIGIE, MapMyLAN, NEXARC, ESSAIM…), Ollama, l’agrégateur d’état ; en option, chez des fournisseurs : IA distante compatible OpenAI (Kimi, OpenAI…), Telegram, relais SMTP.

## Appendix B sweep
Relancé à chaque génération de ce fichier (bash, LC_ALL=C.UTF-8), deux fois de suite, sorties identiques ; B.5 est dans NO-VIBE.md.

| # | Commande | Résultat | Justification |
|---|---|---|---|
| B.1.1 | `git log --all --format='%an <%ae>' \| sort -u` | `CodexX64 <CodexX64@users.noreply.github.com>` | le pseudonyme seul |
| B.1.2 | `git log --all --format='%cn <%ce>' \| sort -u` | `CodexX64 <CodexX64@users.noreply.github.com>` | le pseudonyme seul |
| B.1.3 | `git log --all --format='%B' \| rg -in 'co-authored-by\|generated (by\|with)\|assistant\|as an ai' \| wc -l` | `0` |  |
| B.1.4 | `find . -path ./node_modules -prune -o \( -name .ai -o -name .cursor -o -name .aider -o -name .continue -o -name .windsurfrules \) -print \| wc -l` | `0` |  |
| B.1.5 | `find . -path ./node_modules -prune -o -regextype posix-extended -regex '.*/(CLAUDE\|AGENTS?\|PROMPTS?\|GEMINI)\.md' -print \| wc -l` | `0` |  |
| B.1.6 | `git log --all --name-only --format= \| sort -u \| rg -i '(^\|/)(CLAUDE\|AGENTS?\|PROMPTS?\|GEMINI)\.md$\|copilot-instructions\|\.cursor\|\.aider' \| wc -l` | `0` |  |
| B.1.7 | `rg -n 'copilot-instructions' . -g '!SECURITY.md' -g '!NO-VIBE.md' -g '!ui/vendor/**' \| wc -l` | `0` |  |
| B.1.8 | `git grep -nIiE '/Users/\|/home/[a-z]\|C:\\\\\\\\Users\|\.local\b\|\.lan\b\|10\.[0-9]+\.\|192\.168\.\|172\.(1[6-9]\|2[0-9]\|3[01])\.' -- . ':!SECURITY.md' ':!NO-VIBE.md'` | `.gitignore:11:.env.local` | le nom `.env.local` du `.gitignore` ; aucune adresse ni chemin réel |
| B.1.9 | `git log --all -p -- . ':!SECURITY.md' ':!NO-VIBE.md'` filtré par le motif « infrastructure personnelle » de l’annexe B.1, compté | `94` | historique déjà publié : des termes d’installation personnelle, retirés de l’arbre par `d7a2726` et `b1162f2` (les commits de la 2.0 n’en portent que dans des lignes retirées) ; exposition résiduelle → H12, détail hors dépôt |
| B.1.9b | `git log --all -p -- . ':!SECURITY.md' ':!NO-VIBE.md'` filtré par le motif « infrastructure personnelle » de l’annexe B.1, compté par terme | 6 termes | les mêmes lignes, par terme (termes gardés hors dépôt) ; aucun dans l’arbre (B.1.8, B.1.16) |
| B.1.10 | `git log --all --format='%aI' \| rg -v '\+00:00' \| wc -l` | `30` | commits de l’historique publié (jusqu’à v1.9.5) datés dans un fuseau non UTC ; tous les commits de la 2.0 en UTC → H12 |
| B.1.11 | `git log --all --format='%cI' \| rg -v '\+00:00' \| wc -l` | `30` | idem pour le validateur |
| B.1.12 | `git grep` de tout l’historique (`$(git rev-list --all)`) avec le motif des chemins de poste et d’espaces de travail d’outils (gardé hors dépôt), lignes distinctes comptées | `0` |  |
| B.1.13 | `git log --all --name-only --format= \| sort -u \| rg -i '\.(png\|jpe?g\|pdf\|mp4\|gif\|webp\|ico)$' \| wc -l` | `0` |  |
| B.1.14 | `git log --all -p -- . ':!SECURITY.md' ':!NO-VIBE.md'` filtré par la liste d’anonymat (gardée hors dépôt), compté | `10` | lignes de diffs de l’historique publié portant un terme de la liste propre à ce dépôt (hors dépôt) ; aucune dans l’arbre ; les commits de la 2.0 n’en portent que dans des lignes retirées → H12 |
| B.1.15 | `git log --all --format='%B%n%an%n%ae%n%cn%n%ce'` filtré par la liste d’anonymat (gardée hors dépôt), compté | `0` |  |
| B.1.16 | `git grep -- . ':!SECURITY.md' ':!NO-VIBE.md' \| wc -l` filtré par la liste d’anonymat (gardée hors dépôt), compté | `0` |  |
| B.2.1 | `gitleaks git --no-banner --redact . 2>&1 \| tail -1 \| sed -E 's/^.*(no leaks found\|leaks found: [0-9]+).*$/\\1/'` | `no leaks found` | tout l’historique, toutes références |
| B.2.2 | `gitleaks dir --no-banner --redact . 2>&1 \| tail -1 \| sed -E 's/^.*(no leaks found\|leaks found: [0-9]+).*$/\\1/'` | `no leaks found` | arbre de travail |
| B.2.3 | `git grep -nIiE '(api[_-]?key\|secret\|token\|password\|bearer)\s*[=:]\s*[\"'\''][^\"'\'']{8,}' -- . ':!SECURITY.md' ':!NO-VIBE.md'` | 3 lignes | le vecteur publié de la RFC 6238 et un secret TOTP fabriqué dans des essais, un jeton Telegram volontairement invalide dans un essai de refus ; aucun secret réel |
| B.2.4 | `git grep -nI -e '-----BEGIN (RSA\|EC\|OPENSSH\|PGP) PRIVATE' -- . ':!SECURITY.md' ':!NO-VIBE.md' \| wc -l` | `0` |  |
| B.2.5 | `rg -ni 'sk_live\|service_role\|xox[baprs]-\|-----BEGIN' ui socle/web \| wc -l` | `0` |  |
| B.2.x | `git log --all -p -- . ':!SECURITY.md' ':!NO-VIBE.md' \| rg -n 'sk-ant-\|sk_live_\|AKIA[0-9A-Z]{16}\|ghp_[A-Za-z0-9]{30}\|xox[bp]-\|-----BEGIN [A-Z]* ?PRIVATE' \| wc -l` | `0` |  |
| B.3.1 | `rg -n 'dangerouslySetInnerHTML\|innerHTML *=\|outerHTML *=\|document\.write' . -g '!SECURITY.md' -g '!NO-VIBE.md' -g '!ui/vendor/**'` | 25 lignes | chaque `innerHTML` de `ui/` relu le 2026-10-19 : tout texte venu de la mémoire, d’un service ou du modèle passe par `esc()` ; seuls des nombres et des étiquettes fixes sont insérés tels quels (SEC-XSS-001) |
| B.3.2 | `rg -n 'eval\(\|new Function\(\|execSync\|child_process\|os\.system\|subprocess.*shell=True' . -g '!SECURITY.md' -g '!NO-VIBE.md' -g '!ui/vendor/**'` | 5 lignes | les essais et l’exercice du runbook lancent le serveur comme en production ; aucun processus lancé par `src/` |
| B.3.3 | `rg -n '[^.]\bexec\(' . -g '!SECURITY.md' -g '!NO-VIBE.md' -g '!ui/vendor/**' \| wc -l` | `0` |  |
| B.3.4 | `rg -n 'f\"SELECT\|\"SELECT .*\" *\+\|\\$\{.*\} *FROM\|\.raw\(\|query\(.*\+ *req\.' . -g '!SECURITY.md' -g '!NO-VIBE.md' -g '!ui/vendor/**' \| wc -l` | `9` | noms de colonnes écrits dans le code (`cols`, `COLS`) et listes de `?` ; chaque valeur passe en paramètre (relu le 2026-10-19) |
| B.3.5 | `rg -n 'Math\.random\|uuidv1\|new Random\(\)' . -g '!SECURITY.md' -g '!NO-VIBE.md' -g '!ui/vendor/**' \| wc -l` | `7` | `Math.random` de l’animation de la vue 3D (`ui/index.html`) ; jamais un secret ni un identifiant |
| B.3.6 | `rg -n 'verify *= *False\|rejectUnauthorized: *false\|InsecureSkipVerify' . -g '!SECURITY.md' -g '!NO-VIBE.md' -g '!ui/vendor/**'` | `(vide)` |  |
| B.3.7 | `rg -n 'jwt\.decode\(\|algorithms: *\[.*none\|verify: *false' . -g '!SECURITY.md' -g '!NO-VIBE.md' -g '!ui/vendor/**' \| wc -l` | `0` |  |
| B.2.6 | `curl -s -o /dev/null -w '%{http_code}' http://localhost:18241/.env` | `404` | aucun fichier caché servi |
| B.4.1 | `curl -sI http://localhost:18241/ \| rg -i 'content-security\|x-content-type\|referrer-policy\|permissions-policy\|x-frame\|cross-origin' \| wc -l` | `7` | CSP, nosniff, Referrer-Policy, Permissions-Policy, X-Frame-Options, COOP/CORP |
| B.4.2 | `curl -sI http://localhost:18241/ \| rg -i '^(server\|x-powered-by\|x-aspnet\|x-generator)' \| wc -l` | `0` |  |
| B.4.3 | `curl -sI -H 'Origin: https://evil.example' http://localhost:18241/v1/stats \| rg -i access-control \| wc -l` | `0` |  |
| B.4.4 | `curl -sI 'http://localhost:18241/connexion?next=https://evil.example' \| rg -i '^location' \| wc -l` | `0` |  |
| B.4.5 | `curl -s -o /dev/null -w '%{http_code}' http://localhost:18241/.git/config` | `404` |  |
| B.4.5b | `curl -s -o /dev/null -w '%{http_code}' http://localhost:18241/v/x/../.git/config; echo; curl -s -o /dev/null -w '%{http_code}' 'http://localhost:18241/v/2.0.0/%2e%2e/src/config.js'` | 2 lignes | aucun chemin ne sort de `ui/` |
| B.4.6 | `curl -s -o /dev/null -w %{http_code} http://localhost:18241/v1/sources` | `401` | sans identité |
| B.4.7 | `for i in $(seq 1 30); do curl -s -o /dev/null -w '%{http_code} ' -X POST http://localhost:18241/api/compte/connexion -H 'Content-Type: application/json' -H 'Origin: http://localhost:18241' -d '{\"identifiant\":\"quelquun\",\"motDePasse\":\"mauvais mot de passe\"}'; done \| tr ' ' '\n' \| sort \| uniq -c \| tr '\n' ' '` | `3 401      27 428` | le limiteur du socle exige une preuve de travail (428) dès le quatrième échec ; la seconde passe la trouve exigée d’emblée : le compteur persiste |
| B.4.8 | `for i in $(seq 1 25); do curl -s -o /dev/null -w '%{http_code} ' -H 'Authorization: Bearer jeton-invente-0000000000000000000' http://localhost:18241/v1/stats; done \| tr ' ' '\n' \| sort \| uniq -c \| tr '\n' ' '` | `10 401      15 429` | le limiteur persistant coupe l’adresse au dixième jeton faux ; la seconde passe la trouve coupée d’emblée |

## Exploratory probing (SEC-TEST-007)
Sondage exploratoire du 2026-10-19, rejoué à chaque génération de ce fichier sur une instance neuve (vrais comptes de chaque rôle, vrai jeton du Hub, vrais jetons de cerveau) : 27 cas d’abus tentés, chacun avec la réponse obtenue et celle qu’exige la règle ; un seul écart arrête la génération.

| # | Cas d’abus | Tenté | Obtenu | Attendu |
|---|---|---|---|---|
| P1 | anonyme sur la mémoire | `GET /v1/search?q=x` | 401 | 401 |
| P2 | jeton faux avec un cookie de session valide | `GET /v1/stats` + cookie admin + Bearer faux | 401 | 401 |
| P3 | service qui lit l’espace d’un autre | `GET /v1/entry?id=<note privée de mapmylan>` (vigie) | 404 | 404 |
| P4 | service qui écrit dans l’espace d’un autre | `POST /v1/ingest {ns: agent:mapmylan}` (vigie) | 403 | 403 |
| P5 | service qui signe à la place d’un autre | `POST /v1/brief {agent: mapmylan}` (vigie) | 403 | 403 |
| P6 | service qui se fait passer pour le Hub | `POST /v1/ingest {source: hub}` (vigie) → source enregistrée | vigie | vigie |
| P7 | service qui règle Telegram | `POST /v1/rangement/config` (Hub) | 403 | 403 |
| P8 | service qui exporte toute la mémoire | `GET /v1/export` (Hub) | 403 | 403 |
| P9 | lecture seule qui lance un rangement | `POST /v1/rangement/lancer` (lecture) | 403 | 403 |
| P10 | membre qui règle Telegram | `POST /v1/rangement/config` (membre) | 403 | 403 |
| P11 | session humaine qui écrit dans la mémoire | `POST /v1/ingest` (admin) | 403 | 403 |
| P12 | écriture de session sans jeton anti-CSRF | `PUT /v1/moi/trait` sans X-CSRF (membre) | 403 | 403 |
| P13 | écriture de session depuis une autre origine | `PUT /v1/moi/trait`, Origin evil.example (membre) | 403 | 403 |
| P14 | champ inconnu (affectation de masse) | `POST /v1/ingest {…, role: admin}` (Hub) | 400 | 400 |
| P15 | prototype pollué | `POST /v1/ingest {meta: {__proto__: …}}` (Hub) | 400 | 400 |
| P16 | paramètre répété | `GET /v1/search?q=a&q=b` (Hub) | 400 | 400 |
| P17 | taille de page absurde | `GET /v1/neurons?limit=100000` (Hub) | 400 | 400 |
| P18 | corps géant annoncé | `POST /v1/link`, Content-Length 50 Mo | 413 | 413 |
| P19 | écriture sans JSON (formulaire d’un autre site) | `POST /v1/link`, text/plain (Hub) | 415 | 415 |
| P20 | méthode inattendue | `TRACE /v1/neuron` (Hub) | 405 | 405 |
| P21 | route de débogage | `GET /debug`, `/v1/debug`, `/.env` | 404 404 404 | 404 404 404 |
| P22 | secret dans les réglages | `GET /v1/rangement/etat` (admin) : jeton Telegram | …BBBB | …BBBB |
| P23 | secret au repos | base relue en brut : jeton Telegram | v1. | v1. |
| P24 | erreur interne détaillée | `GET /v1/entry?id=abc` (Hub) | 400 sans pile | 400 sans pile |
| P25 | injection SQL dans la recherche | `GET /v1/search?q=') OR 1=1 --` (vigie) | 200 rien d’un autre | 200 rien d’un autre |
| P26 | MCP : lien vers l’espace d’un autre | `tools/call memory_link` (vigie) | refusé | refusé |
| P27 | jetons inventés en rafale | douze `GET /v1/stats`, jetons faux | bloqué (429) | bloqué (429) |

Suivi du 2026-10-30 (3.7.2) : logo. SYNAPSE prend son logo : icône d'onglet (`ui/icone.svg`, liée par chaque page), tracé en ligne dans l'en-tête, l'écran de chargement et les paramètres (balisage statique des pages, aucune donnée), et marque de la porte du socle (`ui/logo.js`, tracé posé par createElementNS). Fichier SVG nettoyé : ni métadonnées, ni commentaire. Aucun contrôle ne change de statut. Essais : 194 (service et socle). Parcours du navigateur : 112 écrans × largeurs, 0 erreur de console ; les 33 écrans signalés le sont déjà en 3.7.1, à l'identique (aucun ajouté par ce changement).

Suivi du 2026-10-30 (3.7.3) : logos. Le logo complet (marque et nom) et la marque seule sont tracés dans la page par createElementNS, en couleur du texte (`ui/logo.js:5`) ; aucun balisage injecté, aucune donnée. L'icône de l'onglet reprend le fichier favicon du dossier Logo, nettoyé (ni métadonnées, ni commentaire). Aucun contrôle ne change de statut. Essais et parcours du navigateur repassés.
