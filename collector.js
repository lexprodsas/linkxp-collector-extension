/**
 * Collecte LinkedIn V1 : inventaire voyager, puis collecte détaillée progressive (page de statistiques
 * par post, commentaires) traitée lentement en arrière-plan.
 *
 * Toutes les requêtes LinkedIn sont exécutées DANS un onglet linkedin.com (chrome.scripting),
 * avec la session de l'utilisateur : même origine, cookies et jeton CSRF disponibles.
 *
 * Priorité à la discrétion vis-à-vis de LinkedIn, quitte à une collecte longue :
 * - seuls les posts qui en ont besoin sont détaillés (originaux de J+7 à 12 mois au détail incomplet,
 *   demandes d'actualisation, posts complets dont les interactions ont nettement bougé) ;
 * - une requête à la fois, 8 à 15 s entre deux requêtes de détail, une pause longue toutes les 25 pages ;
 * - plafond de requêtes LinkedIn par jour ; arrêt immédiat sur un signal de blocage, sans nouvel essai.
 *
 * Le passage est persisté (chrome.storage.local.collectJob) : file, avancement, lignes et journal pas
 * encore envoyés. Une collecte interrompue (service worker arrêté, Chrome fermé) reprend où elle en était.
 *
 * Chargé par background.js via importScripts().
 */

const LINKXP_COLLECT = {
    INVENTORY_PAGE_SIZE: 50,
    INVENTORY_MAX_PAGES: 10,          // 500 activités au plus
    INVENTORY_DELAY_MS: [3000, 5000], // entre deux requêtes de l'inventaire (quelques requêtes par passage)
    DETAIL_DELAY_MS: [8000, 15000],   // entre deux requêtes de la collecte détaillée
    LONG_PAUSE_EVERY: 25,             // pages de statistiques entre deux pauses longues
    LONG_PAUSE_MS: [3 * 60 * 1000, 6 * 60 * 1000],
    DAILY_REQUEST_CAP: 300,           // requêtes LinkedIn par jour, tous passages confondus
    API_BATCH_SIZE: 50,               // publications par POST d'inventaire
    LOG_BATCH_SIZE: 200,
    LOG_FLUSH_SIZE: 20,               // le journal part pendant la collecte, pas seulement à la fin
    MATURITY_DAYS: 7,                 // un post n'est détaillé qu'à partir de J+7
    DETAIL_WINDOW_DAYS: 365,          // posts détaillés : publiés dans les 12 derniers mois
    REFRESH_WINDOW_DAYS: 90,          // un post complet n'est plus actualisé au-delà
    REFRESH_MIN_GROWTH: 0.15,         // actualisation : interactions en hausse d'au moins 15 %…
    REFRESH_MIN_INTERACTIONS: 5,      // … et d'au moins 5
    MAX_AUTO_REFRESHES: 2,
    MAX_DETAIL_FAILURES: 3,           // échecs consécutifs avant de marquer un post indisponible
    KEEPALIVE_MS: 20000,              // attente découpée : le service worker n'est pas arrêté pendant une pause
    RESUME_DELAY_MS: [60 * 1000, 2 * 60 * 1000], // avant la première requête d'une reprise
    FIRST_COMMENT_LINK_WINDOW_MS: 30 * 60 * 1000,
};

const DAY_MS = 24 * 60 * 60 * 1000;

class LinkedInBlockedError extends Error {
    constructor(message) {
        super(message);
        this.name = 'LinkedInBlockedError';
    }
}

// Plafond de requêtes du jour atteint : reprise le lendemain
class DailyCapError extends Error {
    constructor() {
        super('Plafond de requêtes du jour atteint');
        this.name = 'DailyCapError';
    }
}

// Pause demandée par l'utilisateur
class CollectStoppedError extends Error {
    constructor() {
        super('Collecte mise en pause');
        this.name = 'CollectStoppedError';
    }
}

function linkxpRandomBetween([min, max]) {
    return min + Math.random() * (max - min);
}

/**
 * Attente découpée en tranches de 20 s, chacune suivie d'un appel d'extension léger : Chrome arrête un
 * service worker inactif au bout de 30 s, sans erreur visible. Une tranche anormalement longue signale une
 * sortie de veille : on attend alors un délai de reprise avant de rendre la main à la collecte.
 */
async function linkxpSleep(ms, shouldStop = () => false) {
    let deadline = Date.now() + ms;
    let last = Date.now();

    while (Date.now() < deadline) {
        if (shouldStop()) throw new CollectStoppedError();
        await new Promise(resolve => setTimeout(resolve, Math.min(LINKXP_COLLECT.KEEPALIVE_MS, deadline - Date.now())));
        await chrome.runtime.getPlatformInfo();

        const now = Date.now();
        if (now - last > LINKXP_COLLECT.KEEPALIVE_MS + 60 * 1000) {
            deadline = Math.max(deadline, now + linkxpRandomBetween(LINKXP_COLLECT.RESUME_DELAY_MS));
        }
        last = now;
    }
    if (shouldStop()) throw new CollectStoppedError();
}

// ========================================
// Parsing (fonctions pures)
// ========================================

const LinkXPParsers = {
    activityId(urn) {
        const match = String(urn || '').match(/urn:li:activity:(\d+)/);
        return match ? match[1] : null;
    },

    // Les 41 premiers bits de l'ID d'activité sont le timestamp de publication en ms
    publishedMsFromActivityUrn(urn) {
        const id = LinkXPParsers.activityId(urn);
        if (!id) return null;
        const bits = BigInt(id).toString(2);
        return parseInt(bits.slice(0, 41), 2);
    },

    toInt(str) {
        if (str === null || str === undefined) return null;
        const digits = String(str).replace(/[^\d]/g, '');
        return digits === '' ? null : parseInt(digits, 10);
    },

    isExternalUrl(url) {
        try {
            const host = new URL(url).hostname.toLowerCase();
            return !(host === 'linkedin.com' || host.endsWith('.linkedin.com'));
        } catch (e) {
            return false;
        }
    },

    hasExternalUrlInText(text) {
        const urls = String(text || '').match(/https?:\/\/[^\s"'<>]+/gi) || [];
        return urls.some(url => LinkXPParsers.isExternalUrl(url));
    },

    // GET /voyager/api/me
    parseMe(body) {
        const plainId = body?.data?.plainId;
        const miniProfileUrn = body?.data?.['*miniProfile'];
        const miniProfile = (body?.included || []).find(i => i.entityUrn === miniProfileUrn);
        const profileId = (miniProfile?.dashEntityUrn || '').split(':').pop() || null;

        if (!plainId || !profileId) return null;

        return {
            memberUrn: `urn:li:member:${plainId}`,
            profileId,                                  // ID fsd_profile (ex. ACoAA…)
            publicIdentifier: miniProfile.publicIdentifier || null,
        };
    },

    // GET /voyager/api/feed/dash/followingStates/…
    parseFollowerCount(body) {
        if (typeof body?.data?.followerCount === 'number') return body.data.followerCount;
        const item = (body?.included || []).find(i => typeof i.followerCount === 'number');
        return item ? item.followerCount : null;
    },

    mediaTypeFromContent(update) {
        if (update.resharedUpdate || update['*resharedUpdate']) return 'reshare';
        const type = (update.content?.$type || '').split('.').pop();
        const map = {
            ImageComponent: 'image',
            LinkedInVideoComponent: 'video',
            ExternalVideoComponent: 'video',
            DocumentComponent: 'document',
            ArticleComponent: 'article',
            PollComponent: 'poll',
            EventComponent: 'event',
            CelebrationComponent: 'celebration',
            JobComponent: 'job',
        };
        if (!type) return 'text';
        return map[type] || type.replace(/Component$/, '').replace(/[A-Z]/g, (c, i) => (i ? '_' : '') + c.toLowerCase()).slice(0, 32);
    },

    /**
     * Une page de GET /voyager/api/identity/profileUpdatesV2?q=memberShareFeed
     * Renvoie les publications au format de l'API LinkXP + les anomalies de plausibilité.
     */
    parseInventoryPage(body, me) {
        const included = body?.included || [];
        const byUrn = new Map(included.filter(i => i.entityUrn).map(i => [i.entityUrn, i]));
        const elementUrns = body?.data?.['*elements'] || [];
        const publications = [];
        const anomalies = new Set();
        let anomalyTarget = null;
        const flag = (code, urn) => {
            anomalies.add(code);
            anomalyTarget = anomalyTarget || urn || null;
        };

        for (const elementUrn of elementUrns) {
            // Seuls les éléments de premier niveau : un post repartagé avec commentaire
            // inclut aussi l'UpdateV2 d'origine, qui n'est pas une activité du membre.
            const update = byUrn.get(elementUrn);
            // L'activité se lit dans l'URN de l'élément, urn:li:fs_updateV2:(urn:li:activity:<id>,…) :
            // pour certains reposts de son propre post, updateMetadata.urn porte l'activité d'origine.
            const urn = (elementUrn.match(/urn:li:activity:\d+/) || [])[0] || update?.updateMetadata?.urn;
            if (!update || !/^urn:li:activity:\d+$/.test(urn || '')) {
                flag('update_unreadable', urn);
                continue;
            }

            const actorUrn = update.actor?.urn || null;
            const social = byUrn.get(update['*socialDetail']);
            const counts = byUrn.get(social?.['*totalSocialActivityCounts']);
            const text = update.commentary?.text?.text || '';
            const shareUrn = update.updateMetadata?.shareUrn || null;
            const articleUrl = update.content?.navigationContext?.actionTarget || '';
            const publishedMs = LinkXPParsers.publishedMsFromActivityUrn(urn);
            const reshared = !!(update.resharedUpdate || update['*resharedUpdate']);

            // Repost : post d'un autre auteur ; ou en-tête « reposted this », seul en-tête de ce flux,
            // présent aussi quand le membre reposte son propre post ; ou ancien repartage sans commentaire.
            const isRepost = (!!actorUrn && actorUrn !== me.memberUrn) || !!update.header || (reshared && !text);

            if (!counts) flag('counts_missing', urn);
            // Les très anciens posts n'ont pas d'impressions : seul un post récent sans impressions est suspect
            if (!isRepost && counts && typeof counts.numImpressions !== 'number'
                && Date.now() - publishedMs < 365 * DAY_MS) flag('impressions_missing', urn);
            if (!isRepost && !text && !update.content) flag('empty_post', urn);

            publications.push({
                urn,
                type: isRepost ? 'repost' : 'original',
                text,
                publishedDate: publishedMs ? new Date(publishedMs).toISOString() : null,
                shareUrn: /^urn:li:(share|ugcPost):\d+$/.test(shareUrn || '') ? shareUrn : null,
                mediaType: LinkXPParsers.mediaTypeFromContent(update),
                hasLink: LinkXPParsers.hasExternalUrlInText(text) || LinkXPParsers.isExternalUrl(articleUrl),
                reactions: counts?.numLikes ?? null,
                comments: counts?.numComments ?? null,
                reposts: counts?.numShares ?? null,
                // Repost : les compteurs sont ceux du post d'origine, sans impressions pour le membre
                impressions: isRepost ? 0 : (counts?.numImpressions ?? null),
            });
        }

        return {
            publications,
            paginationToken: body?.data?.metadata?.paginationToken || null,
            elementCount: elementUrns.length,
            anomalies: [...anomalies],
            anomalyTarget,          // URN du premier post concerné
        };
    },

    // Libellés de la page /analytics/post-summary/ (vérifiés en FR ; EN à confirmer)
    STATS_PATTERNS: {
        impressions: /(\d[\d ,.]*)\s*Impressions\b/,
        profileViews: /(\d[\d ,.]*)\s*(?:Vues du profil depuis ce post|Profile viewers from this post|Profile views from this post)/,
        followersGained: /(\d[\d ,.]*)\s*(?:Abonnés gagnés grâce à ce post|Followers gained from this post)/,
        reactions: /(?:Réactions|Reactions)\s*(\d[\d ,.]*)/,
        comments: /(?:Commentaires|Comments)\s*(\d[\d ,.]*)/,
        reposts: /(?:Republications|Reposts)\s*(\d[\d ,.]*)/,
        saves: /(?:Enregistrements|Saves)\s*(\d[\d ,.]*)/,
        sends: /(?:Envois sur LinkedIn|Sends on LinkedIn)\s*(\d[\d ,.]*)/,
    },

    /**
     * Texte visible de la page de statistiques d'un post (extrait à partir du bloc « Découverte »).
     * Les classes CSS sont générées et instables : on lit chaque valeur par son libellé.
     */
    parseStatsText(text) {
        const values = {};
        const anomalies = [];

        for (const [key, pattern] of Object.entries(LinkXPParsers.STATS_PATTERNS)) {
            const match = String(text || '').match(pattern);
            values[key] = match ? LinkXPParsers.toInt(match[1]) : null;
        }

        if (values.impressions === null) anomalies.push('stats_impressions_missing');
        if (values.profileViews === null) anomalies.push('stats_profile_views_missing');
        if (values.followersGained === null) anomalies.push('stats_followers_gained_missing');
        if (values.reactions === null || values.comments === null) anomalies.push('stats_engagement_missing');

        return { values, anomalies };
    },

    /**
     * GET /voyager/api/feed/comments (une page, commentaires et réponses).
     * Compte les commentaires de l'auteur et détecte un lien externe posté par l'auteur
     * en commentaire racine moins de 30 min après la publication.
     */
    parseComments(body, me, publishedMs) {
        const comments = (body?.included || []).filter(i => i.$type === 'com.linkedin.voyager.feed.Comment');
        let authorComments = 0;
        let hasLinkFirstComment = false;

        for (const comment of comments) {
            if (comment.commenterProfileId !== me.profileId) continue;
            authorComments++;

            const isRoot = !comment.parentCommentUrn;
            const text = comment.commentV2?.text || '';
            const delay = publishedMs && comment.createdTime ? comment.createdTime - publishedMs : Infinity;
            if (isRoot && delay >= 0 && delay <= LINKXP_COLLECT.FIRST_COMMENT_LINK_WINDOW_MS && LinkXPParsers.hasExternalUrlInText(text)) {
                hasLinkFirstComment = true;
            }
        }

        return { fetched: comments.length, authorComments, hasLinkFirstComment };
    },

    interactions(pub) {
        if (pub.reactions === null && pub.comments === null && pub.reposts === null) return null;
        return (pub.reactions || 0) + (pub.comments || 0) + (pub.reposts || 0);
    },

    // Détail complet : la page de statistiques a donné visites de profil et abonnés gagnés
    isDetailComplete(stateRow) {
        return !!stateRow?.stats_collected_at && stateRow.profile_views !== null && stateRow.followers_gained !== null;
    },

    /**
     * Posts complets détaillés avant le suivi des compteurs : l'inventaire courant devient la référence
     * pour l'actualisation sur signal. Renvoie les champs à ajouter à leur ligne d'inventaire.
     */
    missingDetailBaselines(publications, stateRows) {
        const state = new Map((stateRows || []).map(row => [row.urn, row]));
        const baselines = new Map();

        for (const pub of publications) {
            const row = state.get(pub.urn);
            if (pub.type !== 'original' || !LinkXPParsers.isDetailComplete(row) || row.detail_interactions !== null) continue;
            const interactions = LinkXPParsers.interactions(pub);
            if (interactions === null) continue;
            baselines.set(pub.urn, { detailInteractions: interactions });
        }
        return baselines;
    },

    /**
     * File de collecte détaillée, dans l'ordre de traitement :
     * 1. demandes d'actualisation faites depuis l'app ;
     * 2. posts jamais détaillés ou incomplets (visites de profil ou abonnés gagnés vides) ;
     * 3. posts complets de moins de 90 jours dont les interactions ont augmenté d'au moins 15 % et de 5,
     *    deux actualisations automatiques au plus.
     * Les plus récents d'abord dans chaque groupe. Seuls les originaux publiés de J+7 à 12 mois y entrent,
     * jamais un post marqué indisponible (sauf demande d'actualisation).
     * Renvoie aussi la couverture : posts au détail complet parmi les originaux de J+7 à 12 mois.
     */
    buildDetailQueue(publications, stateRows, nowMs) {
        const state = new Map((stateRows || []).map(row => [row.urn, row]));
        const buckets = { manual: [], missing: [], refresh: [] };
        const coverage = { detailed: 0, total: 0 };

        for (const pub of publications) {
            if (pub.type !== 'original') continue;

            const publishedMs = LinkXPParsers.publishedMsFromActivityUrn(pub.urn);
            const ageMs = nowMs - publishedMs;
            if (!publishedMs || ageMs < LINKXP_COLLECT.MATURITY_DAYS * DAY_MS) continue;

            const row = state.get(pub.urn) || null;
            const complete = LinkXPParsers.isDetailComplete(row);
            const inWindow = ageMs <= LINKXP_COLLECT.DETAIL_WINDOW_DAYS * DAY_MS;
            if (inWindow) {
                coverage.total++;
                if (complete) coverage.detailed++;
            }

            const interactions = LinkXPParsers.interactions(pub);
            let reason = null;
            if (row?.refresh_requested_at) {
                reason = 'manual';
            } else if (!inWindow || row?.detail_unavailable) {
                continue;
            } else if (!complete) {
                reason = 'missing';
            } else if (ageMs <= LINKXP_COLLECT.REFRESH_WINDOW_DAYS * DAY_MS
                && (row.detail_refresh_count || 0) < LINKXP_COLLECT.MAX_AUTO_REFRESHES
                && row.detail_interactions !== null && interactions !== null) {
                const growth = interactions - row.detail_interactions;
                if (growth >= LINKXP_COLLECT.REFRESH_MIN_INTERACTIONS
                    && growth >= row.detail_interactions * LINKXP_COLLECT.REFRESH_MIN_GROWTH) {
                    reason = 'refresh';
                }
            }
            if (!reason) continue;

            buckets[reason].push({
                urn: pub.urn,
                publishedMs,
                reason,
                complete,
                interactions,
                inventoryComments: pub.comments,
                // Commentaires lus une seule fois, puis relus seulement si leur total a changé depuis le dernier détail
                readComments: !row || row.comments_author === null || row.detail_comments === null
                    || (pub.comments !== null && pub.comments !== row.detail_comments),
                inWindow,
                inventoryImpressions: pub.impressions,
                failures: row?.detail_failures || 0,
                refreshCount: row?.detail_refresh_count || 0,
            });
        }

        const newestFirst = (a, b) => b.publishedMs - a.publishedMs;
        const queue = [buckets.manual, buckets.missing, buckets.refresh].flatMap(bucket => bucket.sort(newestFirst));
        return { queue, coverage };
    },
};

// ========================================
// Exécution dans l'onglet LinkedIn
// ========================================

/**
 * Injectée dans l'onglet linkedin.com : doit rester autonome (aucune référence externe).
 * kind = 'json' (API voyager) ou 'stats' (page HTML de statistiques, renvoyée en texte visible).
 */
async function linkxpLinkedInRequest(path, kind) {
    const started = Date.now();
    const result = { status: 0, durationMs: 0, finalUrl: '', body: null, text: null, error: null };

    try {
        const headers = {};
        if (kind === 'json') {
            const csrf = (document.cookie.match(/JSESSIONID="?([^";]+)/) || [])[1] || '';
            headers['csrf-token'] = csrf;
            headers['x-restli-protocol-version'] = '2.0.0';
            headers['accept'] = 'application/vnd.linkedin.normalized+json+2.1';
        }

        const response = await fetch(path, { headers, credentials: 'include' });
        result.status = response.status;
        result.finalUrl = response.url;

        if (response.ok) {
            if (kind === 'json') {
                result.body = await response.json();
            } else {
                const html = await response.text();
                const text = html
                    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
                    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
                    .replace(/<[^>]+>/g, ' ')
                    .replace(/&nbsp;|&#160;|\u00a0|\u202f/g, ' ')
                    .replace(/\s+/g, ' ');
                const start = text.search(/Découverte|Discovery/);
                result.text = start >= 0 ? text.slice(start, start + 2000) : text.slice(0, 2000);
            }
        }
    } catch (error) {
        result.error = String(error?.message || error).slice(0, 200);
    }

    result.durationMs = Date.now() - started;
    return result;
}

// ========================================
// Orchestration de la collecte (passage persisté, repris après interruption)
// ========================================

const LINKXP_JOB_KEY = 'collectJob';
const LINKXP_DAILY_KEY = 'collectDaily';

// Jour local (AAAA-MM-JJ) du plafond de requêtes
function linkxpToday() {
    return new Date().toLocaleDateString('sv-SE');
}

class LinkXPCollector {
    /**
     * @param api        instance de BackgroundLinkXPAuth (appels à l'API LinkXP)
     * @param onProgress callback(state) pour la popup
     * @param job        passage persisté à reprendre ; absent : nouveau passage, inventaire compris
     */
    constructor(api, onProgress, job = null) {
        this.api = api;
        this.onProgress = onProgress || (() => {});
        this.job = job || {
            runId: crypto.randomUUID(),
            status: 'running',
            phase: 'inventory',           // inventory, puis details une fois la file construite
            startedAt: Date.now(),
            me: null,
            queue: [],
            queueTotal: 0,
            coverage: null,               // { detailed, total } : originaux de J+7 à 12 mois au détail complet
            pendingRows: [],              // lignes collectées pas encore acceptées par l'API
            logs: [],                     // journal pas encore envoyé
            statsSinceLongPause: 0,
            lastLinkedInCall: 0,
            error: null,
            summary: { inventory: 0, originals: 0, detailed: 0, unavailable: 0, followers: null, anomalies: 0 },
        };
        this.tabId = null;
        this.delay = LINKXP_COLLECT.INVENTORY_DELAY_MS;
        this.stopRequested = false;
    }

    static async loadJob() {
        const { [LINKXP_JOB_KEY]: job } = await chrome.storage.local.get(LINKXP_JOB_KEY);
        return job || null;
    }

    get logs() {
        return this.job.logs;
    }

    // Pause demandée : prise en compte entre deux posts ou pendant une pause longue
    requestStop() {
        this.stopRequested = true;
    }

    async saveJob(status = null) {
        if (status) this.job.status = status;
        await chrome.storage.local.set({ [LINKXP_JOB_KEY]: this.job });
    }

    /**
     * Déroule le passage jusqu'au bout de la file, ou jusqu'à un arrêt.
     * Issue (status) : done, blocked (signal LinkedIn), daily_cap, paused (utilisateur) ou error.
     */
    async run() {
        let status = 'done';
        try {
            await this.saveJob('running');
            this.tabId = await this.findLinkedInTab();

            await this.flushPendingRows();
            if (this.job.phase === 'inventory') {
                await this.runInventory();
            }
            await this.runDetails();
            this.job.error = null;

        } catch (error) {
            if (error instanceof LinkedInBlockedError) status = 'blocked';
            else if (error instanceof DailyCapError) status = 'daily_cap';
            else if (error instanceof CollectStoppedError) status = 'paused';
            else status = 'error';
            // Côté utilisateur : un message neutre plutôt que des chiffres faux
            this.job.error = status === 'blocked' ? 'Collecte momentanément indisponible. Réessayez plus tard.'
                : status === 'error' ? error.message : null;
        }

        await this.flushLogs();
        await this.saveJob(status);
        return { status, error: this.job.error, summary: this.job.summary, coverage: this.job.coverage };
    }

    progress(phase, message, done = null, total = null, estimate = null) {
        this.onProgress({ phase, message, done, total, estimate, runId: this.job.runId, coverage: this.job.coverage });
    }

    /**
     * Temps restant estimé pour la file : requêtes à faire (commentaires seulement si le post en a),
     * délai moyen entre deux requêtes, pauses longues à venir, et jours de plus si le plafond du jour ne suffit pas.
     */
    async estimate(extraMs = 0) {
        const queue = this.job.queue;
        const requests = queue.reduce((n, item) => n + (item.readComments && item.inventoryComments !== 0 ? 2 : 1), 0);
        const average = ([min, max]) => (min + max) / 2;
        const longPauses = queue.length ? Math.floor((this.job.statsSinceLongPause + queue.length - 1) / LINKXP_COLLECT.LONG_PAUSE_EVERY) : 0;
        const budget = Math.max(0, LINKXP_COLLECT.DAILY_REQUEST_CAP - await this.dailyCount());

        return {
            remainingMs: Math.round(extraMs + requests * (average(LINKXP_COLLECT.DETAIL_DELAY_MS) + 1000)
                + longPauses * average(LINKXP_COLLECT.LONG_PAUSE_MS)),
            // 0 : fin aujourd'hui ; sinon nombre de jours de plus, le plafond étant remis à zéro chaque jour
            extraDays: requests > budget ? Math.ceil((requests - budget) / LINKXP_COLLECT.DAILY_REQUEST_CAP) : 0,
        };
    }

    /**
     * Profil, abonnés et inventaire complet, puis construction de la file de collecte détaillée.
     * Rejoué en entier si le passage est interrompu avant la fin.
     */
    async runInventory() {
        this.delay = LINKXP_COLLECT.INVENTORY_DELAY_MS;
        const summary = this.job.summary;

        this.progress('profile', 'Lecture du compte LinkedIn…');
        const me = await this.fetchMe();
        this.job.me = me;

        const followers = await this.fetchFollowers(me);
        if (followers !== null) {
            summary.followers = followers;
            await this.api.apiRequest('POST', '/linkedin/profile', { followers });
        }

        const publications = await this.fetchInventory(me);
        summary.inventory = publications.length;
        summary.originals = publications.filter(p => p.type === 'original').length;

        // État lu avant l'envoi de l'inventaire : la file compare les compteurs actuels à ceux du dernier détail
        const state = (await this.api.apiRequest('GET', '/linkedin/publications/state'))?.data || [];
        const baselines = LinkXPParsers.missingDetailBaselines(publications, state);
        const rows = publications.map(pub => ({ ...pub, ...baselines.get(pub.urn) }));

        this.progress('inventory_sync', `Envoi de ${rows.length} publications…`);
        for (let i = 0; i < rows.length; i += LINKXP_COLLECT.API_BATCH_SIZE) {
            await this.savePublications(rows.slice(i, i + LINKXP_COLLECT.API_BATCH_SIZE));
        }

        const { queue, coverage } = LinkXPParsers.buildDetailQueue(publications, state, Date.now());
        Object.assign(this.job, { phase: 'details', queue, queueTotal: queue.length, coverage });
        await this.saveJob();
    }

    /**
     * Collecte détaillée, un post à la fois. Chaque ligne est persistée puis envoyée dès que le post est
     * collecté : une interruption ne perd au plus que la requête en cours, et le post reste en tête de file.
     */
    async runDetails() {
        this.delay = LINKXP_COLLECT.DETAIL_DELAY_MS;
        const job = this.job;

        while (job.queue.length) {
            if (this.stopRequested) throw new CollectStoppedError();

            const item = job.queue[0];
            await this.checkDailyBudget(item.readComments ? 2 : 1);

            const position = job.queueTotal - job.queue.length + 1;
            this.progress('details', `Statistiques détaillées ${position}/${job.queueTotal}…`, position - 1, job.queueTotal, await this.estimate());

            let row = null;
            try {
                row = await this.fetchPostDetails(item, job.me);
            } catch (error) {
                // Échec isolé (déjà journalisé) : compté comme un échec du post, sauf blocage ou plafond
                if (error instanceof LinkedInBlockedError || error instanceof DailyCapError) throw error;
            }

            const complete = !!row && row.profileViews !== undefined && row.followersGained !== undefined;
            if (complete) {
                Object.assign(row, { statsCollected: true, detailFailures: 0 });
                if (item.interactions !== null) row.detailInteractions = item.interactions;
                if (item.reason === 'refresh') row.detailRefreshCount = item.refreshCount + 1;
                job.summary.detailed++;
                if (!item.complete && item.inWindow && job.coverage) job.coverage.detailed++;
            } else {
                row = { ...(row || {}), urn: item.urn, detailFailures: item.failures + 1 };
                if (row.detailFailures >= LINKXP_COLLECT.MAX_DETAIL_FAILURES) {
                    row.detailUnavailable = true;
                    job.summary.unavailable++;
                    this.logs.push({
                        route: 'post_detail',
                        target: item.urn,
                        status: 0,
                        durationMs: 0,
                        success: false,
                        error: `${row.detailFailures} échecs consécutifs : post indisponible`,
                        anomalies: ['post_unavailable'],
                        calledAt: Date.now(),
                    });
                }
            }

            job.pendingRows.push(row);
            job.queue.shift();
            await this.saveJob();
            await this.flushPendingRows();
            if (this.logs.length >= LINKXP_COLLECT.LOG_FLUSH_SIZE) {
                await this.flushLogs();
            }

            if (++job.statsSinceLongPause >= LINKXP_COLLECT.LONG_PAUSE_EVERY && job.queue.length) {
                job.statsSinceLongPause = 0;
                await this.saveJob();
                const pauseMs = linkxpRandomBetween(LINKXP_COLLECT.LONG_PAUSE_MS);
                this.progress('details', `Pause de quelques minutes (${position}/${job.queueTotal})…`, position, job.queueTotal, await this.estimate(pauseMs));
                await linkxpSleep(pauseMs, () => this.stopRequested);
            }
        }
    }

    async findLinkedInTab() {
        const tabs = await chrome.tabs.query({ url: 'https://www.linkedin.com/*' });
        const tab = tabs.find(t => t.active) || tabs[0];
        if (tab) return tab.id;

        // Aucun onglet LinkedIn : la route actuelle en exige un (même origine), ouvert sans prendre le focus
        const created = await chrome.tabs.create({ url: 'https://www.linkedin.com/feed/', active: false });
        await new Promise(resolve => {
            const listener = (tabId, info) => {
                if (tabId === created.id && info.status === 'complete') {
                    chrome.tabs.onUpdated.removeListener(listener);
                    resolve();
                }
            };
            chrome.tabs.onUpdated.addListener(listener);
        });
        return created.id;
    }

    async pause() {
        const wait = linkxpRandomBetween(this.delay);
        const elapsed = Date.now() - this.job.lastLinkedInCall;
        if (this.job.lastLinkedInCall && elapsed < wait) {
            await linkxpSleep(wait - elapsed);
        }
    }

    async dailyCount() {
        const { [LINKXP_DAILY_KEY]: daily } = await chrome.storage.local.get(LINKXP_DAILY_KEY);
        return daily?.day === linkxpToday() ? daily.count : 0;
    }

    // Un post n'est pas commencé s'il ne peut pas être fini dans le plafond du jour
    async checkDailyBudget(needed) {
        if (await this.dailyCount() + needed > LINKXP_COLLECT.DAILY_REQUEST_CAP) {
            throw new DailyCapError();
        }
    }

    async countRequest() {
        const count = await this.dailyCount();
        if (count >= LINKXP_COLLECT.DAILY_REQUEST_CAP) {
            throw new DailyCapError();
        }
        await chrome.storage.local.set({ [LINKXP_DAILY_KEY]: { day: linkxpToday(), count: count + 1 } });
    }

    /**
     * Une requête LinkedIn, journalisée et comptée dans le plafond du jour. Lève LinkedInBlockedError
     * sur 429, 999, ou redirection vers une page de connexion ou de vérification.
     */
    async linkedInRequest(route, path, kind, target = null) {
        await this.countRequest();
        await this.pause();
        const calledAt = Date.now();

        let result;
        try {
            const [injection] = await chrome.scripting.executeScript({
                target: { tabId: this.tabId },
                func: linkxpLinkedInRequest,
                args: [path, kind],
            });
            result = injection?.result || { status: 0, error: 'Aucun résultat d\'injection' };
        } catch (error) {
            // Onglet fermé ou en cours de navigation : on retrouve un onglet LinkedIn et on réessaie une fois
            this.tabId = await this.findLinkedInTab();
            const [injection] = await chrome.scripting.executeScript({
                target: { tabId: this.tabId },
                func: linkxpLinkedInRequest,
                args: [path, kind],
            });
            result = injection?.result || { status: 0, error: String(error.message || error) };
        }
        this.job.lastLinkedInCall = Date.now();

        const entry = {
            route,
            target,
            status: result.status,
            durationMs: result.durationMs || 0,
            success: result.status >= 200 && result.status < 300 && !result.error,
            error: result.error || null,
            anomalies: [],
            calledAt,
        };
        this.logs.push(entry);

        const blockedUrl = /\/(login|checkpoint|authwall|uas\/login)/.test(result.finalUrl || '');
        if (result.status === 429 || result.status === 999 || blockedUrl) {
            entry.success = false;
            entry.anomalies.push(blockedUrl ? 'redirected_to_verification' : `blocked_${result.status}`);
            throw new LinkedInBlockedError(`LinkedIn a bloqué la requête ${route} (${result.status})`);
        }
        if (!entry.success) {
            throw new Error(`Échec LinkedIn ${route} (${result.status || result.error})`);
        }

        return { result, entry };
    }

    async fetchMe() {
        const { result, entry } = await this.linkedInRequest('me', '/voyager/api/me', 'json');
        const me = LinkXPParsers.parseMe(result.body);
        if (!me) {
            entry.success = false;
            entry.anomalies.push('me_unreadable');
            throw new Error('Compte LinkedIn illisible : êtes-vous connecté à LinkedIn ?');
        }
        return me;
    }

    async fetchFollowers(me) {
        const path = `/voyager/api/feed/dash/followingStates/urn:li:fsd_followingState:urn:li:fsd_profile:${me.profileId}`;
        try {
            const { result, entry } = await this.linkedInRequest('following_state', path, 'json');
            const followers = LinkXPParsers.parseFollowerCount(result.body);
            if (followers === null) entry.anomalies.push('followers_missing');
            return followers;
        } catch (error) {
            if (error instanceof LinkedInBlockedError || error instanceof DailyCapError) throw error;
            return null; // non bloquant pour la collecte des publications
        }
    }

    async fetchInventory(me) {
        const publications = [];
        const seen = new Set();
        let token = null;
        let start = 0;

        for (let page = 0; page < LINKXP_COLLECT.INVENTORY_MAX_PAGES; page++) {
            this.progress('inventory', `Inventaire des publications (${publications.length})…`);

            const params = new URLSearchParams({
                count: String(LINKXP_COLLECT.INVENTORY_PAGE_SIZE),
                includeLongTermHistory: 'true',
                moduleKey: 'member-shares:phone',
                numComments: '0',
                numLikes: '0',
                profileUrn: `urn:li:fsd_profile:${me.profileId}`,
                q: 'memberShareFeed',
                start: String(start),
            });
            if (token) params.set('paginationToken', token);

            let response;
            try {
                response = await this.linkedInRequest('profile_updates', `/voyager/api/identity/profileUpdatesV2?${params}`, 'json');
            } catch (error) {
                // Une page suivante en échec : on garde l'inventaire déjà lu
                if (page === 0 || error instanceof LinkedInBlockedError || error instanceof DailyCapError) throw error;
                break;
            }
            const { result, entry } = response;
            const parsed = LinkXPParsers.parseInventoryPage(result.body, me);
            entry.anomalies.push(...parsed.anomalies);
            entry.target = parsed.anomalyTarget;
            if (page === 0 && parsed.elementCount === 0) entry.anomalies.push('inventory_empty');

            for (const pub of parsed.publications) {
                if (seen.has(pub.urn)) {
                    // Une même activité deux fois : on garde la première, mais on le signale
                    if (!entry.anomalies.includes('duplicate_activity')) entry.anomalies.push('duplicate_activity');
                    entry.target = entry.target || pub.urn;
                    continue;
                }
                seen.add(pub.urn);
                publications.push(pub);
            }

            if (!parsed.elementCount || !parsed.paginationToken) break;
            token = parsed.paginationToken;
            start += parsed.elementCount;
        }

        return publications;
    }

    /**
     * Page de statistiques du post, puis commentaires s'il en a et qu'ils doivent être (re)lus.
     * Renvoie une ligne partielle pour l'API ; le détail est complet si visites de profil et abonnés gagnés y sont.
     */
    async fetchPostDetails(item, me) {
        const activityId = LinkXPParsers.activityId(item.urn);
        const row = { urn: item.urn };

        const { result, entry } = await this.linkedInRequest('post_stats', `/analytics/post-summary/urn:li:activity:${activityId}/`, 'stats', item.urn);
        const stats = LinkXPParsers.parseStatsText(result.text);
        entry.anomalies.push(...stats.anomalies);

        if (stats.values.impressions !== null && item.inventoryImpressions && stats.values.impressions < item.inventoryImpressions * 0.9) {
            entry.anomalies.push('stats_impressions_below_inventory');
        }
        for (const key of ['impressions', 'profileViews', 'followersGained', 'reactions', 'comments', 'reposts', 'saves', 'sends']) {
            if (stats.values[key] !== null) row[key] = stats.values[key];
        }

        // Total inchangé depuis le dernier détail : les commentaires déjà comptés restent valables
        if (!item.readComments) {
            return row;
        }

        const totalComments = row.comments ?? item.inventoryComments ?? 0;
        if (totalComments === 0) {
            Object.assign(row, { commentsReaders: 0, commentsAuthor: 0, hasLinkFirstComment: false, detailComments: item.inventoryComments ?? 0 });
            return row;
        }

        const params = `count=100&start=0&q=comments&sortOrder=CHRONOLOGICAL&updateId=${encodeURIComponent(`activity:${activityId}`)}`;
        try {
            const { result: commentsResult, entry: commentsEntry } = await this.linkedInRequest('comments', `/voyager/api/feed/comments?${params}`, 'json', item.urn);
            const comments = LinkXPParsers.parseComments(commentsResult.body, me, item.publishedMs);
            if (comments.fetched === 0) commentsEntry.anomalies.push('comments_empty');

            // Total LinkedIn moins les commentaires de l'auteur trouvés : robuste si des réponses ne sont pas chargées
            row.commentsReaders = Math.max(0, totalComments - comments.authorComments);
            row.commentsAuthor = comments.authorComments;
            row.hasLinkFirstComment = comments.hasLinkFirstComment;
            // Référence pour la prochaine actualisation : le total de l'inventaire, auquel elle sera comparée
            row.detailComments = item.inventoryComments ?? totalComments;
        } catch (error) {
            if (error instanceof LinkedInBlockedError || error instanceof DailyCapError) throw error;
        }

        return row;
    }

    // Lignes collectées en attente : envoyées avant toute nouvelle requête, conservées si l'API échoue
    async flushPendingRows() {
        if (!this.job.pendingRows.length) return;
        await this.savePublications(this.job.pendingRows);
        this.job.pendingRows = [];
        await this.saveJob();
    }

    /**
     * POST /linkedin/publications. Les lignes refusées par l'API (data.errors) ne font pas échouer
     * la requête : on les journalise pour qu'elles ne passent pas inaperçues.
     */
    async savePublications(rows) {
        const response = await this.api.apiRequest('POST', '/linkedin/publications', rows);
        const errors = response?.data?.errors || [];
        const processed = response?.data?.processed_count;

        if (errors.length || (typeof processed === 'number' && processed < rows.length)) {
            // « Publication 3 invalide » : l'index renvoyé par l'API désigne la ligne du lot
            const index = parseInt((String(errors[0] || '').match(/\d+/) || [])[0], 10);
            this.logs.push({
                route: 'api_publications',
                target: rows[index]?.urn || null,
                status: 201,
                durationMs: 0,
                success: false,
                error: `${rows.length - (processed ?? rows.length)} ligne(s) refusée(s) : ${errors.slice(0, 3).join(' ; ')}`.slice(0, 255),
                anomalies: ['api_rows_rejected'],
                calledAt: Date.now(),
            });
        }
        return response;
    }

    // Journal envoyé par lots ; ce qui n'a pas pu partir reste dans le passage persisté
    async flushLogs() {
        const version = chrome.runtime.getManifest().version;
        while (this.logs.length) {
            const entries = this.logs.slice(0, LINKXP_COLLECT.LOG_BATCH_SIZE);
            try {
                await this.api.apiRequest('POST', '/linkedin/collect-log', {
                    run_id: this.job.runId,
                    extension_version: version,
                    entries,
                });
            } catch (error) {
                console.error('Envoi du journal de collecte impossible:', error);
                break;
            }
            this.job.summary.anomalies += entries.filter(l => l.anomalies.length).length;
            this.logs.splice(0, entries.length);
        }
        await this.saveJob();
    }
}
