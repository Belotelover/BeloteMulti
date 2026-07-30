# Belote entre amis — serveur multijoueur

Le **même moteur** que la version solo (`belote-engine.js`), piloté par un serveur
qui détient seul la vérité. Chaque joueur ne reçoit que **sa vue** (sa main +
l'info publique) : impossible de voir les cartes des autres, même en ouvrant la
console du navigateur.

## Contenu

| Fichier | Rôle |
|---|---|
| `belote-engine.js` | Le moteur : règles, distribution non-mélangée + coupe, litige, capot, belote-rebelote, IA des bots (déduction, signaux, annonces) |
| `server.js` | Rooms à code 4 lettres, sièges, bots sur les sièges vides, reconnexion par jeton, bot-relais en cas de déconnexion |
| `public/index.html` | Le client : affiche la vue reçue, envoie des intentions. Même feuille de style que le solo |
| `render.yaml` | Blueprint de déploiement Render |

## Déployer sur Render (gratuit)

1. **Mettre ce dossier sur GitHub** : crée un dépôt (même privé), pousse ces fichiers à la racine.
2. Sur [render.com](https://render.com) : *New → Blueprint*, choisis le dépôt.
   Render lit `render.yaml` et configure tout (plan **Free**, `npm install`, `npm start`).
3. À la fin, Render te donne une URL du type `https://belote-xxxx.onrender.com` — c'est le jeu.

Alternative sans blueprint : *New → Web Service*, runtime **Node**, build `npm install`,
start `npm start`, plan **Free**. C'est tout : le serveur lit le port dans `PORT`
(fourni par Render) et sert la page + les WebSockets sur la même URL.

## À savoir (offre gratuite Render)

- Le service **s'endort après 15 min sans trafic**. Le premier arrivant attend
  ~1 minute (page de chargement Render), puis tout est instantané. **Une partie
  en cours ne s'endort pas** : les messages WebSocket comptent comme du trafic.
- Passer au plan payant (7 $/mois) supprime l'endormissement, sans changer le code.

## Jouer

1. Le premier ouvre l'URL, entre son prénom, **Créer une partie** → code à 4 lettres.
2. Les autres entrent le code → **Rejoindre**. De 1 à 4 humains ; les sièges vides
   sont des bots (les mêmes que le solo).
   Dans le lobby, **clique une chaise libre pour choisir ta place** — les sièges
   haut+bas forment une équipe, gauche+droite l'autre. Verrouillé au lancement.
3. **Lancer la partie.** Un joueur qui ferme l'onglet est remplacé par un bot ;
   il retrouve son siège en revenant (jeton en mémoire de session).

## Développement local

```bash
npm install
npm start          # http://localhost:10000
FAST=1 npm start   # délais divisés par 12 (tests)
```

Tests : `node integration-test.js` (partie complète à 2 humains + 2 bots via
WebSockets, audit anti-fuite) et `node reco-test.js` (déconnexion → bot → reconnexion).

## Garder le moteur synchronisé avec le solo

Le moteur est extrait du fichier solo (source de vérité). Après une évolution des
règles/bots dans `belote.html`, ré-extraire `belote-engine.js` (tout le script sauf
les blocs navigateur : thèmes, plein écran, icônes SVG, `browserLater`, et la
section RENDERING) puis relancer les deux tests réseau.
