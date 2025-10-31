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
            // Calculer l'expiration (15 minutes par défaut)
            const expiresAt = Date.now() + (15 * 60 * 1000);

            await chrome.storage.local.set({
                [this.storageKeys.accessToken]: tokens.access_token,
                [this.storageKeys.refreshToken]: tokens.refresh_token,
                [this.storageKeys.deviceId]: tokens.device_id,
                [this.storageKeys.tokenExpires]: expiresAt
            });

            console.log('✅ Tokens web sauvegardés');
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

    // Synchroniser le profil
    async syncProfile(profileData) {
        const accessToken = await this.getValidAccessToken();
        const payload = {
            followers: profileData.followers || 0,
            skills: profileData.skills || [],
            collectedAt: profileData.timestamp || new Date().toISOString()
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

    // Synchroniser les publications
    async syncPublications(publications) {
        const accessToken = await this.getValidAccessToken();

        const formattedPublications = publications.map(pub => ({
            urn: pub.urn,
            text: pub.text || '',
            author: pub.author || '',
            isRepost: pub.isRepost || false,
            type: pub.type || (pub.isRepost ? 'repost' : 'original'),
            publishedDate: pub.publishedDate || pub.timestamp || new Date().toISOString(),
            rawDateText: pub.rawDateText || '',
            collectedAt: pub.collectedAt || pub.timestamp || new Date().toISOString(),
            stats: {
                reactions: pub.stats?.reactions || 0,
                comments: pub.stats?.comments || 0,
                reposts: pub.stats?.reposts || 0
            }
        }));

        const response = await fetch(this.getFullUrl('/linkedin/publications'), {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(formattedPublications)
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.message || `Erreur ${response.status}`);
        }

        return await response.json();
    }

    // Méthodes utilitaires (storage, tokens, etc.)
    async saveTokens(tokens) {
        const expiresAt = Date.now() + (tokens.expires_in * 1000);

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

        // DEBUG TEMPORAIRE
        console.log('🔍 Debug tokens:', {
            hasAccessToken: !!tokens.accessToken,
            hasExpiresAt: !!tokens.expiresAt,
            expiresAt: tokens.expiresAt,
            now: Date.now(),
            isValid: tokens.expiresAt > (Date.now() + 120000)
        });

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

    async isLinked() {
        return await this.isTokenValid();
    }
}

const backgroundAuth = new BackgroundLinkXPAuth();


console.log('LinkXP Background Service Worker started');

// Installation de l'extension
chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
        console.log('LinkXP installé avec succès !');

        // Initialiser le storage
        chrome.storage.local.set({
            trackedPosts: [],
            profile: null,
            publications: [],
            settings: {
                apiUrl: 'https://app.linkxp.net/api/v1',
                apiKey: '',
                autoSync: false
            }
        });
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
                case 'syncToAPI':
                    syncDataToAPI(request.data)
                        .then(result => sendResponse({ success: true, result }))
                        .catch(error => sendResponse({ success: false, error: error.message }));
                    return true; // Permet les réponses asynchrones

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

                case 'syncProfile':
                    const profileResult = await backgroundAuth.syncProfile(request.profileData);
                    sendResponse({ success: true, data: profileResult });
                    break;

                case 'syncPublications':
                    const pubResult = await backgroundAuth.syncPublications(request.publications);
                    sendResponse({ success: true, data: pubResult });
                    break;

                case 'syncToNewAPI':
                    // Logique de sync complète avec la nouvelle API
                    const data = await chrome.storage.local.get(['profile', 'publications']);
                    let syncCount = 0;

                    if (data.profile) {
                        await backgroundAuth.syncProfile(data.profile);
                        syncCount++;
                    }

                    if (data.publications && data.publications.length > 0) {
                        // Diviser en chunks de 20
                        const chunks = [];
                        for (let i = 0; i < data.publications.length; i += 20) {
                            chunks.push(data.publications.slice(i, i + 20));
                        }

                        for (const chunk of chunks) {
                            await backgroundAuth.syncPublications(chunk);
                            syncCount++;
                            // Pause pour rate limiting
                            if (chunks.length > 1) {
                                await new Promise(resolve => setTimeout(resolve, 1000));
                            }
                        }
                    }

                    sendResponse({ success: true, data: { syncCount } });
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
    }
});

// Synchronisation avec l'API (préparé pour le futur)
async function syncDataToAPI(data) {
    try {
        // Récupérer les paramètres API
        const settings = await chrome.storage.local.get('settings');
        const apiUrl = settings.settings?.apiUrl;
        const apiKey = settings.settings?.apiKey;

        if (!apiUrl) {
            throw new Error('URL API non configurée');
        }

        // Préparer les données pour l'API
        const payload = {
            timestamp: new Date().toISOString(),
            data: data
        };

        // Envoi à l'API (quand elle sera prête)
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            throw new Error(`Erreur API: ${response.status}`);
        }

        const result = await response.json();
        console.log('Données synchronisées avec succès:', result);

        return result;

    } catch (error) {
        console.error('Erreur synchronisation API:', error);
        throw error;
    }
}

// Nettoyage périodique des anciennes données (optionnel)
chrome.alarms.create('cleanupOldData', { periodInMinutes: 1440 }); // 24h

chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === 'cleanupOldData') {
        await cleanupOldData();
    }
});

async function cleanupOldData() {
    try {
        const data = await chrome.storage.local.get('trackedPosts');
        const trackedPosts = data.trackedPosts || [];

        // Garder uniquement les posts des 30 derniers jours
        const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);

        const filteredPosts = trackedPosts.filter(post => {
            const postDate = new Date(post.timestamp).getTime();
            return postDate > thirtyDaysAgo;
        });

        await chrome.storage.local.set({ trackedPosts: filteredPosts });

        console.log(`Nettoyage effectué: ${trackedPosts.length - filteredPosts.length} posts supprimés`);

    } catch (error) {
        console.error('Erreur nettoyage:', error);
    }
}


// Gestion des erreurs globales
self.addEventListener('error', (event) => {
    console.error('Erreur dans le service worker:', event.error);
});

self.addEventListener('unhandledrejection', (event) => {
    console.error('Promise rejetée:', event.reason);
});
