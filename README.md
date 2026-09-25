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

Premier démarrage : l'interface propose un compte temporaire à
remplacer immédiatement par le tien, avec un second facteur.

## Interfaces

| Chemin | Ce qu'on y fait |
|---|---|
| `/` | vue 3D de la mémoire, questions, activité mesurée et apprentissage |
| `/parametres` | rangement, plages horaires, notifications |
| `/setup` | premier démarrage, ou second facteur d'un compte créé depuis le Hub |

## API

```
GET  /v1/search?q=…&ns=…     recherche
GET  /v1/answer?q=…          recherche + synthèse
POST /v1/ingest              écrire une entrée
POST /v1/recall              retrouver une résolution passée
POST /v1/neurons             enregistrer une résolution
GET  /v1/graph               le graphe
GET  /v1/stats               compteurs

GET    /v1/cerveaux              l'annuaire des cerveaux (les IA des services)
PUT    /v1/cerveaux/moi          poser sa fiche : titre, périmètre, sujets, actions, règles, adresse
PUT    /v1/cerveaux/moi/etat     poser son état du moment (court résumé)
POST   /v1/cerveaux/orienter     « qui sait ça ? » — et, pour une action, qui a le droit de la faire
```

## Les cerveaux

SYNAPSE est le cerveau du homelab ; chaque service qui a son IA y a un
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
natif de Node 22 et rien d'autre.

**Les vecteurs tiennent dans un tableau contigu.** Le niveau 2 lisait
une ligne SQLite et allouait un `Float32Array` par morceau à chaque
requête. Un index en mémoire, périmé sur un compteur, remplace ça par
une seule `Float32Array` ; un majorant de Cauchy-Schwarz permet
d'abandonner un candidat après un quart de la boucle. Résultat : environ
quatre fois plus rapide sur vingt mille morceaux, au même classement
près — le test le vérifie contre l'ancienne boucle.

**Un fichier par interface.** HTML, CSS et JavaScript ensemble. Pas
d'empaquetage : ce qu'on lit est ce qui s'exécute.

**Authentification dès le premier écran.** Mot de passe scrypt, TOTP,
clés d'accès WebAuthn. Pas de mode « on verra plus tard ».

**Les secrets ne sortent jamais.** Le QR code TOTP n'est pas généré par
un service distant — l'URL `otpauth://` contient le secret, l'envoyer
ailleurs reviendrait à le confier à un tiers.

## Configuration

Tout est dans `.env.example`. Les valeurs qui comptent :

```
OLLAMA_URL       hôte des embeddings et de la synthèse
EMBED_MODEL      modèle de vectorisation
ANSWER_MODEL     modèle de synthèse
AUTH_ORIGIN      origine attendue pour WebAuthn
CORS_ORIGIN      origines autorisées
```

## Licence

MIT — voir `LICENSE`.

---

Codex64 · [github.com/CodexX64](https://github.com/CodexX64)
