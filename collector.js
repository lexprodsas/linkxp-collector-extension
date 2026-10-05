/**
 * Collecte LinkedIn V1 (lot 1) : inventaire voyager, page de statistiques par post, commentaires.
 *
 * Toutes les requêtes LinkedIn sont exécutées DANS un onglet linkedin.com (chrome.scripting),
 * avec la session de l'utilisateur : même origine, cookies et jeton CSRF disponibles.
 * Garde-fous : déclenchée par l'utilisateur, une requête à la fois, 3 à 5 s entre deux requêtes,
 * 100 posts au plus en collecte détaillée par passage, arrêt immédiat sur un signal de blocage.
 *
 * Chargé par background.js via importScripts().
 */

const LINKXP_COLLECT = {
    INVENTORY_PAGE_SIZE: 50,
    INVENTORY_MAX_PAGES: 10,          // 500 activités au plus
    MAX_DETAILED_POSTS: 100,          // posts passés en collecte détaillée par passage
    DELAY_MIN_MS: 3000,
    DELAY_MAX_MS: 5000,
    API_BATCH_SIZE: 50,               // publications par POST d'inventaire
    STATS_BATCH_SIZE: 10,             // publications par POST de collecte détaillée
    LOG_BATCH_SIZE: 200,
    MATURITY_DAYS: 7,                 // un post n'est comparable qu'à partir de J+7
    REFRESH_WINDOW_DAYS: 90,          // posts récents dont on rafraîchit le détail
    REFRESH_AFTER_DAYS: 7,
    FIRST_COMMENT_LINK_WINDOW_MS: 30 * 60 * 1000,
};

const DAY_MS = 24 * 60 * 60 * 1000;

class LinkedInBlockedError extends Error {
    constructor(message) {
        super(message);
        this.name = 'LinkedInBlockedError';
    }
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

        for (const elementUrn of elementUrns) {
            // Seuls les éléments de premier niveau : un post repartagé avec commentaire
            // inclut aussi l'UpdateV2 d'origine, qui n'est pas une activité du membre.
            const update = byUrn.get(elementUrn);
            const urn = update?.updateMetadata?.urn;
            if (!update || !/^urn:li:activity:\d+$/.test(urn || '')) {
                anomalies.add('update_unreadable');
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

            if (!counts) anomalies.add('counts_missing');
            // Les très anciens posts n'ont pas d'impressions : seul un post récent sans impressions est suspect
            if (!isRepost && counts && typeof counts.numImpressions !== 'number'
                && Date.now() - publishedMs < 365 * DAY_MS) anomalies.add('impressions_missing');
            if (!isRepost && !text && !update.content) anomalies.add('empty_post');

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

    /**
     * Posts originaux à passer en collecte détaillée, par priorité :
     * 1. jamais collectés en détail (les plus récents d'abord) ;
     * 2. collectés avant J+7 et désormais matures ;
     * 3. publiés depuis moins de 90 jours et collectés il y a plus de 7 jours.
     */
    selectPostsForDetail(publications, stateRows, nowMs) {
        const state = new Map((stateRows || []).map(row => [row.urn, row]));
        const buckets = [[], [], []];

        for (const pub of publications) {
            if (pub.type !== 'original') continue;

            const publishedMs = LinkXPParsers.publishedMsFromActivityUrn(pub.urn);
            const collectedSec = state.get(pub.urn)?.stats_collected_at;
            const collectedMs = collectedSec ? collectedSec * 1000 : null;
            const maturityMs = publishedMs + LINKXP_COLLECT.MATURITY_DAYS * DAY_MS;

            if (!collectedMs) {
                buckets[0].push(pub);
            } else if (collectedMs < maturityMs && nowMs >= maturityMs) {
                buckets[1].push(pub);
            } else if (nowMs - publishedMs < LINKXP_COLLECT.REFRESH_WINDOW_DAYS * DAY_MS
                && nowMs - collectedMs > LINKXP_COLLECT.REFRESH_AFTER_DAYS * DAY_MS) {
                buckets[2].push(pub);
            }
        }

        const newestFirst = (a, b) => LinkXPParsers.publishedMsFromActivityUrn(b.urn) - LinkXPParsers.publishedMsFromActivityUrn(a.urn);
        return buckets.flatMap(bucket => bucket.sort(newestFirst)).slice(0, LINKXP_COLLECT.MAX_DETAILED_POSTS);
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
// Orchestration d'un passage de collecte
// ========================================

class LinkXPCollector {
    /**
     * @param api       instance de BackgroundLinkXPAuth (appels à l'API LinkXP)
     * @param onProgress callback(state) pour la popup
     */
    constructor(api, onProgress) {
        this.api = api;
        this.onProgress = onProgress || (() => {});
        this.runId = crypto.randomUUID();
        this.logs = [];
        this.tabId = null;
        this.lastLinkedInCall = 0;
    }

    async run() {
        const summary = { inventory: 0, originals: 0, detailed: 0, followers: null, anomalies: 0 };

        try {
            this.tabId = await this.findLinkedInTab();

            this.progress('profile', 'Lecture du compte LinkedIn…');
            const me = await this.fetchMe();

            const followers = await this.fetchFollowers(me);
            if (followers !== null) {
                summary.followers = followers;
                await this.api.apiRequest('POST', '/linkedin/profile', { followers });
            }

            const publications = await this.fetchInventory(me);
            summary.inventory = publications.length;
            summary.originals = publications.filter(p => p.type === 'original').length;

            this.progress('inventory_sync', `Envoi de ${publications.length} publications…`);
            for (let i = 0; i < publications.length; i += LINKXP_COLLECT.API_BATCH_SIZE) {
                await this.api.apiRequest('POST', '/linkedin/publications', publications.slice(i, i + LINKXP_COLLECT.API_BATCH_SIZE));
            }

            const state = await this.api.apiRequest('GET', '/linkedin/publications/state');
            const selected = LinkXPParsers.selectPostsForDetail(publications, state?.data || [], Date.now());

            let batch = [];
            for (const [index, pub] of selected.entries()) {
                this.progress('details', `Statistiques détaillées ${index + 1}/${selected.length}…`, index, selected.length);
                try {
                    batch.push(await this.fetchPostDetails(pub, me));
                    summary.detailed++;
                } catch (error) {
                    // Échec isolé (déjà journalisé) : on passe au post suivant, sauf blocage
                    if (error instanceof LinkedInBlockedError) throw error;
                }

                if (batch.length >= LINKXP_COLLECT.STATS_BATCH_SIZE) {
                    await this.api.apiRequest('POST', '/linkedin/publications', batch);
                    batch = [];
                }
            }
            if (batch.length) {
                await this.api.apiRequest('POST', '/linkedin/publications', batch);
            }

            summary.anomalies = this.logs.filter(l => l.anomalies.length).length;
            return { ok: true, summary };

        } catch (error) {
            const blocked = error instanceof LinkedInBlockedError;
            return {
                ok: false,
                blocked,
                // Côté utilisateur : un message neutre plutôt que des chiffres faux
                error: blocked ? 'Collecte momentanément indisponible. Réessayez plus tard.' : error.message,
                summary,
            };
        } finally {
            await this.flushLogs();
        }
    }

    progress(phase, message, done = null, total = null) {
        this.onProgress({ phase, message, done, total, runId: this.runId });
    }

    async findLinkedInTab() {
        const tabs = await chrome.tabs.query({ url: 'https://www.linkedin.com/*' });
        const tab = tabs.find(t => t.active) || tabs[0];
        if (tab) return tab.id;

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
        const wait = LINKXP_COLLECT.DELAY_MIN_MS + Math.random() * (LINKXP_COLLECT.DELAY_MAX_MS - LINKXP_COLLECT.DELAY_MIN_MS);
        const elapsed = Date.now() - this.lastLinkedInCall;
        if (this.lastLinkedInCall && elapsed < wait) {
            await new Promise(resolve => setTimeout(resolve, wait - elapsed));
        }
    }

    /**
     * Une requête LinkedIn, journalisée. Lève LinkedInBlockedError sur 429, 999,
     * ou redirection vers une page de connexion ou de vérification.
     */
    async linkedInRequest(route, path, kind, target = null) {
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
        this.lastLinkedInCall = Date.now();

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
            if (error instanceof LinkedInBlockedError) throw error;
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
                if (page === 0 || error instanceof LinkedInBlockedError) throw error;
                break;
            }
            const { result, entry } = response;
            const parsed = LinkXPParsers.parseInventoryPage(result.body, me);
            entry.anomalies.push(...parsed.anomalies);
            if (page === 0 && parsed.elementCount === 0) entry.anomalies.push('inventory_empty');

            for (const pub of parsed.publications) {
                if (!seen.has(pub.urn)) {
                    seen.add(pub.urn);
                    publications.push(pub);
                }
            }

            if (!parsed.elementCount || !parsed.paginationToken) break;
            token = parsed.paginationToken;
            start += parsed.elementCount;
        }

        return publications;
    }

    /**
     * Page de statistiques du post, puis commentaires si le post en a.
     * Renvoie une ligne partielle pour l'API (statsCollected = true).
     */
    async fetchPostDetails(pub, me) {
        const activityId = LinkXPParsers.activityId(pub.urn);
        const publishedMs = LinkXPParsers.publishedMsFromActivityUrn(pub.urn);
        const row = { urn: pub.urn, statsCollected: true };

        const { result, entry } = await this.linkedInRequest('post_stats', `/analytics/post-summary/urn:li:activity:${activityId}/`, 'stats', pub.urn);
        const stats = LinkXPParsers.parseStatsText(result.text);
        entry.anomalies.push(...stats.anomalies);

        if (stats.values.impressions !== null && pub.impressions && stats.values.impressions < pub.impressions * 0.9) {
            entry.anomalies.push('stats_impressions_below_inventory');
        }
        for (const key of ['impressions', 'profileViews', 'followersGained', 'reactions', 'comments', 'reposts', 'saves', 'sends']) {
            if (stats.values[key] !== null) row[key] = stats.values[key];
        }

        const totalComments = row.comments ?? pub.comments ?? 0;
        if (totalComments === 0) {
            row.commentsReaders = 0;
            row.hasLinkFirstComment = false;
            return row;
        }

        const params = `count=100&start=0&q=comments&sortOrder=CHRONOLOGICAL&updateId=${encodeURIComponent(`activity:${activityId}`)}`;
        try {
            const { result: commentsResult, entry: commentsEntry } = await this.linkedInRequest('comments', `/voyager/api/feed/comments?${params}`, 'json', pub.urn);
            const comments = LinkXPParsers.parseComments(commentsResult.body, me, publishedMs);
            if (comments.fetched === 0) commentsEntry.anomalies.push('comments_empty');

            // Total LinkedIn moins les commentaires de l'auteur trouvés : robuste si des réponses ne sont pas chargées
            row.commentsReaders = Math.max(0, totalComments - comments.authorComments);
            row.hasLinkFirstComment = comments.hasLinkFirstComment;
        } catch (error) {
            if (error instanceof LinkedInBlockedError) throw error;
        }

        return row;
    }

    async flushLogs() {
        const version = chrome.runtime.getManifest().version;
        for (let i = 0; i < this.logs.length; i += LINKXP_COLLECT.LOG_BATCH_SIZE) {
            try {
                await this.api.apiRequest('POST', '/linkedin/collect-log', {
                    run_id: this.runId,
                    extension_version: version,
                    entries: this.logs.slice(i, i + LINKXP_COLLECT.LOG_BATCH_SIZE),
                });
            } catch (error) {
                console.error('Envoi du journal de collecte impossible:', error);
            }
        }
    }
}
