# LinkXP Collector — Extension Chrome

Extension Chrome (Manifest V3) qui collecte les publications LinkedIn d'un utilisateur et leurs statistiques, puis les envoie à l'API [LinkXP](https://www.linkxp.net/) pour analyse.

L'extension ne publie rien, ne modifie rien et n'interagit pas avec LinkedIn au nom de l'utilisateur. La collecte est déclenchée manuellement, s'exécute en arrière-plan avec un délai aléatoire entre chaque requête, et s'arrête immédiatement si LinkedIn signale un blocage.

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
- `LinkXPCollector` : orchestration d'un passage de collecte complet (profil → abonnés → inventaire → statistiques détaillées → envoi)
- `linkxpLinkedInRequest()` : fonction injectée dans un onglet LinkedIn via `chrome.scripting` pour exécuter les requêtes avec la session de l'utilisateur

**`popup.js`** — Interface utilisateur. Trois actions : lier/délier le compte LinkXP, collecter les publications, collecter les compétences. Affiche la progression en temps réel via `chrome.storage.onChanged`.

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

### Constantes de collecte

Les paramètres de collecte sont dans l'objet `LINKXP_COLLECT` en tête de `collector.js` :

| Constante | Valeur | Description |
|-----------|--------|-------------|
| `DELAY_MIN_MS` / `DELAY_MAX_MS` | 3 000 – 5 000 | Délai aléatoire entre deux requêtes LinkedIn (ms) |
| `INVENTORY_MAX_PAGES` | 10 | Pages d'inventaire max (× 50 = 500 publications) |
| `MAX_DETAILED_POSTS` | 100 | Posts en collecte détaillée par passage |
| `MATURITY_DAYS` | 7 | Jours avant qu'un post soit considéré mature |
| `REFRESH_WINDOW_DAYS` | 90 | Fenêtre de rafraîchissement des statistiques |

## Fonctionnement

1. **Liaison du compte** — L'utilisateur lie l'extension à son compte LinkXP via un flux device linking : l'extension demande un token temporaire à l'API, ouvre une page de validation sur `app.linkxp.net`, et reçoit les tokens d'accès en retour.

2. **Inventaire** — L'extension parcourt le flux de publications LinkedIn de l'utilisateur (via un onglet LinkedIn ouvert) et envoie la liste à l'API LinkXP par lots.

3. **Statistiques détaillées** — Pour chaque publication originale éligible, l'extension récupère les statistiques (impressions, réactions, commentaires, etc.) et les commentaires, puis envoie les résultats à l'API.

4. **Progression** — L'état de la collecte est partagé avec la popup via `chrome.storage.local`. La collecte continue même si la popup est fermée.

Le détail du protocole de collecte, du parsing et de la gestion des anomalies est documenté dans les commentaires de `collector.js`.

## Build et packaging

Pas de build nécessaire. Pour distribuer une nouvelle version :

1. Mettre à jour `version` dans `manifest.json`
2. Créer le zip :
   ```bash
   # Depuis la racine du projet
   zip -r linkxp-X.Y.Z.zip . -x ".git/*" ".gitignore" "README.md"
   ```
   Ou sous PowerShell :
   ```powershell
   Compress-Archive -Path .\* -DestinationPath .\linkxp-X.Y.Z.zip -Force
   ```
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
