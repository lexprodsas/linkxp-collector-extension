const getSkillsBtn = document.getElementById('getSkillsBtn');
const getPublicationsBtn = document.getElementById('getPublicationsBtn');
const collectStatus = document.getElementById('collectStatus');
const linkAccountBtn = document.getElementById('linkAccountBtn');
const authStatus = document.getElementById('authStatus');

const BUTTON_LABELS = {
    getPublicationsBtn: 'Collecter mes publications',
    getSkillsBtn: 'Collecter mes compétences',
};

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

function setupEventListeners() {
    getSkillsBtn.addEventListener('click', collectSkillsOnly);
    getPublicationsBtn.addEventListener('click', collectPublications);
    linkAccountBtn.addEventListener('click', linkAccount);
}

async function updateAuthStatus() {
    try {
        const result = await sendMessageToBackground('checkAuthStatus');
        const isLinked = result.isLinked;

        if (isLinked) {
            authStatus.innerHTML = '🟢 Compte lié';
            authStatus.className = 'auth-status linked';
            linkAccountBtn.textContent = 'Délier le compte';
            linkAccountBtn.className = 'btn btn-secondary';
        } else {
            authStatus.innerHTML = '🔴 Compte non lié';
            authStatus.className = 'auth-status not-linked';
            linkAccountBtn.textContent = 'Lier au compte LinkXP';
            linkAccountBtn.className = 'btn btn-primary';
        }
    } catch (error) {
        authStatus.innerHTML = '⚠️ Erreur';
    }
}

// ========================================
// COLLECTE DES PUBLICATIONS
// Exécutée par le service worker (collector.js) : elle continue si la popup se ferme.
// ========================================

async function collectPublications() {
    try {
        const { started } = await sendMessageToBackground('startCollection');
        if (!started) {
            showNotification('Une collecte est déjà en cours.', 'info');
        }
    } catch (error) {
        if (error.message === 'DEVICE_LINKING_REQUIRED') {
            showNotification('Liaison requise. Veuillez lier votre compte.', 'error');
            await updateAuthStatus();
        } else {
            showNotification('Erreur: ' + error.message, 'error');
        }
    }
}

function renderCollectState(state) {
    const running = !!state?.running;
    getPublicationsBtn.disabled = running;
    getPublicationsBtn.textContent = running ? 'Collecte en cours…' : BUTTON_LABELS.getPublicationsBtn;

    if (!state) {
        collectStatus.innerHTML = '<div class="empty-state">Aucune collecte pour le moment</div>';
        return;
    }

    const lines = [];
    if (running) {
        lines.push(`<p>${escapeHtml(state.message || 'Collecte en cours…')}</p>`);
        lines.push('<p style="font-size:12px; color:#666;">Vous pouvez fermer cette fenêtre, la collecte continue.</p>');
    } else {
        const date = state.finishedAt ? new Date(state.finishedAt).toLocaleString('fr-FR') : '';
        lines.push(`<p><strong>${state.ok ? '✅' : '⚠️'} ${escapeHtml(state.message || '')}</strong></p>`);
        if (state.summary) {
            const s = state.summary;
            if (s.inventory) lines.push(`<p>${s.inventory} publications, dont ${s.originals} originales</p>`);
            if (s.detailed) lines.push(`<p>${s.detailed} posts mis à jour en détail</p>`);
            if (s.followers !== null && s.followers !== undefined) lines.push(`<p>${s.followers} abonnés</p>`);
        }
        if (date) lines.push(`<p style="font-size:12px; color:#666;">${date}</p>`);
    }
    collectStatus.innerHTML = lines.join('');
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
}

// ========================================
// COLLECTE DES COMPÉTENCES (page /details/skills/)
// ========================================

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

// ========================================
// UTILITAIRES UI
// ========================================

function setButtonLoading(button, isLoading) {
    if (isLoading) {
        button.dataset.label = button.textContent;
    }
    button.disabled = isLoading;
    button.classList.toggle('loading', isLoading);
    button.textContent = isLoading ? 'Chargement...' : (button.dataset.label || BUTTON_LABELS[button.id] || '');
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

// Bouton mis en évidence quand la popup est ouverte depuis l'écran de constats (ou juste après, à la main)
const POPUP_FOCUS_TTL = 2 * 60 * 1000;
const POPUP_FOCUS_HINTS = {
    link: "Cliquez ici pour lier l'extension à votre compte LinkXP",
    relink: "Extension liée à un autre compte : cliquez ici pour la délier, puis liez-la à votre compte",
    collect: 'Cliquez ici pour importer vos publications',
};

async function applyPopupFocus() {
    const { popupFocus } = await chrome.storage.local.get('popupFocus');
    if (!popupFocus || Date.now() - popupFocus.at > POPUP_FOCUS_TTL) {
        return;
    }
    await chrome.storage.local.remove('popupFocus');

    const button = popupFocus.target === 'collect' ? getPublicationsBtn : linkAccountBtn;
    const hint = document.createElement('p');
    hint.className = 'focus-hint';
    hint.textContent = '👇 ' + POPUP_FOCUS_HINTS[popupFocus.target];
    button.parentNode.insertBefore(hint, button);
    button.classList.add('focus-target');
    button.scrollIntoView({ block: 'center' });
}

document.addEventListener('DOMContentLoaded', async () => {
    await updateAuthStatus();
    setupEventListeners();
    await applyPopupFocus();

    const { collectState } = await chrome.storage.local.get('collectState');
    renderCollectState(collectState);
});

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.collectState) {
        renderCollectState(changes.collectState.newValue);
    }
});
