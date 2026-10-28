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
mkdir -p secrets && openssl rand -base64 32 > secrets/socle_cle && : > secrets/socle_cle_ancienne
sudo chown 10001:10001 secrets/socle_cle secrets/socle_cle_ancienne && sudo chmod 400 secrets/socle_cle secrets/socle_cle_ancienne
docker compose up -d --build
```

La clé maîtresse (`secrets/socle_cle`) scelle les secrets TOTP et le jeton
Telegram : elle vit hors du volume de données, et une copie hors ligne en est
gardée à part des sauvegardes — sans elle, une sauvegarde de la base ne rouvre
pas ce qu'elle scelle. Pour la tourner : l'actuelle dans
`secrets/socle_cle_ancienne`, une neuve dans `secrets/socle_cle`, redémarrer,
puis vider `secrets/socle_cle_ancienne` quand le journal le demande.
Une installation seule plus ancienne a vu sa clé naître sur le volume : la
reprendre au lieu d'en tirer une neuve (SYNAPSE la retire alors du volume) :
`docker run --rm -v synapse-data:/data alpine cat /data/cles/socle.key > secrets/socle_cle`.

Premier démarrage : aucun compte par défaut. Installé par le Hub, le
premier compte se crée depuis le Hub (Comptes des services) ; seul, SYNAPSE
écrit un jeton d'installation dans ses journaux, à coller sur `/connexion`
(ou `SOCLE_JETON_INSTALLATION` dans `.env`).

## Interfaces

| Chemin | Ce qu'on y fait |
|---|---|
| `/` | vue 3D de la mémoire, questions, activité mesurée et apprentissage |
| `/cerveaux` | la hiérarchie des cerveaux : constellation en direct, arbre des domaines, fiche et tamis de chaque cerveau, projets partagés, comptes et jetons |
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

## La hiérarchie des cerveaux (3.0)

Chaque compte a un arbre : un cerveau par IA ou par service (cerveau
membre), des domaines libres et imbricables (IA, HomeLab, Connaissance/Réseau…)
qui ont chacun leur cerveau commun, et un cerveau global au sommet. Une
entrée est écrite une fois ; l'arbre dit où elle est présente.

À l'écriture, l'entrée reçoit ses étiquettes (importance de 0 à 100, clés
d'entité : IP, VLAN, VM, port, hôte, service, référence) puis passe le tamis
de chaque niveau :

- elle **monte** si une étiquette la force (`securite`, `decision` par
  défaut) ou si son importance passe le seuil du cerveau (70 au commun ; le
  global ne reçoit que ce qu'on force) ; `simulation` ne monte jamais ;
- si **deux enfants distincts** ont parlé de la même clé, le cerveau fait
  une **fiche commune** qui cite chacun (lien `consolide`) ; au global, deux
  domaines sur la même clé donnent une **fiche de corrélation** (lien `correle`) ;
- une remontée peut être automatique, à valider par une personne, ou coupée.

Une IA lit son propre cerveau et seulement les fiches des cerveaux
au-dessus : jamais le cerveau brut d'une autre IA. Exception voulue : dans
un **projet partagé** ouvert, ses membres lisent chez les autres les entrées
étiquetées `projet:<nom>`.

**Un ou plusieurs comptes**, au choix (`PUT /v1/hierarchie/mode`). En mode
plusieurs, chacun a son arbre, un compte commun porte l'arbre partagé, et
chacun choisit les domaines qu'il y verse. Le premier compte garde l'arbre
d'avant. Un service sans compte écrit au commun ; un **jeton de compte**
(`cpt_…`) fait écrire une IA dans l'arbre de la personne qui l'a créé.

```
GET  /v1/hierarchie                      l'arbre (noms et compteurs, jamais de contenu)
GET  /v1/hierarchie/chercher?cerveau=&q= cherche dans un cerveau, monte jusqu'au global si rien
POST /v1/hierarchie/domaines             { chemin: "Connaissance/Réseau" }
PUT  /v1/hierarchie/reglages             seuil, convergence, remontee, toujours, jamais, fenetre_jours
PUT  /v1/hierarchie/rattacher            déplacer un cerveau membre vers un autre domaine
GET  /v1/hierarchie/remontees            journal et file « à valider »
POST /v1/hierarchie/valider              accepter ou refuser une remontée
GET|POST /v1/hierarchie/projets          projets partagés ; /projets/clore
PUT  /v1/hierarchie/versements           verser un domaine racine au compte commun
PUT  /v1/hierarchie/mode                 un | plusieurs (admin, renfort)
POST /v1/hierarchie/jetons               jeton de compte, montré une fois (renfort)
```

Un envoi peut nommer son domaine (`domaine`), son importance (`importance`)
et ses entités (`entites`). Au premier démarrage en 3.0, les entrées
existantes sont rangées une fois, comme si leur source venait de les écrire.

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
jeton refusé ne retombe jamais sur une session, il est journalisé et compté
pour l'adresse dans le limiteur persistant du socle (dix échecs la bloquent
une minute, vingt un quart d'heure, cinquante une heure).

**Chaque route a son schéma.** Corps et paramètres de requête sont validés
avant usage (`src/schemas.js`) : champ inconnu, type ou longueur hors bornes,
paramètre répété → 400. Le corps est borné avant lecture : 64 Kio par
défaut, `MAX_BODY` (2 Mo) pour l'ingestion, l'import et MCP → 413 au-delà.

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
