# RefChat 3.35.1 — corrections Grok

Livraison du 29 septembre 2026, à partir de la version locale 3.35.0.

Les cinq défauts reproduits pendant l’audit sont corrigés :

- Une réponse vide, partielle, tronquée, hors schéma ou contenant seulement du raisonnement ne produit aucun verdict. Les captures restent en attente. Grok reçoit un schéma JSON strict avec un booléen de chaque type par message.
- Chaque appel xAI utilise le jeton OAuth courant, même lorsque plusieurs lots ou les deux lectures du direct partent d’un ancien état du moteur.
- Les pannes temporaires du renouvellement préservent la connexion. Seul un refus réel du jeton demande une reconnexion ; un HTTP 403 reste une erreur d’accès visible.
- Arrêter l’analyse annule les requêtes du lot et bloque leurs résultats tardifs. Une ancienne sauvegarde ne peut plus relancer l’analyse après un arrêt reçu pendant le démarrage.
- Les réponses Grok réservent leur place dans les plafonds de 30 envois et 40 appels par heure. Les doubles clics sur une ligne sont bloqués et les envois dans un même composeur sont traités un par un.

La connexion est également protégée contre les réponses tardives d’une demande de code ou d’une approbation OAuth après déconnexion.

L’analyse manuelle sépare les salons, fournit le texte capturé jusqu’à 300 caractères et les informations de réponse/citation, et utilise le contexte proche de l’heure de la capture. Les exemples issus des anciennes corrections sont explicitement distingués de la conversation courante. Un lot en échec est limité à six tentatives, avec son compteur conservé après redémarrage ; ses captures restent disponibles pour une nouvelle tentative manuelle.

Le popup affiche désormais la progression par personne et un bouton d’arrêt. Le tableau suit l’arrêt jusqu’à sa fin et conserve la cause d’une interruption. Les scores sont présentés comme des indices internes sur 100, sans les faire passer pour une probabilité de confiance.

Les modes de direct, les critères de modération, la simulation et le fonctionnement consultatif du relais Codex conservent leur comportement actuel.

## Validation

```powershell
node tests/check-grok.js
```

Les huit suites passent : OAuth, analyse au clic, direct, diagnostics, modèle sélectionné, réponses Grok, nouvelles régressions et états de l’interface. Les deux nouvelles suites contiennent 46 vérifications. La syntaxe des scripts modifiés et les ressources référencées par le manifeste sont également vérifiées.

Le popup et le tableau ont été inspectés dans le navigateur avec leurs vrais HTML, CSS et JavaScript, et un état Chrome simulé. Les scénarios d’analyse active, d’arrêt, de reprise possible et de panne OAuth temporaire ont été vérifiés. Aucun appel réel au compte SuperGrok ni aucun message réel de chat n’a été effectué. L’extension installée et les limites effectives du compte ne sont donc pas validées par ces tests.

## Activation et sauvegarde

Recharger RefChat depuis la page Extensions du navigateur, puis rouvrir le popup et le tableau. Actualiser les onglets Twitch/Kick pour retrouver une connexion propre au nouveau service worker.

Une sauvegarde des fichiers d’origine et de leurs empreintes SHA-256 est conservée dans `.backups/grok-hardening-2026-09-29/`. Les fichiers d’application modifiés sont `background.js`, `popup.js`, `popup.html`, `popup.css`, `board.js`, `board.html` et `manifest.json`.
