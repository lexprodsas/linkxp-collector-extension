// background.js - Service Worker pour l'extension LinkXP

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
                apiUrl: 'https://votre-domaine.com/api/linkedin-stats',
                apiKey: '',
                autoSync: false
            }
        });

        // Ouvrir la page d'accueil (optionnel)
        // chrome.tabs.create({ url: 'https://linkxp.com/welcome' });
    }

    if (details.reason === 'update') {
        console.log('LinkXP mis à jour !');
    }
});

// Écouter les messages des content scripts et popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log('Message reçu:', request);

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

        default:
            sendResponse({ success: false, error: 'Action inconnue' });
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

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'cleanupOldData') {
        cleanupOldData();
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
