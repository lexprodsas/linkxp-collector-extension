// content.js - Script injecté sur les pages LinkedIn

console.log('LinkXP Content Script loaded on LinkedIn');

// Configuration
const BUTTON_CLASS = 'linkxp-track-btn';
const BUTTON_ICON = '📊';
let observer = null;
let shouldAutoCollectSkills = false;

// Initialisation
init();

function init() {
    console.log('Initialisation LinkXP sur LinkedIn');

    // Attendre que la page soit chargée
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startTracking);
    } else {
        startTracking();
    }

    checkForAutoCollection();
}

function checkForAutoCollection() {
    // Vérifier si on est sur la page des compétences
    if (window.location.href.includes('/details/skills/')) {
        console.log('Page des compétences détectée');

        // Vérifier s'il y a une demande de collecte en attente
        chrome.storage.local.get(['autoCollectSkills'], (result) => {
            if (result.autoCollectSkills) {
                console.log('Auto-collecte des compétences déclenchée');

                // Attendre la fonction async correctement
                setTimeout(async () => {
                    try {
                        await scrapeSkillsFromPage();
                    } catch (error) {
                        console.error('Erreur auto-collecte:', error);
                        showInPageNotification('❌ Erreur lors de la collecte automatique', 'error');
                    }
                }, 2500);

                // Supprimer le flag pour éviter les doubles collectes
                chrome.storage.local.remove(['autoCollectSkills']);
            }
        });
    }
}

function startTracking() {
    // Injection initiale des boutons
    injectTrackButtons();

    // Observer les changements du DOM (LinkedIn charge dynamiquement)
    setupMutationObserver();

    // Écouter les messages du popup
    chrome.runtime.onMessage.addListener(handleMessage);
}

// === INJECTION DES BOUTONS ===

function injectTrackButtons() {
    // Sélecteur pour les publications dans le feed
    const posts = document.querySelectorAll('.feed-shared-update-v2, .update-components-actor');

    posts.forEach(post => {
        // Vérifier si le bouton n'existe pas déjà
        if (post.querySelector(`.${BUTTON_CLASS}`)) {
            return;
        }

        // Trouver la barre d'actions de la publication
        const actionsBar = post.querySelector('.feed-shared-social-action-bar, .social-actions-bar');

        if (actionsBar) {
            const trackButton = createTrackButton(post);

            // Insérer le bouton à la fin de la barre d'actions
            actionsBar.appendChild(trackButton);
        }
    });

    console.log(`${posts.length} publications trouvées, boutons injectés`);
}

function createTrackButton(postElement) {
    const button = document.createElement('button');
    button.className = `${BUTTON_CLASS} artdeco-button artdeco-button--muted artdeco-button--4 artdeco-button--tertiary ember-view`;
    button.setAttribute('aria-label', 'Suivre les statistiques avec LinkXP');
    button.style.cssText = `
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 8px 12px;
    font-size: 14px;
    font-weight: 600;
    color: #21808D;
    background: rgba(33, 128, 141, 0.08);
    border: 1px solid rgba(33, 128, 141, 0.2);
    border-radius: 16px;
    cursor: pointer;
    transition: all 0.2s;
    margin-left: 8px;
  `;

    button.innerHTML = `
    <span>${BUTTON_ICON}</span>
    <span>Suivre</span>
  `;

    // Effet hover
    button.addEventListener('mouseenter', () => {
        button.style.background = 'rgba(33, 128, 141, 0.15)';
        button.style.borderColor = 'rgba(33, 128, 141, 0.3)';
    });

    button.addEventListener('mouseleave', () => {
        button.style.background = 'rgba(33, 128, 141, 0.08)';
        button.style.borderColor = 'rgba(33, 128, 141, 0.2)';
    });

    // Action au clic
    button.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        handleTrackButtonClick(postElement, button);
    });

    return button;
}

// === GESTION DES CLICS ===

async function handleTrackButtonClick(postElement, button) {
    try {
        // Feedback visuel
        const originalText = button.innerHTML;
        button.innerHTML = '<span>⏳</span><span>Collecte...</span>';
        button.disabled = true;

        // Collecter les données de la publication
        const postData = extractPostData(postElement);

        if (!postData) {
            throw new Error('Impossible d\'extraire les données de la publication');
        }

        // Sauvegarder dans le storage
        await savePostToStorage(postData);

        // Feedback succès
        button.innerHTML = '<span>✅</span><span>Suivi !</span>';
        button.style.background = 'rgba(33, 128, 141, 0.2)';

        // Notification
        showInPageNotification('Publication ajoutée au suivi !', 'success');

        // Réinitialiser après 2 secondes
        setTimeout(() => {
            button.innerHTML = originalText;
            button.disabled = false;
            button.style.background = 'rgba(33, 128, 141, 0.08)';
        }, 2000);

    } catch (error) {
        console.error('Erreur lors du suivi:', error);
        button.innerHTML = '<span>❌</span><span>Erreur</span>';
        showInPageNotification('Erreur lors de la collecte', 'error');

        setTimeout(() => {
            button.innerHTML = '<span>📊</span><span>Suivre</span>';
            button.disabled = false;
        }, 2000);
    }
}

// === EXTRACTION DES DONNÉES ===

function extractPostData(postElement) {
    try {
        const data = {
            timestamp: new Date().toISOString(),
            type: 'post',
            url: '',
            text: '',
            stats: {
                impressions: 0,
                reach: 0,
                reactions: 0,
                comments: 0,
                reposts: 0
            }
        };

        // URL de la publication
        const postLink = postElement.querySelector('a[href*="/posts/"], a[href*="/feed/update/"]');
        if (postLink) {
            data.url = postLink.href.split('?')[0]; // Nettoyer les paramètres
        }

        // Texte de la publication
        const textElement = postElement.querySelector('.feed-shared-update-v2__description, .break-words');
        if (textElement) {
            data.text = textElement.textContent.trim().substring(0, 200);
        }

        // Statistiques visibles

        // Réactions
        const reactionsElement = postElement.querySelector('.social-details-social-counts__reactions-count');
        if (reactionsElement) {
            const match = reactionsElement.textContent.match(/(\d[\d\s,\.]*)/);
            if (match) {
                data.stats.reactions = parseLinkedInNumber(match[1]);
            }
        }

        // Commentaires
        const commentsElement = postElement.querySelector('.social-details-social-counts__comments, [aria-label*="commentaire"]');
        if (commentsElement) {
            const match = commentsElement.textContent.match(/(\d[\d\s,\.]*)/);
            if (match) {
                data.stats.comments = parseLinkedInNumber(match[1]);
            }
        }

        // Republications
        const repostsElement = postElement.querySelector('.social-details-social-counts__item--reposts, [aria-label*="republication"]');
        if (repostsElement) {
            const match = repostsElement.textContent.match(/(\d[\d\s,\.]*)/);
            if (match) {
                data.stats.reposts = parseLinkedInNumber(match[1]);
            }
        }

        // Note: impressions et reach nécessitent d'ouvrir la page de stats détaillées
        // Pour l'instant on les laisse à 0, ils seront collectés si l'user ouvre la publication

        return data;

    } catch (error) {
        console.error('Erreur extraction données post:', error);
        return null;
    }
}

// Convertir les nombres LinkedIn (ex: "1,2 k" -> 1200)
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

// === STOCKAGE ===

async function savePostToStorage(postData) {
    return new Promise((resolve, reject) => {
        chrome.storage.local.get(['trackedPosts'], (result) => {
            const trackedPosts = result.trackedPosts || [];

            // Vérifier si la publication n'est pas déjà suivie
            const existingIndex = trackedPosts.findIndex(p => p.url === postData.url);

            if (existingIndex >= 0) {
                // Mettre à jour les stats
                trackedPosts[existingIndex] = postData;
            } else {
                // Ajouter la nouvelle publication
                trackedPosts.push(postData);
            }

            chrome.storage.local.set({ trackedPosts }, () => {
                if (chrome.runtime.lastError) {
                    reject(chrome.runtime.lastError);
                } else {
                    resolve();
                }
            });
        });
    });
}

// === OBSERVER POUR LE CHARGEMENT DYNAMIQUE ===

function setupMutationObserver() {
    // Déconnecter l'ancien observer s'il existe
    if (observer) {
        observer.disconnect();
    }

    observer = new MutationObserver((mutations) => {
        // Throttle: ne pas réinjecter trop souvent
        clearTimeout(observer.timer);
        observer.timer = setTimeout(() => {
            injectTrackButtons();
        }, 1000);
    });

    // Observer le feed LinkedIn
    const feedContainer = document.querySelector('.scaffold-finite-scroll__content, main');

    if (feedContainer) {
        observer.observe(feedContainer, {
            childList: true,
            subtree: true
        });
        console.log('Observer activé sur le feed LinkedIn');
    }
}

// === NOTIFICATIONS IN-PAGE ===

function showInPageNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.className = 'linkxp-notification';
    notification.style.cssText = `
    position: fixed;
    top: 80px;
    right: 20px;
    z-index: 10000;
    padding: 12px 20px;
    background: ${type === 'success' ? '#21808D' : '#C0152F'};
    color: white;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    font-size: 14px;
    font-weight: 500;
    animation: slideIn 0.3s ease;
  `;

    notification.textContent = message;

    document.body.appendChild(notification);

    setTimeout(() => {
        notification.style.animation = 'slideOut 0.3s ease';
        setTimeout(() => notification.remove(), 300);
    }, 3000);
}

// === GESTION DES MESSAGES ===

function handleMessage(request, sender, sendResponse) {
    if (request.action === 'collectPost') {
        // Collecter les stats d'une publication spécifique
        const postData = extractPostData(document.body);
        sendResponse({ success: true, data: postData });
    }

    return true; // Permet les réponses asynchrones
}

// === STYLES CSS pour animations ===

const style = document.createElement('style');
style.textContent = `
  @keyframes slideIn {
    from {
      transform: translateX(100%);
      opacity: 0;
    }
    to {
      transform: translateX(0);
      opacity: 1;
    }
  }
  
  @keyframes slideOut {
    from {
      transform: translateX(0);
      opacity: 1;
    }
    to {
      transform: translateX(100%);
      opacity: 0;
    }
  }
  
  .${BUTTON_CLASS}:hover {
    transform: scale(1.05);
  }
  
  .${BUTTON_CLASS}:active {
    transform: scale(0.98);
  }
`;

// Écouter les messages du popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'prepareSkillsCollection') {
        shouldAutoCollectSkills = true;
        sendResponse({ success: true });
    }

    if (message.action === 'collectPost') {
        const postData = extractPostData(document.body);
        sendResponse({ success: true, data: postData });
    }

    return true;
});

document.head.appendChild(style);
