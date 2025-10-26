// popup.js - Gestion de l'interface popup de l'extension

console.log('LinkXP Popup loaded');

// Références aux éléments DOM
const getProfileBtn = document.getElementById('getProfileBtn');
const getPublicationsBtn = document.getElementById('getPublicationsBtn');
const addPublicationForm = document.getElementById('addPublicationForm');
const publicationUrlInput = document.getElementById('publicationUrl');
const statsList = document.getElementById('statsList');

// Initialisation au chargement
document.addEventListener('DOMContentLoaded', () => {
    loadStoredStats();
    setupEventListeners();
});

// Configuration des écouteurs d'événements
function setupEventListeners() {
    getProfileBtn.addEventListener('click', collectProfileStats);
    getPublicationsBtn.addEventListener('click', collectPublications);
    addPublicationForm.addEventListener('submit', addPublicationManually);
}

// Collecte des statistiques du profil
async function collectProfileStats() {
    try {
        setButtonLoading(getProfileBtn, true);

        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

        if (!tab.url.includes('linkedin.com')) {
            showNotification('Veuillez ouvrir LinkedIn', 'error');
            return;
        }

        // Vérifier si on est sur la page des compétences ou le profil principal
        if (tab.url.includes('/details/skills/')) {
            // On est sur la page des compétences : collecter uniquement les compétences
            await collectSkillsOnly(tab.id);
        } else if (tab.url.includes('/in/')) {
            // On est sur le profil principal : collecter abonnés + proposer compétences
            await collectProfileAndSkills(tab.id);
        } else {
            showNotification('Veuillez aller sur votre profil LinkedIn', 'error');
        }

    } catch (error) {
        console.error('Erreur collecte profil:', error);
        showNotification('Erreur: ' + error.message, 'error');
    } finally {
        setButtonLoading(getProfileBtn, false);
    }
}

function scrapeProfileDataMain() {
    const data = {
        timestamp: new Date().toISOString(),
        type: 'profile',
        followers: 0,
        skills: [] // Sera rempli plus tard depuis la page des compétences
    };

    try {
        // Collecte des abonnés avec ton sélecteur
        const followersElement = document.querySelector('.ember-view.link-without-visited-state .t-bold');
        if (followersElement) {
            const text = followersElement.textContent.trim();
            console.log('Texte trouvé pour followers:', text);

            let match = text.match(/(\d[\d\s,\.]*)\s*abonné/i) ||
                text.match(/(\d[\d\s,\.]*)\s*follower/i) ||
                text.match(/(\d[\d\s,\.]*)\s*connexion/i) ||
                text.match(/(\d[\d\s,\.]*)/);

            if (match) {
                const cleanNumber = match[1].replace(/[\s,\.]/g, '');
                data.followers = parseInt(cleanNumber) || 0;
                console.log('Nombre d\'abonnés trouvé:', data.followers);
            }
        } else {
            console.log('Élément followers non trouvé');

            // Sélecteurs alternatifs
            const alternativeSelectors = [
                '.pv-text-details__left-panel .t-bold',
                '.text-body-medium.t-bold',
                '.pv-top-card--experience-list-item .t-bold'
            ];

            for (const selector of alternativeSelectors) {
                const element = document.querySelector(selector);
                if (element && (element.textContent.includes('abonné') || element.textContent.includes('connexion'))) {
                    const text = element.textContent.trim();
                    const match = text.match(/(\d[\d\s,\.]*)/);
                    if (match) {
                        const cleanNumber = match[1].replace(/[\s,\.]/g, '');
                        data.followers = parseInt(cleanNumber) || 0;
                        console.log(`Followers trouvé avec ${selector}:`, data.followers);
                        break;
                    }
                }
            }
        }

        console.log('Données profil collectées:', data);
        return data;

    } catch (error) {
        console.error('Erreur scraping profil principal:', error);
        return null;
    }
}

async function collectProfileAndSkills(tabId) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId },
            func: scrapeProfileDataMain
        });

        const profileData = results[0].result;

        if (profileData) {
            await saveToStorage('profile', profileData);
            showNotification('Profil collecté ! Ouverture de la page compétences...', 'success');
            await loadStoredStats();

            await chrome.storage.local.set({ autoCollectSkills: true });

            // Ouvrir la page des compétences
            const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            const profileMatch = currentTab.url.match(/linkedin\.com\/in\/([^\/]+)/);

            if (profileMatch) {
                const skillsUrl = `https://www.linkedin.com/in/${profileMatch[1]}/details/skills/`;

                await chrome.tabs.create({ url: skillsUrl });

                showNotification('Page des compétences ouverte ! Collecte automatique en cours...', 'info');
            }
        } else {
            showNotification('Erreur lors de la collecte du profil', 'error');
        }

    } catch (error) {
        console.error('Erreur collecte profil principal:', error);
        showNotification('Erreur lors de la collecte', 'error');
    }
}

async function collectSkillsOnly(tabId) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId },
            func: scrapeSkillsFromPage
        });

        const skills = results[0].result || [];

        if (skills.length > 0) {
            // Récupérer les données existantes du profil
            const existingData = await chrome.storage.local.get('profile');

            const profileData = {
                ...existingData.profile,
                timestamp: new Date().toISOString(),
                type: 'profile',
                skills: skills
            };

            await saveToStorage('profile', profileData);
            showNotification(`${skills.length} compétences collectées !`, 'success');
            loadStoredStats();
        } else {
            showNotification('Aucune compétence trouvée sur cette page', 'warning');
        }

    } catch (error) {
        console.error('Erreur collecte compétences:', error);
        showNotification('Erreur lors de la collecte des compétences', 'error');
    }
}

// Collecte des publications récentes
async function collectPublications() {
    try {
        setButtonLoading(getPublicationsBtn, true);

        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

        if (!tab.url.includes('linkedin.com')) {
            showNotification('Veuillez ouvrir LinkedIn', 'error');
            return;
        }

        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: scrapePublications
        });

        const publications = results[0].result;

        if (publications && publications.length > 0) {
            await saveToStorage('publications', publications);
            showNotification(`${publications.length} publications collectées !`, 'success');
            loadStoredStats();
        } else {
            showNotification('Aucune publication trouvée', 'warning');
        }

    } catch (error) {
        console.error('Erreur collecte publications:', error);
        showNotification('Erreur: ' + error.message, 'error');
    } finally {
        setButtonLoading(getPublicationsBtn, false);
    }
}

// Ajout manuel d'une publication à suivre
async function addPublicationManually(e) {
    e.preventDefault();

    const url = publicationUrlInput.value.trim();

    if (!url.includes('linkedin.com')) {
        showNotification('URL LinkedIn invalide', 'error');
        return;
    }

    try {
        // Ouvrir l'URL et collecter les stats
        const newTab = await chrome.tabs.create({ url, active: false });

        // Attendre le chargement
        await new Promise(resolve => setTimeout(resolve, 3000));

        const results = await chrome.scripting.executeScript({
            target: { tabId: newTab.id },
            func: scrapePostStats
        });

        const postData = results[0].result;

        if (postData) {
            await saveToStorage('trackedPosts', postData, true);
            showNotification('Publication ajoutée au suivi !', 'success');
            loadStoredStats();
            publicationUrlInput.value = '';
            chrome.tabs.remove(newTab.id);
        }

    } catch (error) {
        console.error('Erreur ajout publication:', error);
        showNotification('Erreur: ' + error.message, 'error');
    }
}

function scrapeSkillsFromPage() {
    const skills = [];

    try {
        console.log('Scraping détaillé des compétences...');

        // Utiliser ton sélecteur spécifique
        const skillElements = document.querySelectorAll('[data-field="skill_page_skill_topic"]');

        console.log(`${skillElements.length} compétences trouvées avec [data-field="skill_page_skill_topic"]`);

        skillElements.forEach((skillElement, index) => {
            try {
                // Nom de la compétence
                const firstSpan = skillElement.querySelector('span:first-child') ||
                    skillElement.querySelector('span:first-of-type') ||
                    skillElement.querySelector('span');
                const skillName = firstSpan ? firstSpan.textContent.trim() : skillElement.textContent.trim();

                if (!skillName || skillName.length < 1) {
                    return; // Ignorer les compétences vides
                }

                // Remonter au parent pour trouver les expériences
                let parentElement = skillElement.closest('.pvs-list__item--line-separated') ||
                    skillElement.closest('.pvs-entity') ||
                    skillElement.closest('.artdeco-list__item');

                let experienceCount = 0;

                if (parentElement) {
                    // Chercher .pvs-entity__sub-components li
                    const subComponents = parentElement.querySelector('.pvs-entity__sub-components');

                    if (subComponents) {
                        const experienceItems = subComponents.querySelectorAll('li');
                        experienceCount = experienceItems.length;
                        console.log(`Compétence "${skillName}": ${experienceCount} expériences`);
                    }
                }

                // Ajouter la compétence avec ses détails
                const skillData = {
                    name: skillName,
                    experienceCount: experienceCount,
                    hasExperiences: experienceCount > 0
                };

                skills.push(skillData);
                console.log(`Compétence ajoutée:`, skillData);

            } catch (error) {
                console.error(`Erreur lors du traitement de la compétence ${index}:`, error);
            }
        });

        // Fallback si aucune compétence trouvée
        if (skills.length === 0) {
            console.log('Fallback vers sélecteurs alternatifs...');

            const fallbackElements = document.querySelectorAll('.artdeco-list__item .mr1.t-bold span');

            fallbackElements.forEach(element => {
                const skillName = element.textContent.trim();
                if (skillName && skillName.length > 1 && skillName.length < 100) {
                    skills.push({
                        name: skillName,
                        experienceCount: 0,
                        hasExperiences: false
                    });
                }
            });
        }

        console.log('Compétences finales collectées:', skills);
        return skills;

    } catch (error) {
        console.error('Erreur scraping compétences:', error);
        return [];
    }
}

// Scraping des publications
function scrapePublications() {
    const publications = [];

    try {
        const postElements = document.querySelectorAll('.feed-shared-update-v2');

        postElements.forEach((post, index) => {
            if (index >= 10) return; // Limiter à 10 publications

            const postLink = post.querySelector('a[href*="/posts/"]');
            const postText = post.querySelector('.feed-shared-update-v2__description')?.textContent.trim();

            if (postLink) {
                publications.push({
                    url: postLink.href,
                    text: postText?.substring(0, 100) + '...' || 'Sans texte',
                    timestamp: new Date().toISOString()
                });
            }
        });

        return publications;
    } catch (error) {
        console.error('Erreur scraping publications:', error);
        return [];
    }
}

// Scraping des statistiques d'une publication
function scrapePostStats() {
    const data = {
        timestamp: new Date().toISOString(),
        type: 'post',
        url: window.location.href,
        stats: {
            impressions: 0,
            reach: 0,
            reactions: 0,
            comments: 0,
            reposts: 0
        }
    };

    try {
        // Impressions
        const impressionsEl = document.querySelector('[aria-label*="impression"]');
        if (impressionsEl) {
            const match = impressionsEl.textContent.match(/(\d[\d\s,]*)/);
            if (match) data.stats.impressions = parseInt(match[1].replace(/[\s,]/g, ''));
        }

        // Réactions
        const reactionsEl = document.querySelector('.social-details-social-counts__reactions-count');
        if (reactionsEl) {
            const match = reactionsEl.textContent.match(/(\d[\d\s,]*)/);
            if (match) data.stats.reactions = parseInt(match[1].replace(/[\s,]/g, ''));
        }

        // Commentaires
        const commentsEl = document.querySelector('.social-details-social-counts__comments');
        if (commentsEl) {
            const match = commentsEl.textContent.match(/(\d[\d\s,]*)/);
            if (match) data.stats.comments = parseInt(match[1].replace(/[\s,]/g, ''));
        }

        // Republications
        const repostsEl = document.querySelector('.social-details-social-counts__item--reposts');
        if (repostsEl) {
            const match = repostsEl.textContent.match(/(\d[\d\s,]*)/);
            if (match) data.stats.reposts = parseInt(match[1].replace(/[\s,]/g, ''));
        }

        return data;
    } catch (error) {
        console.error('Erreur scraping post:', error);
        return null;
    }
}

// === GESTION DU STOCKAGE ===

// Sauvegarde dans le storage local
async function saveToStorage(key, data, isArray = false) {
    try {
        let stored = await chrome.storage.local.get(key);

        if (isArray) {
            stored[key] = stored[key] || [];
            stored[key].push(data);
        } else {
            stored[key] = data;
        }

        await chrome.storage.local.set(stored);
    } catch (error) {
        console.error('Erreur sauvegarde:', error);
    }
}

// Chargement et affichage des stats stockées
async function loadStoredStats() {
    try {
        const data = await chrome.storage.local.get(null);
        statsList.innerHTML = '';

        if (Object.keys(data).length === 0) {
            statsList.innerHTML = '<div class="empty-state">Aucune donnée collectée</div>';
            return;
        }

        // Affichage du profil
        if (data.profile) {
            const profileCard = createStatCard('Profil', data.profile);
            statsList.appendChild(profileCard);
        }

        // Affichage des publications suivies
        if (data.trackedPosts && data.trackedPosts.length > 0) {
            data.trackedPosts.forEach(post => {
                const postCard = createStatCard('Publication', post);
                statsList.appendChild(postCard);
            });
        }

    } catch (error) {
        console.error('Erreur chargement stats:', error);
    }
}

// Création d'une carte de statistiques
function createStatCard(type, data) {
    const card = document.createElement('div');
    card.className = 'stat-card';

    let content = `
    <div class="stat-header">
      <span class="stat-type">${type}</span>
      <span class="stat-time">${new Date(data.timestamp).toLocaleString('fr-FR')}</span>
    </div>
    <div class="stat-content">
  `;

    if (type === 'Profil') {
        content += `<p><strong>Abonnés:</strong> ${data.followers || 0}</p>`;

        // Affichage détaillé des compétences
        if (data.skills && data.skills.length > 0) {
            const totalSkills = data.skills.length;
            const skillsWithExperience = data.skills.filter(skill => skill.hasExperiences).length;
            const totalExperiences = data.skills.reduce((sum, skill) => sum + (skill.experienceCount || 0), 0);

            content += `
        <p><strong>Compétences:</strong> ${totalSkills}</p>
        <p><strong>Avec expériences:</strong> ${skillsWithExperience}</p>
        <p><strong>Total expériences:</strong> ${totalExperiences}</p>
      `;

            // Afficher les top 5 compétences avec le plus d'expériences
            const topSkills = data.skills
                .filter(skill => skill.experienceCount > 0)
                .sort((a, b) => b.experienceCount - a.experienceCount)
                .slice(0, 5);

            if (topSkills.length > 0) {
                content += `<p><strong>Top compétences:</strong></p>`;
                topSkills.forEach(skill => {
                    content += `<p style="font-size:12px; margin-left:10px;">• ${skill.name} (${skill.experienceCount})</p>`;
                });
            }
        } else {
            content += `<p><strong>Compétences:</strong> 0</p>`;
        }

    } else if (type === 'Publication') {
        content += `
      <p><strong>👁️ Impressions:</strong> ${data.stats?.impressions || 0}</p>
      <p><strong>❤️ Réactions:</strong> ${data.stats?.reactions || 0}</p>
      <p><strong>💬 Commentaires:</strong> ${data.stats?.comments || 0}</p>
      <p><strong>🔄 Republications:</strong> ${data.stats?.reposts || 0}</p>
    `;
    }

    content += '</div>';
    card.innerHTML = content;
    return card;
}

// === UTILITAIRES UI ===

// Gestion du state de chargement des boutons
function setButtonLoading(button, isLoading) {
    if (isLoading) {
        button.disabled = true;
        button.classList.add('opacity-50', 'cursor-not-allowed');
        button.textContent = 'Chargement...';
    } else {
        button.disabled = false;
        button.classList.remove('opacity-50', 'cursor-not-allowed');
        button.textContent = button.id === 'getProfileBtn'
            ? 'Récupérer les statistiques du profil'
            : 'Récupérer mes publications récentes';
    }
}

// Affichage des notifications
function showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.className = `status status--${type} fixed top-4 right-4 z-50`;
    notification.textContent = message;

    document.body.appendChild(notification);

    setTimeout(() => {
        notification.remove();
    }, 3000);
}
