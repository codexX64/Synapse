'use strict';
/* Reprise des comptes de SYNAPSE 1.x (tables auth_*) dans le socle.

   Les empreintes scrypt se relisent telles quelles et passent en Argon2id
   à la première connexion. Les secrets TOTP, qui étaient en clair, sont
   scellés. Les clés d'accès sont reprises avec leur identifiant : le
   « handle » du compte reste celui sous lequel elles ont été créées, sans
   quoi le navigateur les présenterait pour un autre compte. Les codes de
   secours (huit codes de 40 bits) ne sont pas repris : trop faibles, ils
   sont remplacés à l'inscription des facteurs. Les sessions ouvertes sont
   fermées : chacun se reconnecte une fois. Le compte temporaire du premier
   démarrage (init) n'est pas repris : c'est lui qui ouvrait la porte. */

const normalise = s => String(s || '').normalize('NFKC').trim().toLowerCase();

function migrerComptes({ db, comptes, coffre, log }) {
  const existe = t => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  if (!existe('auth_users')) return 0;
  const colonne = c => !!db.prepare("SELECT 1 FROM pragma_table_info('auth_users') WHERE name = ?").get(c);
  const anciens = db.prepare(`SELECT * FROM auth_users ${colonne('init') ? 'WHERE init = 0' : ''} ORDER BY created_at, name`).all();
  const cles = existe('auth_passkeys') ? db.prepare('SELECT * FROM auth_passkeys').all() : [];
  let n = 0;
  comptes.transaction(() => {
    for (const u of anciens) {
      let ident = normalise(u.name).replace(/[^\p{L}\p{N}._@+-]/gu, '-').slice(0, 60);
      if (ident.length < 3 || comptes.parIdentifiant(ident)) continue;
      const c = comptes.creerCompte({ identifiant: ident, affichage: u.name, role: 'admin' });
      const totp = u.totp && !u.mfa_a_poser ? coffre.scelle('totp', String(u.totp).replace(/\s/g, '').toUpperCase(), c.id) : null;
      const cree = Date.parse(u.created_at) || Date.now();
      db.prepare('UPDATE socle_comptes SET mdp = ?, totp = ?, handle = ?, actif = ?, cree = ? WHERE id = ?')
        .run(u.pass || null, totp, Buffer.from(u.name).toString('base64url'), u.active ? 1 : 0, cree, c.id);
      for (const k of cles.filter(k => k.user === u.name)) {
        db.prepare(`INSERT OR IGNORE INTO socle_cles(id, compte, cred, spki, alg, compteur, transports, aaguid, sauvegardee, nom, cree, rp)
                    VALUES(?,?,?,?,-7,?,'[]',NULL,0,?,?,NULL)`)
          .run('k_' + k.id.slice(0, 22), c.id, k.id, Buffer.from(k.pubkey, 'base64').toString('base64url'),
               Number(k.counter) || 0, String(k.label || 'Clé d’accès').slice(0, 60), Date.parse(k.created_at) || cree);
      }
      n++;
    }
    db.exec('DROP TABLE IF EXISTS auth_sessions; DROP TABLE IF EXISTS auth_defis; DROP TABLE IF EXISTS auth_essais; DROP TABLE IF EXISTS auth_passkeys; DROP TABLE auth_users;');
  });
  if (n) {
    comptes.trace({ action: 'migration.synapse', details: { comptes: n } });
    log.info?.(`[comptes] ${n} compte(s) de SYNAPSE 1.x repris dans le socle : chacun se reconnecte une fois et régénère ses codes de secours.`);
  }
  return n;
}

module.exports = { migrerComptes };
