# RefChat 3.35.52 — corrections vérifiées

Les bugs reproduits dans le projet ont été corrigés. La capture, l’analyse manuelle, l’IA en direct et la pause d’ambiance conservent leurs réglages et leurs parcours actuels.

- **Citations Kick** : un pseudo placé avant « Répond à » ne bloque plus la détection. Les citations dans un fragment distinct sont retirées du texte analysé ; la vraie réponse reste présente. Le contexte cité peut conserver jusqu’à 500 caractères.
- **Pause d’ambiance** : un résultat arrivé pendant la désactivation ou le réaffichage est rejeté, même pendant le dernier contrôle de focus. Les messages reçus pendant une analyse planifient la suivante. Un changement d’URL dans le même chat renouvelle l’échantillon et invalide le résultat de l’ancienne URL.
- **Stockage des mutes** : les lectures et écritures du worker sont sérialisées. Une suppression ne peut plus être annulée par un ajout simultané. Deux ajouts du même pseudo sur Twitch et Kick conservent les deux décisions. Une écriture échouée ne publie pas un faux succès et ne bloque pas la file suivante.
- **Commandes manuelles** : le mute est confirmé après son enregistrement ; le choix « permanent » est transmis et conservé. L’effacement complet attend les ajouts déjà en cours. Le pardon des décisions automatiques respecte les mutes manuels et permanents, tout en réévaluant les anciennes décisions politiques selon la politique existante.
- **Annulation du direct** : les nouvelles décisions portent leur identifiant d’origine. L’annulation retire leur mute persistant, protège un mute manuel intervenu ensuite et préserve l’autre plateforme. Un arrêt pendant l’écriture retire aussi la décision tardive. Le caractère permanent d’une plateforme n’est plus transféré à l’autre lors d’une suppression.

## Validation

`npm test` découvre et exécute désormais les **37 suites** du projet, au lieu des 11 suites sélectionnées auparavant. Elles passent toutes, y compris les serveurs d’archive et de synchronisation utilisés avec des données temporaires. Les fixtures anciennes ont été alignées sur l’authentification SuperGrok actuelle, le JSON strict et l’onglet Signalements actuel.

`tests/check-races.js` ajoute **14 régressions** concernant les écritures concurrentes, les confirmations manuelles, les annulations, les changements d’URL et les résultats retardés. Le contrôle de syntaxe couvre **61 fichiers JavaScript** ; les ressources du manifeste, les imports du worker, les styles et les scripts des écrans sont vérifiés.

Les appels aux comptes et aux modèles sont simulés. Une session SuperGrok réelle et la capture sur un live Twitch/Kick n’ont pas été testées pendant cette correction.

## Activation et sauvegarde

Recharger RefChat dans la page Extensions du navigateur, puis actualiser les pages Twitch/Kick ouvertes.

Les fichiers d’origine sont conservés dans `.backups/bugfix-20261010/original/`. Le résultat du contrôle final se trouve dans `.backups/bugfix-20261010/final-test.log`.
