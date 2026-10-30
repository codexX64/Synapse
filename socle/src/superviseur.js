// Superviseur : le processus lancé par le conteneur garde le service dans un
// processus enfant et le relance quand l'assistant de configuration a posé de
// nouveaux réglages. Les signaux d'arrêt passent à l'enfant ; le code de sortie
// de l'enfant devient celui du conteneur.
//
// Dans le point d'entrée d'un service :
//   if (!superviser()) { ...démarrage habituel... }
import { fork } from 'node:child_process';

export const ENFANT = 'SOCLE_SUPERVISE';

// Vrai dans le processus superviseur (l'appelant n'a plus rien à faire), faux
// dans l'enfant, ou quand SOCLE_SANS_SUPERVISEUR=1 (démarrage direct).
export function superviser({ log = console } = {}) {
  if (process.env[ENFANT] === '1' || process.env.SOCLE_SANS_SUPERVISEUR === '1') return false;
  let enfant = null, arret = false, relancer = false;
  const lancer = () => {
    relancer = false;
    enfant = fork(process.argv[1], process.argv.slice(2), { env: { ...process.env, [ENFANT]: '1' }, execArgv: process.execArgv, stdio: 'inherit' });
    enfant.on('message', m => { if (m?.socle === 'redemarrer') relancer = true; });
    enfant.on('exit', (code, signal) => {
      if (relancer && !arret) {
        log.info?.('[assistant] Nouveaux réglages : redémarrage du service.');
        setTimeout(lancer, 200);
        return;
      }
      process.exit(code ?? (signal ? 1 : 0));
    });
  };
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(sig, () => { arret = true; if (enfant?.exitCode === null) enfant.kill(sig); else process.exit(0); });
  }
  lancer();
  return true;
}

// Dans l'enfant : demande au superviseur de relancer, puis s'arrête proprement
// par le chemin habituel (SIGTERM). Null hors supervision : il faut alors
// redémarrer le service à la main.
export function redemarreur() {
  if (process.env[ENFANT] !== '1' || typeof process.send !== 'function') return null;
  return () => { process.send({ socle: 'redemarrer' }, () => process.kill(process.pid, 'SIGTERM')); };
}
