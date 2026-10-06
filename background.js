importScripts('collector.js');

class BackgroundLinkXPAuth {
    constructor() {
        this.apiBaseUrl = 'https://app.linkxp.net/api/v1';
        this.webBaseUrl = 'https://app.linkxp.net';
        this.storageKeys = {
            deviceId: 'linkxp_device_id',
            accessToken: 'linkxp_access_token',
            refreshToken: 'linkxp_refresh_token',
            tokenExpires: 'linkxp_token_expires'
        };
    }

    getFullUrl(endpoint) {
        const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
        return `${this.apiBaseUrl}${cleanEndpoint}`;
    }

    getWebUrl(path) {
        const cleanPath = path.startsWith('/') ? path : `/${path}`;
        return `${this.webBaseUrl}${cleanPath}`;
    }

    // Étape 1: Demander un Device Link Token
    async initDeviceLinking() {
        try {
            const response = await fetch(this.getFullUrl('/auth/device/init'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Extension-ID': chrome.runtime.id,
                    'X-Extension-Version': chrome.runtime.getManifest().version,
                },
                body: JSON.stringify({
                    extension_version: chrome.runtime.getManifest().version
                })
            });

            if (!response.ok) {
                throw new Error(`Erreur API: ${response.status}`);
            }

            const data = await response.json();
            if (data.status === 'success') {
                return data.data;
            } else {
                throw new Error(data.message || 'Erreur inconnue');
            }
        } catch (error) {
            console.error('Erreur init device linking:', error);
            throw error;
        }
    }

    // Étape 2
    async saveTokensFromWeb(tokens) {
        try {
            const expiresAt = Date.now() + (7 * 60 * 60 * 1000); // 7 heures

            await chrome.storage.local.set({
                [this.storageKeys.accessToken]: tokens.access_token,
                [this.storageKeys.refreshToken]: tokens.refresh_token,
                [this.storageKeys.deviceId]: tokens.device_id,
                [this.storageKeys.tokenExpires]: expiresAt
            });
        } catch (error) {
            console.error('Erreur sauvegarde tokens web:', error);
        }
    }

    // Étape 3: Confirmer la liaison
    async confirmDeviceLinking(linkToken) {
        try {
            const response = await fetch(this.getFullUrl('/auth/device/confirm'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    link_token: linkToken,
                    user_id: 123
                })
            });

            if (!response.ok) {
                throw new Error(`Erreur API: ${response.status}`);
            }

            const data = await response.json();
            if (data.status === 'success') {
                const tokens = data.data;
                await this.saveTokens(tokens);
                return tokens;
            } else {
                throw new Error(data.message || 'Erreur confirmation');
            }
        } catch (error) {
            console.error('Erreur confirmation device:', error);
            throw error;
        }
    }

    // Refresh token
    async refreshAccessToken() {
        try {
            const tokens = await this.getStoredTokens();
            if (!tokens.refreshToken) {
                throw new Error('Pas de refresh token');
            }

            const response = await fetch(this.getFullUrl('/auth/refresh'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    refresh_token: tokens.refreshToken
                })
            });

            if (!response.ok) {
                throw new Error(`Erreur refresh: ${response.status}`);
            }

            const data = await response.json();
            if (data.status === 'success') {
                await this.saveTokens(data.data);
                return data.data.access_token;
            } else {
                throw new Error(data.message || 'Erreur refresh');
            }
        } catch (error) {
            console.error('Erreur refresh token:', error);
            await this.clearTokens();
            throw error;
        }
    }

    // Appel authentifié à l'API LinkXP (une nouvelle tentative après 60 s si la limite de débit est atteinte)
    async apiRequest(method, endpoint, body = null, retryOn429 = true) {
        const accessToken = await this.getValidAccessToken();
        const options = {
            method,
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            }
        };
        if (body !== null) {
            options.body = JSON.stringify(body);
        }

        const response = await fetch(this.getFullUrl(endpoint), options);

        if (response.status === 429 && retryOn429) {
            await new Promise(resolve => setTimeout(resolve, 61000));
            return this.apiRequest(method, endpoint, body, false);
        }
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.message || `Erreur ${response.status}`);
        }

        return await response.json();
    }

    // Méthodes utilitaires (storage, tokens, etc.)
    async saveTokens(tokens) {
        const expiresAt = Date.now() + (7 * 60 * 60 * 1000); // 7 heures fixe

        await chrome.storage.local.set({
            [this.storageKeys.accessToken]: tokens.access_token,
            [this.storageKeys.refreshToken]: tokens.refresh_token,
            [this.storageKeys.tokenExpires]: expiresAt
        });
    }

    async getStoredTokens() {
        const data = await chrome.storage.local.get([
            this.storageKeys.accessToken,
            this.storageKeys.refreshToken,
            this.storageKeys.tokenExpires
        ]);

        return {
            accessToken: data[this.storageKeys.accessToken],
            refreshToken: data[this.storageKeys.refreshToken],
            expiresAt: data[this.storageKeys.tokenExpires]
        };
    }

    async isTokenValid() {
        const tokens = await this.getStoredTokens();

        if (!tokens.accessToken || !tokens.expiresAt) {
            return false;
        }
        return tokens.expiresAt > (Date.now() + 120000);
    }


    async getValidAccessToken() {
        if (await this.isTokenValid()) {
            const tokens = await this.getStoredTokens();
            return tokens.accessToken;
        }

        try {
            return await this.refreshAccessToken();
        } catch (error) {
            throw new Error('DEVICE_LINKING_REQUIRED');
        }
    }

    async clearTokens() {
        await chrome.storage.local.remove([
            this.storageKeys.accessToken,
            this.storageKeys.refreshToken,
            this.storageKeys.tokenExpires
        ]);
    }

    // Lié tant qu'un jeton d'accès valide peut être obtenu (rafraîchi au besoin) : un jeton d'accès expiré
    // après 7 h ne veut pas dire que la liaison est perdue
    async isLinked() {
        // Jamais liée (ou déliée) : pas de rafraîchissement à tenter, ce n'est pas une erreur
        const tokens = await this.getStoredTokens();
        if (!tokens.refreshToken) {
            return false;
        }
        try {
            await this.getValidAccessToken();
            return true;
        } catch (error) {
            return false;
        }
    }

    async getDeviceId() {
        const data = await chrome.storage.local.get(this.storageKeys.deviceId);
        return data[this.storageKeys.deviceId] || null;
    }

    async syncSkills(skills) {
        const accessToken = await this.getValidAccessToken();

        const payload = {
            skills: skills,
            collectedAt: new Date().toISOString()
        };

        const response = await fetch(this.getFullUrl('/linkedin/profile'), {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.message || `Erreur ${response.status}`);
        }

        return await response.json();
    }
}

const backgroundAuth = new BackgroundLinkXPAuth();

// Installation de l'extension
chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
        console.log('LinkXP installé avec succès !');

    }

    if (details.reason === 'update') {
        console.log('LinkXP mis à jour !');
    }
});

// Écouter les messages des content scripts et popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log('Message reçu:', request);

    (async () => {
        try {

            switch (request.action) {
                case 'getStoredData':
                    chrome.storage.local.get(null, (data) => {
                        sendResponse({ success: true, data });
                    });
                    return true;

                case 'clearStorage':
                    chrome.storage.local.clear(() => {
                        sendResponse({ success: true });
                    });
                    return true;

                case 'initDeviceLinking':
                    const deviceData = await backgroundAuth.initDeviceLinking();
                    sendResponse({ success: true, data: deviceData });
                    return;

                case 'confirmDeviceLinking':
                    const tokens = await backgroundAuth.confirmDeviceLinking(request.linkToken);
                    sendResponse({ success: true, data: tokens });
                    return;

                case 'checkAuthStatus':
                    const isLinked = await backgroundAuth.isLinked();
                    sendResponse({ success: true, data: { isLinked } });
                    return;

                case 'clearTokens':
                    await backgroundAuth.clearTokens();
                    sendResponse({ success: true });
                    return;

                case 'startCollection':
                    // Répond tout de suite : la collecte dure plusieurs minutes et continue popup fermée
                    sendResponse({ success: true, data: { started: await startCollection() } });
                    break;

                case 'syncSkills':
                    const skillsResult = await backgroundAuth.syncSkills(request.skills);
                    sendResponse({ success: true, data: skillsResult });
                    break;

                default:
                    sendResponse({ success: false, error: 'Action inconnue' });
            }
        } catch (error) {
            console.error('Erreur background:', error);
            sendResponse({ success: false, error: error.message });
        }
    })();
    return true;
});

// Écouter les messages postMessage depuis les pages web
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
    console.log('Message externe reçu:', message);

    if (message.type === 'DEVICE_LINK_SUCCESS' && message.data) {
        // Sauvegarder les tokens reçus
        const tokens = message.data;
        backgroundAuth.saveTokensFromWeb(tokens);

        sendResponse({ success: true });
        console.log('✅ Tokens sauvegardés depuis la page web');
        return;
    }

    // Écran de constats : version installée et liaison (le serveur vérifie que l'appareil est lié au membre connecté)
    if (message.type === 'LINKXP_PING') {
        (async () => {
            const linked = await backgroundAuth.isLinked();
            sendResponse({
                success: true,
                data: {
                    version: chrome.runtime.getManifest().version,
                    linked,
                    deviceId: linked ? await backgroundAuth.getDeviceId() : null,
                },
            });
        })();
        return true;
    }

    // Écran de constats : ouvre la popup et y met en évidence le bouton à utiliser (link, relink ou collect)
    if (message.type === 'LINKXP_OPEN_POPUP') {
        (async () => {
            const target = ['link', 'relink', 'collect'].includes(message.target) ? message.target : 'link';
            await chrome.storage.local.set({ popupFocus: { target, at: Date.now() } });

            let opened = false;
            try {
                // Chrome 127+ ; échoue si la fenêtre n'a pas le focus : la page affiche alors la consigne
                await chrome.action.openPopup(sender.tab ? { windowId: sender.tab.windowId } : {});
                opened = true;
            } catch (error) {
                console.warn('Ouverture de la popup impossible :', error.message);
            }
            sendResponse({ success: true, data: { opened } });
        })();
        return true;
    }
});

// ========================================
// Collecte des publications (voir collector.js)
// État partagé avec la popup via chrome.storage.local.collectState
// ========================================

let collectionRunning = false;

// Au démarrage du service worker, aucune collecte ne tourne : une collecte « en cours » a été interrompue
chrome.storage.local.get('collectState').then(({ collectState }) => {
    if (collectState?.running) {
        setCollectState({ running: false, ok: false, finishedAt: Date.now(), message: 'Collecte interrompue, relancez-la.' });
    }
});

// Écritures sérialisées : une progression tardive ne peut pas écraser l'état final
let collectStateQueue = Promise.resolve();

function setCollectState(patch) {
    collectStateQueue = collectStateQueue.then(async () => {
        const { collectState } = await chrome.storage.local.get('collectState');
        await chrome.storage.local.set({ collectState: { ...(collectState || {}), ...patch } });
    }).catch(error => console.error('Erreur état de collecte:', error));
    return collectStateQueue;
}

async function startCollection() {
    if (collectionRunning) {
        return false;
    }
    // Rafraîchit le jeton si besoin, lève DEVICE_LINKING_REQUIRED sinon
    await backgroundAuth.getValidAccessToken();

    collectionRunning = true;
    await chrome.storage.local.set({
        collectState: { running: true, startedAt: Date.now(), phase: 'start', message: 'Démarrage de la collecte…' }
    });

    const collector = new LinkXPCollector(backgroundAuth, (progress) => setCollectState(progress));

    collector.run()
        .then(result => setCollectState({
            running: false,
            finishedAt: Date.now(),
            ok: result.ok,
            blocked: !!result.blocked,
            error: result.error || null,
            summary: result.summary,
            message: result.ok ? 'Collecte terminée' : result.error,
        }))
        .catch(error => setCollectState({ running: false, finishedAt: Date.now(), ok: false, error: error.message, message: error.message }))
        .finally(() => { collectionRunning = false; });

    return true;
}

// Gestion des erreurs globales
self.addEventListener('error', (event) => {
    console.error('Erreur dans le service worker:', event.error);
});

self.addEventListener('unhandledrejection', (event) => {
    console.error('Promise rejetée:', event.reason);
});
