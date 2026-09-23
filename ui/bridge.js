/* ============================================================
   Pont entre le prévisuel 3D et le vrai SYNAPSE.

   Chargement SYNCHRONE, volontairement.

   La scène se construit à la ligne qui suit (`const nodes = N.map…`).
   Un fetch asynchrone rendrait la main trop tard : la scène serait
   déjà bâtie sur le corpus de repli, et les vraies données
   arriveraient dans le vide. Il faudrait alors reconstruire toute
   la géométrie après coup — bien plus lourd que ces trente lignes.

   XMLHttpRequest synchrone est déconseillé en général, parce qu'il
   fige l'interface. Ici c'est au tout début du chargement d'une page
   dédiée, avec un délai plafonné : c'est précisément le cas où il
   reste légitime.

   Le corpus intégré n'est pas supprimé, il devient un REPLI :
     · le fichier reste ouvrable seul, sans backend ;
     · une base vide donnerait une scène vide, qui ressemble à une
       panne alors que tout fonctionne ;
     · si l'API ne répond pas, mieux vaut une scène de démonstration
       qu'un écran noir.

   Le bandeau dit toujours quelle source est affichée.
   ============================================================ */
(function () {
  'use strict';

  var API   = window.SYNAPSE_API   || '';
  var TOKEN = window.SYNAPSE_TOKEN || '';
  var NS    = window.SYNAPSE_NS    || 'shared';
  var MIN   = 8;   /* en dessous, la scène 3D n'a pas de forme lisible */

  function badge(texte, couleur) {
    function poser() {
      var el = document.createElement('div');
      el.textContent = texte;
      el.style.cssText =
        'position:fixed;top:8px;right:10px;z-index:9999;padding:4px 10px;' +
        'font:600 10px/1.4 ui-monospace,monospace;letter-spacing:.12em;' +
        'border:1px solid ' + couleur + '55;border-radius:5px;' +
        'color:' + couleur + ';background:#0a0a0acc';
      document.body.appendChild(el);
    }
    if (document.body) poser();
    else document.addEventListener('DOMContentLoaded', poser);
  }

  window.SYNAPSE_LIVE = false;

  try {
    var x = new XMLHttpRequest();
    x.open('GET', API + '/v1/graph?ns=' + encodeURIComponent(NS) + '&limit=1400', false);
    if (TOKEN) x.setRequestHeader('Authorization', 'Bearer ' + TOKEN);
    x.withCredentials = true;
    x.send(null);

    if (x.status !== 200) throw new Error('HTTP ' + x.status);
    var g = JSON.parse(x.responseText);

    if (!g.nodes || g.nodes.length < MIN) {
      badge('DÉMO · base presque vide (' + (g.total || 0) + ')', '#ffb45e');
    } else {
      /* format attendu par la scène : ['id','type','nom',{détails}] */
      window.N = g.nodes.map(function (n) { return [n.id, n.type, n.name, n.d || {}]; });
      window.E = g.edges.map(function (e) { return [e[0], e[1], e[2]]; });

      /* L'arbre groupe par type : le reconstruire à l'identique, sinon
         la disposition perd ses branches. */
      var parType = {};
      window.N.forEach(function (n) {
        (parType[n[1]] = parType[n[1]] || []).push(n[0]);
      });
      window.TREE = {
        name: 'noyau',
        children: Object.keys(parType).sort().map(function (t) {
          return { name: t, leaves: parType[t] };
        })
      };

      window.SYNAPSE_LIVE = true;
      badge('EN DIRECT · ' + g.nodes.length + ' entrées' +
            (g.truncated ? ' / ' + g.total : ''), '#3fe8a8');
    }
  } catch (e) {
    var why = /timeout|abort/i.test(String(e)) ? 'délai dépassé'
            : /401|403/.test(String(e))        ? 'jeton refusé'
            : 'hors ligne';
    badge('DÉMO · SYNAPSE ' + why, '#8a93c0');
  }
})();
