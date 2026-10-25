# LinkXP Collector — Extension Chrome

Extension Chrome (Manifest V3) qui collecte les publications LinkedIn d'un utilisateur et leurs statistiques, puis les envoie à l'API [LinkXP](https://www.linkxp.net/) pour analyse.

L'extension ne publie rien, ne modifie rien et n'interagit pas avec LinkedIn au nom de l'utilisateur. La collecte est déclenchée manuellement, s'exécute lentement en arrière-plan avec un délai aléatoire entre chaque requête et un plafond de requêtes par jour, et s'arrête immédiatement si LinkedIn signale un blocage.

---

## Stack et prérequis

- **Chrome / Chromium** 116+ (Manifest V3, `chrome.action.openPopup` utilisé depuis Chrome 127)
- **JavaScript natif** — pas de build, pas de bundler, pas de dépendance npm
- L'extension communique avec l'API LinkXP (`https://app.linkxp.net/api/v1`)

## Structure du dépôt

```
.
├── manifest.json        # Manifest V3 : permissions, service worker, externally_connectable
├── background.js        # Service worker — auth (device linking, tokens), orchestration de la collecte
├── collector.js         # Module de collecte — parsing des réponses LinkedIn, logique d'inventaire
│                        #   et de statistiques détaillées, envoi par lots à l'API LinkXP
├── popup.html           # Interface popup de l'extension
├── popup.js             # Logique popup — liaison compte, déclenchement collecte, collecte compétences
├── styles.css           # Styles de la popup
├── icons/               # Icônes de l'extension (16, 48, 128 px — PNG + SVG source)
├── .gitignore
└── README.md
```

### Rôle de chaque module

**`background.js`** — Service worker principal. Gère l'authentification par device linking (init → validation web → tokens), le refresh automatique des tokens, et les appels authentifiés à l'API LinkXP. Instancie `LinkXPCollector` pour lancer une collecte.

**`collector.js`** — Chargé par `background.js` via `importScripts()`. Contient :
- `LinkXPParsers` : fonctions pures de parsing (inventaire, statistiques, commentaires)
- `LinkXPCollector` : orchestration d'un passage de collecte (profil → abonnés → inventaire → file de collecte détaillée traitée post par post), persisté pour reprendre après une interruption
- `linkxpLinkedInRequest()` : fonction injectée dans un onglet LinkedIn via `chrome.scripting` pour exécuter les requêtes avec la session de l'utilisateur

**`popup.js`** — Interface utilisateur. Actions : lier/délier le compte LinkXP, collecter les publications, mettre en pause / reprendre la collecte, collecter les compétences. Affiche la progression et la couverture (« statistiques détaillées pour X de vos Y posts ») en temps réel via `chrome.storage.onChanged`.

## Installation en développement

1. Cloner le dépôt :
   ```bash
   git clone https://github.com/lexprodsas/linkxp-collector-extension.git
   ```

2. Ouvrir `chrome://extensions/` dans Chrome

3. Activer le **mode développeur** (toggle en haut à droite)

4. Cliquer **Charger l'extension non empaquetée** et sélectionner le dossier cloné

5. L'extension apparaît dans la barre d'outils. Cliquer dessus pour ouvrir la popup.

L'extension pointe par défaut vers l'API de production (`https://app.linkxp.net/api/v1`). Pour utiliser une API locale ou de staging, modifier `apiBaseUrl` et `webBaseUrl` dans le constructeur de `BackgroundLinkXPAuth` (`background.js`).

## Configuration

### Clé du manifest

Le champ `key` dans `manifest.json` est la **clé publique** de l'extension. Elle fixe l'identifiant de l'extension (`chrome.runtime.id`) quel que soit l'environnement, ce qui est nécessaire pour que `externally_connectable` fonctionne (communication entre `app.linkxp.net` et l'extension).

**Ne pas modifier ni supprimer cette clé** : l'API LinkXP utilise l'ID d'extension pour identifier les appels légitimes.

Le Chrome Web Store refuse un manifest qui contient `key` : `package.ps1` la retire de la copie packagée. Une fois l'extension publiée, l'ID est celui attribué par le Web Store ; pour que l'ID local corresponde, remplacer la valeur de `key` par la clé publique affichée dans le tableau de bord développeur (Package > Afficher la clé publique).

### Constantes de collecte

Les paramètres de collecte sont dans l'objet `LINKXP_COLLECT` en tête de `collector.js` :

| Constante | Valeur | Description |
|-----------|--------|-------------|
| `INVENTORY_DELAY_MS` | 3 000 – 5 000 | Délai aléatoire entre deux requêtes de l'inventaire (ms) |
| `DETAIL_DELAY_MS` | 8 000 – 15 000 | Délai aléatoire entre deux requêtes de la collecte détaillée (ms) |
| `LONG_PAUSE_EVERY` / `LONG_PAUSE_MS` | 25 / 3 – 6 min | Pause longue toutes les 25 pages de statistiques |
| `DAILY_REQUEST_CAP` | 300 | Requêtes LinkedIn par jour, tous passages confondus |
| `INVENTORY_MAX_PAGES` | 10 | Pages d'inventaire max (× 50 = 500 publications) |
| `MATURITY_DAYS` | 7 | Aucun post n'est détaillé avant J+7 |
| `DETAIL_WINDOW_DAYS` | 365 | Seuls les posts des 12 derniers mois sont détaillés |
| `REFRESH_WINDOW_DAYS` | 90 | Âge maximal d'un post pour une actualisation automatique |
| `REFRESH_MIN_GROWTH` / `REFRESH_MIN_INTERACTIONS` | 15 % / 5 | Hausse des interactions qui déclenche une actualisation |
| `MAX_AUTO_REFRESHES` | 2 | Actualisations automatiques par post |
| `MAX_DETAIL_FAILURES` | 3 | Échecs consécutifs avant de marquer un post indisponible |

## Fonctionnement

1. **Liaison du compte** — L'utilisateur lie l'extension à son compte LinkXP via un flux device linking : l'extension demande un token temporaire à l'API, ouvre une page de validation sur `app.linkxp.net`, et reçoit les tokens d'accès en retour.

2. **Inventaire** — L'extension parcourt le flux de publications LinkedIn de l'utilisateur (via un onglet LinkedIn ouvert) et envoie la liste à l'API LinkXP par lots.

3. **File de collecte détaillée** — Seuls les posts qui en ont besoin y entrent : originaux publiés depuis 7 jours à 12 mois dont le détail est absent ou incomplet (visites de profil ou abonnés gagnés vides), les plus récents d'abord. Viennent en tête les demandes d'actualisation faites depuis l'app, en dernier les posts complets de moins de 90 jours dont les réactions + commentaires + reposts de l'inventaire ont augmenté d'au moins 15 % et de 5 depuis leur dernier détail (deux fois au plus). Un post complet qui n'a pas bougé n'est jamais recollecté.

4. **Statistiques détaillées** — Pour chaque post de la file : page de statistiques, puis commentaires (lus une fois, relus seulement si leur total a changé). Chaque post est envoyé à l'API dès qu'il est collecté. Un post en échec trois fois de suite est marqué indisponible et sort de la file.

5. **Arrière-plan et reprise** — Le passage (file, avancement, lignes et journal pas encore envoyés) est persisté dans `chrome.storage.local.collectJob`. Les attentes longues sont découpées en tranches de 20 s pour que le service worker ne soit pas arrêté. Une collecte interrompue (service worker arrêté, Chrome fermé, veille) reprend seule après un délai ; au plafond du jour, elle reprend le lendemain (`chrome.alarms`). Jamais après un signal de blocage LinkedIn ni une pause demandée par l'utilisateur.

6. **Progression** — L'état de la collecte est partagé avec la popup via `chrome.storage.local.collectState`. La collecte continue même si la popup est fermée.

Le détail du protocole de collecte, du parsing et de la gestion des anomalies est documenté dans les commentaires de `collector.js`.

## Build et packaging

Pas de build nécessaire. Pour distribuer une nouvelle version :

1. Mettre à jour `version` dans `manifest.json`
2. Créer le zip (retire le champ `key` du manifest et n'inclut que les fichiers de l'extension) :
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\package.ps1
   ```
   Le zip `linkxp-X.Y.Z.zip` est créé à la racine, prêt à être envoyé sur le Chrome Web Store.
3. Mettre à jour la version attendue côté serveur (API LinkXP) pour que le contrôle de version fonctionne
4. Ne pas committer le zip — il est exclu par `.gitignore`

## Contribuer

- Pas de bundler ni de transpileur : JavaScript natif, compatible Chrome 116+
- Respecter la structure existante : parsing pur dans `LinkXPParsers`, effets de bord dans `LinkXPCollector`
- Commenter en français (cohérence avec le code existant)
- Tester manuellement sur un compte LinkedIn avec des publications
- Ouvrir une issue avant une PR pour discuter de l'approche

## Limites connues

- **Libellés de statistiques** : le parsing de la page de statistiques LinkedIn repose sur des libellés textuels. Seuls le français et l'anglais sont supportés (`STATS_PATTERNS` dans `collector.js`). D'autres langues LinkedIn produiront des valeurs nulles.
- **Commentaires** : seule la première page de commentaires (100) est chargée. Au-delà, le compteur de commentaires lecteurs peut être sous-estimé.
- **Durée du token** : le jeton d'accès expire après 7 heures (fixe). Le refresh est automatique tant que le refresh token est valide.
- **Routes LinkedIn non officielles** : l'extension s'appuie sur des routes internes de LinkedIn qui peuvent changer sans préavis.

## Ressources

- [LinkXP — Site du projet](https://www.linkxp.net/)
- Documentation interne de l'API : disponible pour les contributeurs sur demande

## Licence

Ce projet est distribué sous licence MIT. Voir le fichier [LICENSE](LICENSE).

## Disclaimer

Ce projet n'est pas affilié à, ni approuvé par LinkedIn Corporation. L'extension utilise des interfaces non documentées de LinkedIn susceptibles de changer à tout moment. Utilisation à vos propres risques. Respectez les conditions d'utilisation de LinkedIn.
