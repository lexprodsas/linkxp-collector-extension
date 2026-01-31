// content.js - Version simplifiée
console.log('LinkXP Content Script loaded');

const BUTTON_CLASS = 'linkxp-track-btn';
let observer = null;

init();

function init() {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startTracking);
    } else {
        startTracking();
    }

    checkForAutoCollection();
}


function startTracking() {
    injectTrackButtons();
    setupMutationObserver();
    chrome.runtime.onMessage.addListener(handleMessage);
}


function checkForAutoCollection() {
    if (window.location.href.includes('/details/skills/')) {
        chrome.storage.local.get(['autoCollectSkills'], (result) => {
            if (result.autoCollectSkills) {
                setTimeout(() => {
                    triggerSkillsCollection();
                }, 2500);

                chrome.storage.local.remove(['autoCollectSkills']);
            }
        });
    }
}

function triggerSkillsCollection() {
    chrome.runtime.sendMessage({
        action: 'collectSkillsFromCurrentPage'
    }, (response) => {
        if (response && response.success && response.skills) {
            const skills = response.skills;
            const skillsWithExperience = skills.filter(skill => skill.hasExperiences).length;

            showInPageNotification(
                `🎯 ${skills.length} compétences collectées (${skillsWithExperience} avec expériences) !`,
                'success'
            );
        }
    });
}

function injectTrackButtons() {
    const posts = document.querySelectorAll('.feed-shared-update-v2');

    posts.forEach(post => {
        if (post.querySelector(`.${BUTTON_CLASS}`)) return;

        const actionsBar = post.querySelector('.feed-shared-social-action-bar');
        if (actionsBar) {
            // TODO injecter ce bouton uniquement dans les publications propre à celle de l'user
            const trackButton = createTrackButton(post);
            actionsBar.appendChild(trackButton);
        }
    });
}

function createTrackButton() {
    const button = document.createElement('button');
    button.className = BUTTON_CLASS;
    button.innerHTML = '📊 Suivre';
    button.style.cssText = `
    padding: 8px 12px;
    margin-left: 8px;
    background: rgba(33, 128, 141, 0.08);
    border: 1px solid rgba(33, 128, 141, 0.2);
    border-radius: 16px;
    color: #21808D;
    cursor: pointer;
  `;

    button.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Logique de suivi à implémenter
        showInPageNotification('Publication suivie !', 'success');
    });

    return button;
}

function setupMutationObserver() {
    if (observer) observer.disconnect();

    observer = new MutationObserver(() => {
        clearTimeout(observer.timer);
        observer.timer = setTimeout(injectTrackButtons, 1000);
    });

    const feedContainer = document.querySelector('.scaffold-finite-scroll__content, main');
    if (feedContainer) {
        observer.observe(feedContainer, { childList: true, subtree: true });
    }
}

function showInPageNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.style.cssText = `
    position: fixed;
    top: 80px;
    right: 20px;
    z-index: 10000;
    padding: 12px 20px;
    background: ${type === 'success' ? '#21808D' : '#C0152F'};
    color: white;
    border-radius: 8px;
    font-size: 14px;
    animation: slideIn 0.3s ease;
  `;

    notification.textContent = message;
    document.body.appendChild(notification);

    setTimeout(() => notification.remove(), 3000);
}

function handleMessage(request, sender, sendResponse) {
    if (request.action === 'collectPost') {
        sendResponse({ success: true });
    }
    return true;
}
