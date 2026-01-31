const getProfileBtn = document.getElementById('getProfileBtn');
const getPublicationsBtn = document.getElementById('getPublicationsBtn');
const addPublicationForm = document.getElementById('addPublicationForm');
const statsList = document.getElementById('statsList');
const linkAccountBtn = document.getElementById('linkAccountBtn');
const syncApiBtn = document.getElementById('syncApiBtn');
const authStatus = document.getElementById('authStatus');
const getSkillsBtn = document.getElementById('getSkillsBtn');

async function sendMessageToBackground(action, data = {}) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ action, ...data }, (response) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
            } else if (response && response.success) {
                resolve(response.data);
            } else {
                reject(new Error(response?.error || 'Erreur inconnue'));
            }
        });
    });
}

// Fonction utilitaire pour attendre la fermeture d'un onglet
function waitForTabClosure(tabId) {
    return new Promise((resolve) => {
        const checkClosed = () => {
            chrome.tabs.get(tabId, (tab) => {
                if (chrome.runtime.lastError) {
                    // L'onglet a été fermé (erreur = tab not found)
                    resolve(true);
                } else {
                    // L'onglet existe encore, vérifier à nouveau dans 1 seconde
                    setTimeout(checkClosed, 1000);
                }
            });
        };

        // Commencer à vérifier après 2 secondes (laisser le temps à l'onglet de s'ouvrir)
        setTimeout(checkClosed, 2000);
    });
}

function parseLinkedInNumber(str) {
    if (!str) return 0;

    const cleaned = str.replace(/\s/g, '').replace(',', '.');

    if (cleaned.includes('k') || cleaned.includes('K')) {
        return Math.round(parseFloat(cleaned) * 1000);
    }
    if (cleaned.includes('M')) {
        return Math.round(parseFloat(cleaned) * 1000000);
    }

    return parseInt(cleaned.replace(/[^\d]/g, '')) || 0;
}

async function linkAccount() {
    try {
        const result = await sendMessageToBackground('checkAuthStatus');
        const isLinked = result.isLinked;

        if (isLinked) {
            // Délier le compte
            const confirmed = confirm('Êtes-vous sûr de vouloir délier ce compte ?');
            if (confirmed) {
                await sendMessageToBackground('clearTokens');
                showNotification('Compte délié', 'success');
                await updateAuthStatus();
            }
            return;
        }

        // Processus de liaison simplifié
        setButtonLoading(linkAccountBtn, true);
        showNotification('Initialisation de la liaison...', 'info');

        // Étape 1: Demander device link token
        const deviceData = await sendMessageToBackground('initDeviceLinking');

        // Étape 2: Ouvrir la page de validation
        const validationUrl = `https://app.linkxp.net${deviceData.validation_url}`;
        chrome.tabs.create({ url: validationUrl, active: true });

        showNotification('Page ouverte ! Connectez-vous et validez la liaison.', 'success');
        showNotification('L\'extension se liera automatiquement après validation.', 'info');

    } catch (error) {
        console.error('Erreur liaison compte:', error);
        showNotification('Erreur: ' + error.message, 'error');
    } finally {
        setButtonLoading(linkAccountBtn, false);
    }
}

async function syncProfileToAPI(accessToken, profileData) {
    const payload = {
        followers: profileData.followers || 0,
        skills: profileData.skills || [],
        collectedAt: profileData.timestamp || new Date().toISOString()
    };

    const response = await fetch(sendMessageToBackground.getFullUrl('/linkedin/profile'), {
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
}

async function syncPublicationsToAPI(accessToken, publications) {
    // Formater les publications pour l'API
    const formattedPublications = publications.map(pub => ({
        urn: pub.urn,
        text: pub.text || '',
        author: pub.author || '',
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

    const response = await fetch(sendMessageToBackground.getFullUrl('/linkedin/publications'), {
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
}

function chunkArray(array, chunkSize) {
    const chunks = [];
    for (let i = 0; i < array.length; i += chunkSize) {
        chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
}

async function syncToAPI() {
    try {
        // TODO
        setButtonLoading(syncApiBtn, true);

        // Vérifier l'authentification
        const accessToken = await sendMessageToBackground('getValidAccessToken');

        showNotification('Synchronisation en cours...', 'info');

        // Récupérer les données locales
        const data = await chrome.storage.local.get(['profile', 'publications']);

        let syncCount = 0;

        // Synchroniser le profil
        if (data.profile) {
            await syncProfileToAPI(accessToken, data.profile);
            syncCount++;
        }

        // Synchroniser les publications (par batch de 20)
        if (data.publications && data.publications.length > 0) {
            const batches = chunkArray(data.publications, 20);

            for (const batch of batches) {
                await syncPublicationsToAPI(accessToken, batch);
                syncCount++;

                // Pause entre les batches pour respecter le rate limiting
                if (batches.length > 1) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
        }

        showNotification(`Synchronisation réussie ! (${syncCount} requêtes)`, 'success');

    } catch (error) {
        console.error('Erreur sync API:', error);

        if (error.message === 'DEVICE_LINKING_REQUIRED') {
            showNotification('Liaison requise. Veuillez lier votre compte.', 'error');
            await updateAuthStatus();
        } else if (error.message.includes('429')) {
            showNotification('Limite de débit atteinte. Réessayez dans 1 minute.', 'warning');
        } else {
            showNotification('Erreur sync: ' + error.message, 'error');
        }
    } finally {
        setButtonLoading(syncApiBtn, false);
    }
}

function setupEventListeners() {
    getProfileBtn.addEventListener('click', collectFollowersOnly);
    getSkillsBtn.addEventListener('click', collectSkillsOnly);
    getPublicationsBtn.addEventListener('click', collectPublications);
    addPublicationForm.addEventListener('submit', addPublicationManually);

    linkAccountBtn.addEventListener('click', linkAccount);
    // syncApiBtn.addEventListener('click', syncToAPI); // TODO
}

async function updateAuthStatus() {
    try {
        const result = await sendMessageToBackground('checkAuthStatus');
        const isLinked = result.isLinked;

        console.log('🔍 Debug popup authStatus:', {
            result,
            isLinked,
            typeof_isLinked: typeof isLinked
        });

        if (isLinked) {
            authStatus.innerHTML = '🟢 Compte lié';
            authStatus.className = 'auth-status linked';
            linkAccountBtn.textContent = 'Délier le compte';
            linkAccountBtn.className = 'btn btn-secondary';
            syncApiBtn.disabled = false;
        } else {
            authStatus.innerHTML = '🔴 Compte non lié';
            authStatus.className = 'auth-status not-linked';
            linkAccountBtn.textContent = 'Lier au compte LinkXP';
            linkAccountBtn.className = 'btn btn-primary';
            syncApiBtn.disabled = true;
        }
    } catch (error) {
        authStatus.innerHTML = '⚠️ Erreur';
    }
}

/**
 * ediriger vers /in/me et récupérer l'alias
 * @param tabId
 * @returns {Promise<unknown>}
 */
async function redirectToProfileAndGetAlias(tabId) {
    showNotification('Récupération de votre profil...', 'info');
    await chrome.tabs.update(tabId, { url: 'https://www.linkedin.com/in/me' });

    // Attendre que LinkedIn redirige vers le profil réel
    return new Promise((resolve) => {
        let attempts = 0;
        const maxAttempts = 20;

        const checkRedirect = async () => {
            attempts++;

            try {
                const results = await chrome.scripting.executeScript({
                    target: { tabId },
                    func: () => {
                        const aliasMatch = window.location.href.match(/\/in\/([^/?\#]+)/);
                        const currentAlias = aliasMatch ? aliasMatch[1] : null;

                        // Si on n'est plus sur /in/me, la redirection est faite
                        return {
                            alias: currentAlias !== 'me' ? currentAlias : null
                        };
                    }
                });

                const { alias } = results[0].result;

                if (alias) {
                    // Stocker l'alias
                    await chrome.storage.local.set({ userAlias: alias });
                    showNotification('Profil détecté !', 'success');
                    resolve(alias);
                    return;
                }

                if (attempts < maxAttempts) {
                    setTimeout(checkRedirect, 500);
                } else {
                    showNotification('Erreur: Impossible de récupérer votre profil', 'error');
                    resolve(null);
                }

            } catch (error) {
                if (attempts < maxAttempts) {
                    setTimeout(checkRedirect, 500);
                } else {
                    showNotification('Erreur de redirection', 'error');
                    resolve(null);
                }
            }
        };

        checkRedirect();
    });
}

// ========================================
// 2. COLLECTE PROFIL (ABONNÉS + COMPÉTENCES)
// ========================================

/**
 * Collect des abonnés
 * @param tabId
 * @returns {Promise<void>}
 */
async function performFollowersCollection(tabId) {
    const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: scrapeFollowersOnly
    });

    const followersData = results[0].result;
    if (!followersData) {
        showNotification('Erreur lors de la collecte des abonnés', 'error');
        return;
    }

    const profile = {
        followers: followersData.followers,
        collectedAt: followersData.collectedAt,
    };
    await chrome.storage.local.set({ profile });

    console.log('DEBUG 1 => performFollowersCollection');
    if (typeof loadStoredStats === 'function') {
        await loadStoredStats();
    }

    // Envoyer UNIQUEMENT les abonnés à l'API
    try {
        await sendMessageToBackground('syncFollowers', followersData);
        if (followersData.followers) {
            showNotification(`${followersData.followers} abonnés synchronisés !`, 'success');
        } else {
            showNotification(`Vous êtes à jour !`, 'success');
        }
    } catch (syncError) {
        showNotification('Erreur sync API abonnés', 'error');
        console.error('Erreur sync API:', syncError);
    }
}
async function waitForProfileLoadThenCollect(tabId) {
    let attempts = 0;
    const maxAttempts = 15;

    try {
        // Vérifier d'abord si l'alias est en storage
        const storedData = await chrome.storage.local.get(['userAlias']);
        let userAlias = storedData.userAlias;

        // Si pas d'alias, le récupérer via redirection /in/me
        if (!userAlias) {
            userAlias = await redirectToProfileAndGetAlias(tabId);
            if (!userAlias) {
                return; // Erreur déjà affichée par redirectToProfileAndGetAlias
            }
        }

        // Maintenant on a l'alias, attendre le chargement de recent-activity/all/
        const checkPageAndCollect = async () => {
            attempts++;

            try {
                const results = await chrome.scripting.executeScript({
                    target: { tabId },
                    func: () => {
                        const isOnRecentActivityPage = window.location.href.includes('/recent-activity/all/');
                        return { isOnRecentActivityPage };
                    }
                });

                const { isOnRecentActivityPage } = results[0].result;

                // Si on n'est pas sur recent-activity/all/, rediriger
                if (!isOnRecentActivityPage) {
                    const targetUrl = `https://www.linkedin.com/in/${userAlias}/recent-activity/all/`;
                    showNotification('Redirection vers la page des publications...', 'info');
                    await chrome.tabs.update(tabId, { url: targetUrl });

                    // Relancer la vérification après redirection
                    if (attempts < maxAttempts) {
                        showNotification(`Chargement... ${attempts}/${maxAttempts}`, 'info');
                        setTimeout(checkPageAndCollect, 2000);
                    }
                    return;
                }

                // On est sur la bonne page : appeler performFollowersCollection
                showNotification('Profil chargé ! Collecte des abonnés...', 'info');
                await performFollowersCollection(tabId);

            } catch (error) {
                console.error('Erreur:', error);
                if (attempts < maxAttempts) {
                    setTimeout(checkPageAndCollect, 2000);
                } else {
                    showNotification('Erreur de chargement', 'error');
                }
            }
        };

        checkPageAndCollect();

    } catch (error) {
        console.error('Erreur waitForProfileLoadThenCollect:', error);
        showNotification('Erreur: ' + error.message, 'error');
    }
}


async function redirectToProfileAndCollect(tab) {
    try {
        showNotification('Redirection vers votre profil...', 'info');

        // Rediriger vers le profil de l'utilisateur
        const profileUrl = 'https://www.linkedin.com/in/me/';
        await chrome.tabs.update(tab.id, { url: profileUrl });

        // Attendre le chargement puis collecter
        await waitForProfileLoadThenCollect(tab.id);

    } catch (error) {
        console.error('Erreur redirection profil:', error);
        showNotification('Erreur lors de la redirection', 'error');
    }
}

/**
 * Récupération des informations de base du profil
 * @returns {Promise<void>}
 */
async function collectFollowersOnly() {
    // getProfileBtn Etape 1
    try {
        setButtonLoading(getProfileBtn, true);

        const tab = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab[0].url.includes('linkedin.com')) {
            showNotification('Veuillez ouvrir LinkedIn', 'error');
            return;
        }

        const isOnProfilePage = tab[0].url.includes('linkedin.com/in/') &&
            tab[0].url.includes('/recent-activity/');

        if (isOnProfilePage) {
            // Directement sur la page profil
            await performFollowersCollection(tab[0].id);
        } else {
            // Rediriger vers la page profil de l'utilisateur
            await redirectToProfileAndCollect(tab[0]);
        }

    } catch (error) {
        console.error('Erreur collecte abonnés:', error);
        showNotification(`Erreur: ${error.message}`, 'error');
    } finally {
        setButtonLoading(getProfileBtn, false);
    }
}

// Fonction pour effectuer la collecte des compétences
async function performSkillsCollection(tabId) {
    const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: scrapeSkillsData
    });

    const skills = results[0].result;
    if (skills.length === 0) {
        showNotification('Aucune compétence trouvée', 'warning');
        return;
    }

    // Envoyer UNIQUEMENT les compétences à l'API
    try {
        await sendMessageToBackground('syncSkills', { skills });
        showNotification(`${skills.length} compétences synchronisées !`, 'success');
    } catch (syncError) {
        showNotification('Erreur sync API compétences', 'error');
        console.error('Erreur sync API:', syncError);
    }
}

// Fonction pour attendre le chargement de la page des compétences
async function waitForSkillsPageThenCollect(tabId) {
    let attempts = 0;
    const maxAttempts = 15;

    const checkPageAndCollect = async () => {
        attempts++;

        try {
            const results = await chrome.scripting.executeScript({
                target: { tabId },
                func: () => {
                    const isSkillsPage = window.location.href.includes('/details/skills/');
                    const hasSkills = document.querySelectorAll('[data-field="skill_page_skill_topic"]').length > 0;
                    const isLoaded = isSkillsPage && hasSkills;

                    return { isLoaded, isSkillsPage, hasSkills };
                }
            });

            const result = results[0].result;

            if (result.isLoaded) {
                showNotification('Page des compétences chargée ! Chargement complet...', 'info');

                // Scroll automatique pour charger toutes les compétences
                await chrome.scripting.executeScript({
                    target: { tabId },
                    func: scrollToLoadAllSkills
                });

                // Attendre que le scroll soit terminé
                await new Promise(resolve => setTimeout(resolve, 3000));

                // Collecter
                await performSkillsCollection(tabId);
                return;
            }

            if (attempts < maxAttempts) {
                showNotification(`Chargement compétences... ${attempts}/${maxAttempts}`, 'info');
                setTimeout(checkPageAndCollect, 2000);
            } else {
                showNotification('Délai dépassé. Tentative de collecte...', 'warning');
                await performSkillsCollection(tabId);
            }

        } catch (error) {
            if (attempts < maxAttempts) {
                setTimeout(checkPageAndCollect, 2000);
            } else {
                showNotification('Erreur de chargement des compétences', 'error');
            }
        }
    };

    setTimeout(checkPageAndCollect, 1000);
}

async function redirectToSkillsPageAndCollect(tab) {
    try {
        // Détecter le profil utilisateur depuis l'URL ou le DOM
        const profileMatch = tab.url.match(/linkedin\.com\/in\/([^/]+)/);

        if (!profileMatch) {
            // Extraire depuis le DOM si pas dans l'URL
            const results = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => {
                    const profileLink = document.querySelector('a.profile-card-profile-picture-container');
                    if (profileLink && profileLink.href) {
                        const match = profileLink.href.match(/linkedin\.com\/in\/([^/]+)/);
                        return match ? match[1] : null;
                    }
                    return null;
                }
            });

            const profileURI = results[0].result;
            if (!profileURI) {
                showNotification('Impossible de détecter votre profil. Allez sur votre page LinkedIn.', 'error');
                return;
            }

            const skillsUrl = `https://www.linkedin.com/in/${profileURI}/details/skills/`;
            showNotification('Redirection vers vos compétences...', 'info');
            await chrome.tabs.update(tab.id, { url: skillsUrl });
        } else {
            const skillsUrl = `https://www.linkedin.com/in/${profileMatch[1]}/details/skills/`;
            showNotification('Redirection vers vos compétences...', 'info');
            await chrome.tabs.update(tab.id, { url: skillsUrl });
        }

        // Attendre le chargement puis collecter
        await waitForSkillsPageThenCollect(tab.id);

    } catch (error) {
        console.error('Erreur redirection compétences:', error);
        showNotification('Erreur lors de la redirection', 'error');
    }
}

async function collectSkillsOnly() {
    try {
        setButtonLoading(getSkillsBtn, true);

        const tab = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab[0].url.includes('linkedin.com')) {
            showNotification('Veuillez ouvrir LinkedIn', 'error');
            return;
        }

        const isOnSkillsPage = tab[0].url.includes('/details/skills/');

        if (isOnSkillsPage) {
            // Déjà sur la page des compétences
            await performSkillsCollection(tab[0].id);
        } else {
            // Rediriger vers la page des compétences
            await redirectToSkillsPageAndCollect(tab[0]);
        }

    } catch (error) {
        console.error('Erreur collecte compétences:', error);
        showNotification(`Erreur: ${error.message}`, 'error');
    } finally {
        setButtonLoading(getSkillsBtn, false);
    }
}

// ========================================
// 3. COLLECTE PUBLICATIONS
// ========================================

async function collectPublications() {
    try {
        setButtonLoading(getPublicationsBtn, true);

        // 1) Vérifier l'authentification LinkXP
        const auth = await sendMessageToBackground('checkAuthStatus');
        // sendMessageToBackground renvoie response.data => { isLinked: true/false }
        const isLinked = !!auth?.isLinked;

        if (!isLinked) {
            showNotification('Vous devez vous connecter à LinkXP avant de collecter les publications.', 'warning');
            return;
        }

        // 2) Vérifier l'onglet actif LinkedIn
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.url.includes('linkedin.com')) {
            showNotification('Ouvrez LinkedIn pour collecter vos publications.', 'error');
            return;
        }

        const isOnActivityPage = tab.url.includes('/recent-activity/all/');

        // 3) Lancer la collecte réelle
        if (isOnActivityPage) {
            await performPublicationsCollection(tab.id);
        } else {
            await redirectToActivityPageAndCollect(tab);
        }

    } catch (error) {
        console.error('Erreur collecte publications:', error);
        showNotification('Erreur: ' + error.message, 'error');
    } finally {
        setButtonLoading(getPublicationsBtn, false);
    }
}


async function redirectToActivityPageAndCollect(tab) {
    const profileMatch = tab.url.match(/linkedin\.com\/in\/([^\/\?]+)/);
    if (!profileMatch) {
        try {
            const results = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => {
                    const profilePictureLink = document.querySelector('a.profile-card-profile-picture-container');
                    if (profilePictureLink && profilePictureLink.href) {
                        const match = profilePictureLink.href.match(/linkedin\.com\/in\/([^\/\?]+)/);
                        if (match) {
                            return match[1];
                        }
                    }
                }
            });

            const profileURI = results[0].result;

            if (profileURI) {
                const targetUrl = `https://www.linkedin.com/in/${profileURI}/recent-activity/all/`;
                showNotification('Profil détecté ! Redirection vers les publications...', 'info');

                await chrome.tabs.update(tab.id, { url: targetUrl });
                await waitForPageLoadThenCollect(tab.id);
                return;
            }

        } catch (error) {
            console.error('Erreur extraction profil DOM:', error);
        }
    }

    const targetUrl = `https://www.linkedin.com/in/${profileMatch[1]}/recent-activity/all/`;
    showNotification('Redirection vers la page des publications...', 'info');

    await chrome.tabs.update(tab.id, { url: targetUrl });
    await waitForPageLoadThenCollect(tab.id);
}

async function waitForPageLoadThenCollect(tabId) {
    let attempts = 0;
    const maxAttempts = 20;

    const checkPageAndCollect = async () => {
        attempts++;

        try {
            const results = await chrome.scripting.executeScript({
                target: { tabId },
                func: checkActivityPageLoaded
            });

            const isLoaded = results[0].result.isLoaded;

            if (isLoaded) {
                showNotification('Page chargée ! Collecte des publications...', 'success');
                await performPublicationsCollection(tabId);
                return;
            }

            if (attempts < maxAttempts) {
                showNotification(`Chargement... (${attempts}/${maxAttempts})`, 'info');
                setTimeout(checkPageAndCollect, 2000);
            } else {
                showNotification('Délai dépassé. Tentative de collecte...', 'warning');
                await performPublicationsCollection(tabId);
            }

        } catch (error) {
            if (attempts < maxAttempts) {
                setTimeout(checkPageAndCollect, 2000);
            } else {
                showNotification('Erreur de chargement', 'error');
            }
        }
    };

    setTimeout(checkPageAndCollect, 1000);
}

async function performPublicationsCollection(tabId) {
    const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: scrapePublicationsData
    });

    const publications = results[0].result;
    if (!publications || publications.length === 0) {
        showNotification('Aucune publication trouvée', 'warning');
        return;
    }

    // Sauvegarder localement
    await saveToStorage('publications', publications);

    // Envoyer à l'API immédiatement
    try {
        await sendMessageToBackground('syncPublications', { publications });
        showNotification(`${publications.length} publications collectées et synchronisées !`, 'success');
    } catch (syncError) {
        showNotification(`${publications.length} publications collectées localement.`, 'warning');
        console.error('Erreur sync API publications:', syncError);
    }

    console.log('DEBUG 2 => performPublicationsCollection');
    await loadStoredStats();
}

// ========================================
// 4. FONCTIONS DE SCRAPING (EXÉCUTÉES SUR LA PAGE)
// ========================================

function scrollToLoadAllSkills() {
    return new Promise((resolve) => {
        let lastHeight = document.body.scrollHeight;
        let scrollCount = 0;
        const maxScrolls = 10;

        function scroll() {
            window.scrollTo(0, document.body.scrollHeight);
            scrollCount++;

            setTimeout(() => {
                let newHeight = document.body.scrollHeight;
                if (newHeight > lastHeight && scrollCount < maxScrolls) {
                    lastHeight = newHeight;
                    scroll();
                } else {
                    window.scrollTo(0, 0); // Retour en haut
                    resolve();
                }
            }, 1500);
        }

        scroll();
    });
}

/**
 * Scrape le nombre de follower
 * @returns {{followers: number, collectedAt: string}|null}
 */
function scrapeFollowersOnly() {
    try {
        const followersElement = document.querySelector('aside .link-without-visited-state')
        let followers = 0;

        if (followersElement) {
            const text = followersElement.textContent.trim();

            if (typeof text === 'string') {
                followers = +text
            } else {
                const match = text.match(/(\d+[\d\s,]*)/);
                if (match) {
                    followers = parseInt(match[1].replace(/[\s,]/g, ''), 10) || 0;
                }
            }
        }

        return {
            followers: followers,
            collectedAt: new Date().toISOString()
        };
    } catch (error) {
        console.error('Erreur scraping abonnés:', error);
        return null;
    }
}

function scrapeProfileData() {
    const data = {
        timestamp: new Date().toISOString(),
        type: 'profile',
        followers: 0,
        skills: []
    };

    try {
        const followersElement = document.querySelector('.ember-view.link-without-visited-state .t-bold');
        if (followersElement) {
            const text = followersElement.textContent.trim();
            const match = text.match(/(\d[\d\s,\.]*)\s*abonné/i) ||
                text.match(/(\d[\d\s,\.]*)\s*follower/i) ||
                text.match(/(\d[\d\s,\.]*)\s*connexion/i) ||
                text.match(/(\d[\d\s,\.]*)/);

            if (match) {
                data.followers = parseInt(match[1].replace(/[\s,\.]/g, '')) || 0;
            }
        }

        return data;
    } catch (error) {
        console.error('Erreur scraping profil:', error);
        return null;
    }
}

function scrapeSkillsData() {
    const skills = [];

    try {
        const skillElements = document.querySelectorAll('[data-field="skill_page_skill_topic"]');

        skillElements.forEach((skillElement) => {
            const firstSpan = skillElement.querySelector('span:first-child') || skillElement.querySelector('span');
            const skillName = firstSpan ? firstSpan.textContent.trim() : skillElement.textContent.trim();

            if (!skillName || skillName.length < 1) return;

            const parentElement = skillElement.closest('.pvs-list__item--line-separated') ||
                skillElement.closest('.pvs-entity') ||
                skillElement.closest('.artdeco-list__item');

            let experienceCount = 0;
            if (parentElement) {
                const subComponents = parentElement.querySelector('.pvs-entity__sub-components');
                if (subComponents) {
                    experienceCount = subComponents.querySelectorAll('li').length;
                }
            }

            skills.push({
                name: skillName,
                experienceCount: experienceCount,
                hasExperiences: experienceCount > 0
            });
        });

        return skills;
    } catch (error) {
        console.error('Erreur scraping compétences:', error);
        return [];
    }
}

function scrapePublicationsData() {

    // Fonction parseLinkedInNumber directement dans le contexte injecté
    const parseLinkedInNumber = (str) => {
        if (!str) return 0;
        const cleaned = str.replace(/\s/g, '').replace(',', '.');

        if (cleaned.includes('k') || cleaned.includes('K')) {
            return Math.round(parseFloat(cleaned) * 1000);
        }

        if (cleaned.includes('M')) {
            return Math.round(parseFloat(cleaned) * 1000000);
        }

        return parseInt(cleaned.replace(/[^\d]/g, '')) || 0;
    };

    const publications = [];

    try {
        const postElements = document.querySelectorAll('.feed-shared-update-v2');

        postElements.forEach((post, index) => {
            if (index >= 20) return;

            const dataUrn = post.getAttribute('data-urn');
            if (!dataUrn) {
                return; // Ignorer si pas d'URN
            }

            // Détection republication avec nouveau sélecteur
            const headerElement = post.querySelector('.update-components-header');
            let isRepost = false;

            if (headerElement) {
                const headerText = headerElement.textContent.trim();
                isRepost = headerText.includes('a republié ceci') ||
                    headerText.includes('has reposted this') ||
                    headerText.includes('reposted this');

            }

            // Date de publication avec sélecteur spécifique
            const dateElement = post.querySelector('.update-components-actor__container .update-components-actor__meta .update-components-actor__sub-description > span:first-child');
            let publicationDate = new Date().toISOString();
            let rawDateText = '';

            if (dateElement) {
                rawDateText = dateElement.textContent.trim();

                // Nettoyer le texte (supprimer les "•", "Modifié", etc.)
                const cleanText = rawDateText.replace(/•.*$/, '').trim(); // Tout supprimer après le premier •
                const now = new Date();
                // Patterns de reconnaissance
                if (cleanText.match(/^\d+\s*min?\.?$/)) {
                    // "5 min", "30 min."
                    const minutes = parseInt(cleanText.match(/\d+/)[0]);
                    const date = new Date(now.getTime() - (minutes * 60 * 1000));
                    publicationDate = date.toISOString();
                }

                if (cleanText.match(/^\d+\s*h\.?$/)) {
                    // "2 h", "5 h."
                    const hours = parseInt(cleanText.match(/\d+/)[0]);
                    const date = new Date(now.getTime() - (hours * 60 * 60 * 1000));
                    publicationDate = date.toISOString();
                }

                if (cleanText.match(/^\d+\s*j\.?$/)) {
                    // "3 j", "1 j."
                    const days = parseInt(cleanText.match(/\d+/)[0]);
                    const date = new Date(now.getTime() - (days * 24 * 60 * 60 * 1000));
                    publicationDate = date.toISOString();
                }

                if (cleanText.match(/^\d+\s*sem\.?$/)) {
                    // "1 sem", "2 sem."
                    const weeks = parseInt(cleanText.match(/\d+/)[0]);
                    const date = new Date(now.getTime() - (weeks * 7 * 24 * 60 * 60 * 1000));
                    publicationDate = date.toISOString();
                }

                if (cleanText.match(/^\d+\s*mois\.?$/)) {
                    // "1 mois", "3 mois."
                    const months = parseInt(cleanText.match(/\d+/)[0]);
                    const date = new Date(now.getFullYear(), now.getMonth() - months, now.getDate());
                    publicationDate = date.toISOString();
                }

                if (cleanText.match(/^\d+\s*ans?\.?$/)) {
                    // "1 an", "2 ans"
                    const years = parseInt(cleanText.match(/\d+/)[0]);
                    const date = new Date(now.getFullYear() - years, now.getMonth(), now.getDate());
                    publicationDate = date.toISOString();
                }
            }

            // Texte de la publication (inchangé)
            const textElement = post.querySelector('.feed-shared-update-v2__description, .break-words');
            const postText = textElement ? textElement.textContent.trim().substring(0, 300) : '';

            // Auteur de la publication (inchangé)
            const authorElement = post.querySelector('.feed-shared-actor__name, .update-components-actor__name');
            const authorName = authorElement ? authorElement.textContent.trim() : '';

            // Stats (utilise la fonction améliorée)
            function extractPostStats(post) {
                const stats = { reactions: 0, comments: 0, reposts: 0 };

                try {
                    // Réactions
                    const reactionSelectors = [
                        '.social-details-social-counts__social-proof-fallback-number',
                        '.social-details-social-counts__reactions-count',
                        '.social-details-social-counts__item:first-child span',
                        '[aria-label*="réaction"] span',
                        '[aria-label*="reaction"] span'
                    ];

                    let reactionsEl = null;
                    for (const selector of reactionSelectors) {
                        reactionsEl = post.querySelector(selector);
                        if (reactionsEl && reactionsEl.textContent.match(/\d/)) break;
                    }

                    if (reactionsEl) {
                        const text = reactionsEl.textContent.trim();
                        const match = text.match(/(\d[\d\s,\.]*)/);
                        if (match) {
                            stats.reactions = parseLinkedInNumber(match[1]);
                        }
                    }

                    // Commentaires
                    const commentSelectors = [
                        '.social-details-social-counts__comments',
                        '.social-details-social-counts__item:nth-child(2) span',
                        '[aria-label*="commentaire"] span',
                        '[aria-label*="comment"] span'
                    ];

                    let commentsEl = null;
                    for (const selector of commentSelectors) {
                        commentsEl = post.querySelector(selector);
                        if (commentsEl && commentsEl.textContent.match(/\d/)) break;
                    }

                    if (commentsEl) {
                        const text = commentsEl.textContent.trim();
                        const match = text.match(/(\d[\d\s,\.]*)/);
                        if (match) {
                            stats.comments = parseLinkedInNumber(match[1]);
                        }
                    }

                    // Republications
                    const nonReactionDetails = post.querySelector('[data-non-reaction-details]');
                    if (nonReactionDetails) {
                        const listItems = nonReactionDetails.querySelectorAll('li');
                        if (listItems.length >= 2) {
                            const repostLi = listItems[listItems.length - 1];
                            const repostSpan = repostLi.querySelector('span');
                            if (repostSpan) {
                                const repostsText = repostSpan.textContent.trim();
                                const match = repostsText.match(/(\d[\d\s,\.]*)/);
                                if (match) {
                                    stats.reposts = parseLinkedInNumber(match[1]);
                                }
                            }
                        }
                    }

                    // Fallback pour les republications
                    if (stats.reposts === 0) {
                        let repostsEl = post.querySelector('.social-details-social-counts__item--reposts');
                        if (!repostsEl) {
                            repostsEl = post.querySelector('[aria-label*="republication"], [aria-label*="repost"]');
                        }
                        if (!repostsEl) {
                            // Fallback vers le texte contenant "republication"
                            const socialDetails = post.querySelector('.social-details-social-counts');
                            if (socialDetails) {
                                const spans = socialDetails.querySelectorAll('span');
                                spans.forEach(span => {
                                    const text = span.textContent.toLowerCase();
                                    if ((text.includes('republication') || text.includes('repost')) && !repostsEl) {
                                        const match = span.textContent.match(/(\d[\d\s,\.]*)/);
                                        if (match) {
                                            repostsEl = span;
                                        }
                                    }
                                });
                            }
                        }

                        if (repostsEl) {
                            const text = repostsEl.textContent.trim();
                            const match = text.match(/(\d[\d\s,\.]*)/);
                            if (match) {
                                stats.reposts = parseLinkedInNumber(match[1]);
                            }
                        }
                    }

                    return stats;
                } catch (error) {
                    console.error('Erreur extraction stats:', error);
                    return stats;
                }
            }

            const stats = extractPostStats(post);
            publications.push({
                id: dataUrn, // URN complet
                urn: dataUrn, // Alias pour clarté
                text: postText,
                author: authorName,
                type: isRepost ? 'repost' : 'original',
                publishedDate: publicationDate, // Remplace timestamp
                rawDateText: rawDateText, // Garder le texte original pour debug
                collectedAt: new Date().toISOString(), // Moment de la collecte
                stats: stats
            });
        });

        return publications;
    } catch (error) {
        console.error('Erreur scraping publications:', error);
        return [];
    }
}

function checkActivityPageLoaded() {
    try {
        const hasActivityUrl = window.location.href.includes('/recent-activity/all/');
        const hasPublications = document.querySelectorAll('.feed-shared-update-v2').length > 0;
        const hasActivityContainer = document.querySelector('.scaffold-finite-scroll__content') !== null;
        const noSpinner = !document.querySelector('.artdeco-spinner, .loading, [role="progressbar"]');

        const isLoaded = hasActivityUrl && (hasPublications || hasActivityContainer) && noSpinner;

        return { isLoaded };
    } catch (error) {
        return { isLoaded: false };
    }
}

// ========================================
// 5. GESTION DES DONNÉES
// ========================================

async function saveToStorage(key, data) {
    try {
        await chrome.storage.local.set({ [key]: data });
    } catch (error) {
        console.error('Erreur sauvegarde:', error);
    }
}

async function loadStoredStats() {
    try {
        const data = await chrome.storage.local.get(null);
        statsList.innerHTML = '';

        if (Object.keys(data).length === 0) {
            statsList.innerHTML = '<div class="empty-state">Aucune donnée collectée</div>';
            return;
        }

        console.log('loadStoredStats', data);

        if (data.profile) {
            const profileCard = createStatCard('Profil', data.profile);
            statsList.appendChild(profileCard);
        }

        if (data.publications && data.publications.length > 0) {
            const publicationsCard = createStatCard('Publications', data.publications);
            statsList.appendChild(publicationsCard);
        }

    } catch (error) {
        console.error('Erreur chargement stats:', error);
    }
}

function createStatCard(type, data) {
    const card = document.createElement('div');
    card.className = 'stat-card';

    let content = `
    <div class="stat-header">
      <span class="stat-type">${type}</span>
    </div>
    <div class="stat-content">`;

    if (type === 'Profil') {
        content += `<p><strong>Abonnés:</strong> ${data.followers || 0}</p>`;

        if (data.skills && data.skills.length > 0) {
            const totalSkills = data.skills.length;
            const skillsWithExperience = data.skills.filter(skill => skill.hasExperiences).length;
            content += `<p><strong>Compétences:</strong> ${totalSkills}</p>`;
            content += `<p><strong>Avec expériences:</strong> ${skillsWithExperience}</p>`;
        }
    } else if (type === 'Publications') {
        if (Array.isArray(data)) {
            const originalPosts = data.filter(p => !p.isRepost).length;
            const reposts = data.filter(p => p.isRepost).length;
            const totalStats = data.reduce((sum, p) => {
                const stats = p.stats || { reactions: 0, comments: 0, reposts: 0 };
                return {
                    reactions: sum.reactions + (parseInt(stats.reactions) || 0),
                    comments: sum.comments + (parseInt(stats.comments) || 0),
                    reposts: sum.reposts + (parseInt(stats.reposts) || 0)
                };
            }, { reactions: 0, comments: 0, reposts: 0 });

            content += `
              <p><strong>Total:</strong> ${data.length} publications collectées</p>
              <p><strong>Originales:</strong> ${originalPosts}</p>
              <p><strong>Republications:</strong> ${reposts}</p>
              <p><strong>👍 Réactions totales:</strong> ${totalStats.reactions}</p>
              <p><strong>💬 Commentaires totaux:</strong> ${totalStats.comments}</p>
              <p><strong>🔄 Republications totales:</strong> ${totalStats.reposts}</p>
            `;

            // Afficher quelques exemples de dates
            const recentPosts = data.slice(0, 3);
            if (recentPosts.length > 0) {
                content += `<p><strong>Publications récentes:</strong></p>`;
                recentPosts.forEach((post, i) => {
                    const shortUrn = post.urn ? post.urn.split(':').pop().substring(0, 20) + '...' : 'N/A';

                    // Formater publishedDate au lieu de rawDateText
                    const publishedDate = post.publishedDate ?
                        new Date(post.publishedDate).toLocaleDateString('fr-FR', {
                            day: '2-digit',
                            month: '2-digit',
                            year: 'numeric'
                        }) : 'Date inconnue';

                    content += `<p style="font-size:12px; margin-left:10px;">• Le ${publishedDate} (ID : ${shortUrn})</p>`;
                });
                if (data.length > 3) {
                    content += `<p style="font-size:12px; margin-left:10px; color: #666;">• ... et ${data.length - 3} autres publications</p>`;
                }
            }
        }
    }

    content += '</div>';
    card.innerHTML = content;
    return card;
}

// ========================================
// 6. UTILITAIRES UI
// ========================================

function setButtonLoading(button, isLoading) {
    if (isLoading) {
        button.disabled = true;
        button.classList.add('loading');
        button.textContent = 'Chargement...';
    } else {
        button.disabled = false;
        button.classList.remove('loading');
        button.textContent = button.id === 'getProfileBtn'
            ? 'Récupérer le profil'
            : 'Récupérer mes publications';
    }
}

function showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.textContent = message;

    document.body.appendChild(notification);

    setTimeout(() => {
        notification.remove();
    }, 3000);
}

// Fonction manquante pour l'ajout manuel (conservée pour la compatibilité)
async function addPublicationManually(e) {
    e.preventDefault();
    showNotification('Fonctionnalité à implémenter', 'info');
}

// Fonction debug pour inspecter le storage
async function debugStorage() {
    try {
        const data = await chrome.storage.local.get(null);
        console.log('📊 Debug Storage:', data);

        if (data.publications) {
            console.log('📝 Publications sample:', data.publications.slice(0, 2));

            // Vérifier les stats
            data.publications.forEach((pub, index) => {
                if (index < 3) { // Premier 3 posts seulement
                    console.log(`Post ${index}:`, {
                        urn: pub.urn,
                        stats: pub.stats,
                        reactions: pub.stats?.reactions,
                        comments: pub.stats?.comments,
                        reposts: pub.stats?.reposts
                    });
                }
            });
        }

        return data;
    } catch (error) {
        console.error('Erreur debug storage:', error);
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    await loadStoredStats();
    await updateAuthStatus();
    setupEventListeners();
});

// À appeler dans setupEventListeners()
// Ajouter un listener pour la combinaison Ctrl+Shift+D
document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'D') {
        debugStorage();
    }
});
