# SYNAPSE

Mémoire consultable pour agents et humains. Un service Node.js sans
dépendance, une base SQLite, une recherche en cascade, et une interface
3D pour voir ce que la mémoire contient.

---

## Ce que c'est

SYNAPSE répond à une question simple : **qu'est-ce qu'on sait déjà ?**

Un agent qui s'apprête à diagnostiquer un incident, un humain qui cherche
une décision prise il y a six mois, un assistant qui doit se conformer à
un standard maison — tous posent la même question, et tous se la posent
en repartant de zéro faute d'un endroit où regarder.

Ce n'est pas un moteur de recherche : c'est une mémoire qui dit quand
elle ne sait pas.

## Comment ça marche

**Recherche en cascade.** Quatre niveaux, du moins cher au plus cher.
Un mot-clé exact s'arrête au niveau 0 en quelques millisecondes. Une
question ouverte descend jusqu'à la synthèse par un modèle. La plupart
des requêtes n'atteignent jamais le dernier étage — c'est le but.

| Niveau | Méthode | Coût |
|---|---|---|
| L0 | correspondance exacte, alias | ~1 ms |
| L1 | BM25 lexical | ~15 ms |
| L2 | vecteurs, similarité cosinus | ~200 ms |
| L3 | synthèse par un modèle local | 2 à 4 s |

**Espaces étanches.** Chaque espace a ses entrées et ses clés. Une
source qui écrit dans l'un ne voit pas l'autre. Un standard partagé et
des données d'exploitation ne se mélangent pas.

**Mémoire opérationnelle.** Un incident résolu s'enregistre avec son
symptôme, sa cause et son correctif. Le suivant qui ressemble assez
retrouve la résolution sans rien recalculer.

**Elle dit quand elle ne sait pas.** Une source silencieuse est
signalée, pas ignorée. Une relation qui n'est écrite nulle part n'est
pas inférée. Un résultat vide est un résultat, pas une erreur.

**Elle apprend de qui lui parle.** Les échanges d'un assistant entrent
comme n'importe quelle entrée ; une passe de fond les relit et en
distille des traits courts et durables — la façon de nommer les choses,
les choix déjà faits, ce qui a été corrigé. C'est la différence entre un
historique et un apprentissage : l'un grossit, l'autre se condense. Un
trait qui n'est plus reconfirmé s'efface tout seul.

**Deux portées, jamais mélangées.** Ce qui est vrai de l'utilisateur est
commun à tous les modèles — un fait ne change pas parce qu'on change de
modèle. Ce qui est vrai d'un modèle — ses angles morts, ses corrections —
lui reste propre : ce qui rattrape l'un déroute l'autre.

## Démarrage

```bash
cp .env.example .env
docker compose up -d --build
```

Premier démarrage : aucun compte par défaut. Installé par le Hub, le
premier compte se crée depuis le Hub (Comptes des services) ; seul, SYNAPSE
écrit un jeton d'installation dans ses journaux, à coller sur `/connexion`
(ou `SOCLE_JETON_INSTALLATION` dans `.env`).

## Interfaces

| Chemin | Ce qu'on y fait |
|---|---|
| `/` | vue 3D de la mémoire, questions, activité mesurée et apprentissage |
| `/parametres` | rangement, plages horaires, notifications |
| `/connexion` | la porte du socle commun : installation, connexion, facteurs à inscrire |
| `/compte` | moyens de connexion, sessions, alertes, export et suppression de ses données ; comptes, politique et journal pour un administrateur |

## API

```
GET  /v1/search?q=…&ns=…     recherche
GET  /v1/answer?q=…          recherche + synthèse
POST /v1/ingest              écrire une entrée
POST /v1/recall              retrouver une résolution passée
POST /v1/neurons             enregistrer une résolution
GET  /v1/graph               le graphe
GET  /v1/stats               compteurs
GET  /v1/stats?scope=sources qui écrit, combien, quels types (noms et comptes, jamais un contenu)

GET    /v1/cerveaux              l'annuaire des cerveaux (les IA des services)
PUT    /v1/cerveaux/moi          poser sa fiche : titre, périmètre, sujets, actions, règles, adresse
PUT    /v1/cerveaux/moi/etat     poser son état du moment (court résumé)
POST   /v1/cerveaux/orienter     « qui sait ça ? » — et, pour une action, qui a le droit de la faire
```

## Les cerveaux

SYNAPSE est le cerveau de l'infrastructure ; chaque service qui a son IA y a un
mini-cerveau. Sa fiche dit ce qu'il sait et ce qu'il fait ; son état dit
où il en est ; ses échanges et ses corrections, qui passaient déjà par
`/v1/echange` et `/v1/apprendre`, font ses traits appris.

Le brief (`/v1/brief`) renvoie en plus les **autres** cerveaux concernés
par la question, avec leur état : une IA qui ne sait pas répondre sait au
moins qui sait. Une action hors de son périmètre (« crée des workflows »
depuis MapMyLAN) est renvoyée à son propriétaire — un cerveau n'en pilote
jamais un autre.

Un service installé par le Hub reçoit un jeton de cerveau dérivé du jeton
du Hub (`cer_<nom>_<hmac>`) : il ne vaut que pour ce nom, n'écrit que sa
propre fiche, et changer le jeton du Hub les révoque tous.

Serveur MCP sur `/mcp` pour les agents qui parlent ce protocole.

## Hub

`hub.json` décrit le service pour le Hub centralisé : capacités,
actions, sondes, permissions. L'installation crée le jeton de service et
le passe par `HUB_TOKEN_SEED` — aucune commande à taper dans le
conteneur après coup.

## Choix techniques

**Aucune dépendance.** Pas de `node_modules`, pas de chaîne de
construction, pas de dépendance transitive à auditer. Le module `sqlite`
natif de Node 24 et le socle commun des services Codex64, embarqué avec
ses essais et vérifié par ses empreintes. Le code de tiers servi à
l'interface (three.js r128, deux polices OFL) est figé dans `ui/vendor`,
avec sa provenance et ses empreintes : aucun CDN, rien ne sort du réseau.

**Les vecteurs tiennent dans un tableau contigu.** Le niveau 2 lisait
une ligne SQLite et allouait un `Float32Array` par morceau à chaque
requête. Un index en mémoire, périmé sur un compteur, remplace ça par
une seule `Float32Array` ; un majorant de Cauchy-Schwarz permet
d'abandonner un candidat après un quart de la boucle. Résultat : environ
quatre fois plus rapide sur vingt mille morceaux, au même classement
près — le test le vérifie contre l'ancienne boucle.

**Un fichier par interface.** HTML, CSS et JavaScript ensemble. Pas
d'empaquetage : ce qu'on lit est ce qui s'exécute. Chaque script porte le
nonce de la politique de contenu, renouvelé à chaque page.

**Les comptes humains passent par le socle commun.** Quatre facteurs
cumulables (mot de passe Argon2id, application TOTP, clés d'accès, codes de
secours), politique par facteur, sessions listées et révocables, renfort
pour ce qui détruit ou touche un secret, jeton anti-CSRF sur toute
écriture, alertes de sécurité, journal chaîné. Les comptes de la 1.x sont
repris au premier démarrage (mot de passe, application, clés d'accès) ;
leurs codes de secours sont à régénérer. Rôles : `lecture` lit la
mémoire ; `membre` corrige la fiche et lance le rangement ; `admin` règle
Telegram et gère les comptes. Une session humaine n'écrit jamais dans la
mémoire : c'est l'affaire des services, par leur jeton.

**Les services présentent un jeton.** Seule son empreinte est gardée ; un
jeton refusé ne retombe jamais sur une session, il est compté (vingt par
minute et par adresse, puis refus) et journalisé.

**Les secrets ne sortent jamais.** Le jeton Telegram est scellé (AES-256-GCM
sous `SOCLE_CLE`) et l'API n'en montre que la fin. Le QR code TOTP est
fabriqué dans le navigateur, jamais par un service distant.

## Sauvegarde et incident

```bash
# sauvegarde chiffrée pour une clé publique dont la clé privée vit ailleurs
docker exec -i synapse node src/cli.js sauvegarde < sauvegarde.pub > synapse.sauv
# restauration, sur la machine qui garde la clé privée
node src/cli.js restaurer prive.pem synapse.db < synapse.sauv
# runbook : oublier le jeton Telegram (le révoquer aussi chez @BotFather)
docker exec synapse node src/cli.js secrets retirer
```

Chaque geste en ligne de commande est inscrit au journal de sécurité.

## Configuration

Tout est dans `.env.example`. Les valeurs qui comptent :

```
OLLAMA_URL       hôte des embeddings et de la synthèse
EMBED_MODEL      modèle de vectorisation
ANSWER_MODEL     modèle de synthèse
SOCLE_CLE        clé maîtresse du coffre (secrets TOTP, jeton Telegram)
SOCLE_URL_PUBLIQUE  adresse https:// de SYNAPSE (liens des courriels et de Telegram)
CORS_ORIGIN      origine autorisée à appeler l'API avec un jeton (vide : aucune)
```

## Licence

MIT — voir `LICENSE`.

---

Codex64 · [github.com/CodexX64](https://github.com/CodexX64)
