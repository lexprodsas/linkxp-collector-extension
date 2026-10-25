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

    // Appel authentifié à l'API LinkXP (une nouvelle tentative après 60 s si la limite de débit est atteinte,
    // attente découpée pour que le service worker ne soit pas arrêté entre-temps)
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
            await linkxpSleep(61000);
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
                    // Répond tout de suite : la collecte dure longtemps et continue popup fermée
                    sendResponse({ success: true, data: { started: await startCollection() } });
                    break;

                case 'pauseCollection':
                    sendResponse({ success: true, data: { paused: await pauseCollection() } });
                    break;

                case 'resumeCollection':
                    sendResponse({ success: true, data: { started: await resumeCollection() } });
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

    // Écran de constats : version installée, liaison (le serveur vérifie que l'appareil est lié au membre connecté)
    // et état de la collecte, suivi en direct par la page
    if (message.type === 'LINKXP_PING') {
        (async () => {
            const linked = await backgroundAuth.isLinked();
            sendResponse({
                success: true,
                data: {
                    version: chrome.runtime.getManifest().version,
                    linked,
                    deviceId: linked ? await backgroundAuth.getDeviceId() : null,
                    collect: linked ? await collectSummary() : null,
                },
            });
        })();
        return true;
    }

    // Écran de constats : ouvre la popup et y met en évidence le bouton à utiliser (link, relink ou collect)
    if (message.type === 'LINKXP_OPEN_POPUP') {
        (async () => {
            const target = ['link', 'relink', 'collect', 'resume'].includes(message.target) ? message.target : 'link';
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
// Passage persisté dans chrome.storage.local.collectJob ; état affiché par la popup dans collectState
// ========================================

const RESUME_ALARM = 'linkxp-collect-resume';
let activeCollector = null;

// Écritures sérialisées : une progression tardive ne peut pas écraser l'état final
let collectStateQueue = Promise.resolve();

function setCollectState(patch, replace = false) {
    collectStateQueue = collectStateQueue.then(async () => {
        const { collectState } = await chrome.storage.local.get('collectState');
        await chrome.storage.local.set({ collectState: { ...(replace ? {} : collectState || {}), ...patch } });
    }).catch(error => console.error('Erreur état de collecte:', error));
    return collectStateQueue;
}

// Lendemain, peu après minuit : le plafond de requêtes est remis à zéro
function nextDayResumeTime() {
    const midnight = new Date();
    midnight.setHours(24, 0, 0, 0);
    return midnight.getTime() + linkxpRandomBetween([10 * 60 * 1000, 40 * 60 * 1000]);
}

async function scheduleResume(when) {
    await chrome.alarms.create(RESUME_ALARM, { when });
}

// État de la collecte exposé à l'écran de constats (LINKXP_PING) : avancement, sans détail technique
async function collectSummary() {
    const { collectState } = await chrome.storage.local.get('collectState');
    if (!collectState) {
        return null;
    }
    return {
        running: !!collectState.running,
        status: collectState.status || null,
        phase: collectState.phase || null,
        message: collectState.running ? collectState.message || null : null,
        coverage: collectState.coverage || null,
        estimate: collectState.running ? collectState.estimate || null : null,
    };
}

const COLLECT_END_MESSAGES = {
    done: 'Collecte terminée',
    paused: 'Collecte en pause',
    daily_cap: 'Limite du jour atteinte : la collecte reprendra seule demain, laissez Chrome ouvert.',
};

function runCollector(collector) {
    activeCollector = collector;
    const progress = (state) => setCollectState({ ...state, running: true, status: 'running' });

    collector.onProgress = progress;
    progress({ phase: 'start', message: collector.job.phase === 'inventory' ? 'Démarrage de la collecte…' : 'Reprise de la collecte…', coverage: collector.job.coverage });

    collector.run()
        .then(async result => {
            if (result.status === 'daily_cap') {
                await scheduleResume(nextDayResumeTime());
            }
            await setCollectState({
                running: false,
                status: result.status,
                finishedAt: Date.now(),
                ok: result.status === 'done',
                blocked: result.status === 'blocked',
                error: result.error,
                summary: result.summary,
                coverage: result.coverage,
                estimate: null,
                message: COLLECT_END_MESSAGES[result.status] || result.error,
            });
        })
        .catch(error => setCollectState({ running: false, status: 'error', finishedAt: Date.now(), ok: false, error: error.message, message: error.message }))
        .finally(() => { activeCollector = null; });
}

// Nouveau passage : profil, inventaire, puis file de collecte détaillée reconstruite
async function startCollection() {
    if (activeCollector) {
        return false;
    }
    // Rafraîchit le jeton si besoin, lève DEVICE_LINKING_REQUIRED sinon
    await backgroundAuth.getValidAccessToken();
    await chrome.alarms.clear(RESUME_ALARM);

    // Lignes et journal d'un passage précédent pas encore envoyés : repris par le nouveau passage
    const previous = await LinkXPCollector.loadJob();
    const collector = new LinkXPCollector(backgroundAuth, null);
    collector.job.pendingRows = previous?.pendingRows || [];
    collector.job.logs = previous?.logs || [];
    collector.job.coverage = previous?.coverage || null;

    await setCollectState({ running: true, status: 'running', startedAt: Date.now() }, true);
    runCollector(collector);
    return true;
}

/**
 * Reprend la file du passage persisté, sans refaire l'inventaire.
 * Reprise automatique (auto = true) : collecte interrompue ou plafond du jour, jamais après un blocage
 * LinkedIn ni une pause demandée par l'utilisateur.
 */
async function resumeCollection(auto = false) {
    if (activeCollector) {
        return false;
    }
    const job = await LinkXPCollector.loadJob();
    const resumable = auto ? ['running', 'daily_cap'] : ['running', 'paused', 'daily_cap', 'error'];
    if (!job || !resumable.includes(job.status)) {
        return false;
    }

    try {
        await backgroundAuth.getValidAccessToken();
    } catch (error) {
        await chrome.storage.local.set({ collectJob: { ...job, status: 'error', error: error.message } });
        await setCollectState({ running: false, status: 'error', ok: false, error: error.message, message: 'Liaison requise : liez votre compte, puis reprenez la collecte.' });
        throw error;
    }
    await chrome.alarms.clear(RESUME_ALARM);

    runCollector(new LinkXPCollector(backgroundAuth, null, job));
    return true;
}

async function pauseCollection() {
    await chrome.alarms.clear(RESUME_ALARM);

    if (activeCollector) {
        activeCollector.requestStop();
        await setCollectState({ message: 'Mise en pause après la publication en cours…' });
        return true;
    }

    // Reprise programmée (interruption ou plafond du jour) : annulée
    const job = await LinkXPCollector.loadJob();
    if (job && ['running', 'daily_cap'].includes(job.status)) {
        await chrome.storage.local.set({ collectJob: { ...job, status: 'paused' } });
        await setCollectState({ running: false, status: 'paused', message: COLLECT_END_MESSAGES.paused });
        return true;
    }
    return false;
}

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === RESUME_ALARM) {
        resumeCollection(true).catch(error => console.error('Reprise de la collecte impossible:', error));
    }
});

// Au démarrage du service worker (Chrome relancé, sortie de veille, arrêt pour inactivité) : une collecte
// « en cours » a été interrompue et reprend seule après un délai ; au plafond du jour, elle reprend le lendemain
(async () => {
    const job = await LinkXPCollector.loadJob();
    if (activeCollector) {
        return;
    }
    if (job?.status === 'running') {
        await scheduleResume(Date.now() + linkxpRandomBetween(LINKXP_COLLECT.RESUME_DELAY_MS));
        await setCollectState({ running: true, status: 'running', message: 'Collecte interrompue : reprise automatique dans un instant…' });
        return;
    }
    if (job?.status === 'daily_cap' && !(await chrome.alarms.get(RESUME_ALARM))) {
        await scheduleResume(nextDayResumeTime());
        return;
    }
    // État d'une version précédente sans passage persisté
    const { collectState } = await chrome.storage.local.get('collectState');
    if (collectState?.running && !job) {
        await setCollectState({ running: false, ok: false, finishedAt: Date.now(), message: 'Collecte interrompue, relancez-la.' });
    }
})().catch(error => console.error('Erreur reprise de collecte:', error));

// Gestion des erreurs globales
self.addEventListener('error', (event) => {
    console.error('Erreur dans le service worker:', event.error);
});

self.addEventListener('unhandledrejection', (event) => {
    console.error('Promise rejetée:', event.reason);
});
