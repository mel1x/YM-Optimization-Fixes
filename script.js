// Optimization & Privacy - CPU, memory, disk and privacy fixes for Yandex Music:
// - endless FPS probe of the "My Vibe" animation is not scheduled
// - loading shimmer stuck under cached images is cancelled
// - external sprite.svg (reloaded per icon batch, never freed) is inlined once
// - mobx-react-lite observer and ad SDK leaks on page change
// - Ynison state in localStorage: position-only updates once a minute
// - optional: tracking and animations off

(function () {
    if (window.__perfTunerLoaded) return;
    window.__perfTunerLoaded = true;

    const TAG = '[Optimization & Privacy]';
    const SPRITE_URL = '/icons/sprite.svg';
    const SPRITE_PREFIX = SPRITE_URL + '#';
    const XLINK_NS = 'http://www.w3.org/1999/xlink';
    const CONTAINER_ID = 'perf-tuner-sprite';

    const stats = {
        localized: 0,
        skipped: 0,
        fpsProbeBlocked: 0,
        shimmerPaused: 0,
        observerAdmsCleaned: 0,
        ynisonWritten: 0,
        ynisonDeferred: 0,
        trackingBlocked: {},
        playerLogPassed: 0,
        adsdkReused: 0,
    };

    // Hooks must look native: otherwise the ad SDK takes a clean XHR from a new hidden
    // iframe on every page change and never removes it (~6 MB per navigation)
    const nativeToString = Function.prototype.toString;
    const nativeSources = new WeakMap();

    const asNative = (fn, original) => {
        nativeSources.set(fn, nativeToString.call(original));
        Object.defineProperty(fn, 'name', { value: original.name, configurable: true });
        Object.defineProperty(fn, 'length', { value: original.length, configurable: true });
        return fn;
    };

    Function.prototype.toString = asNative(function () {
        return nativeSources.get(this) ?? nativeToString.call(this);
    }, nativeToString);

    const hook = (obj, name, wrap) => {
        const original = obj[name];
        obj[name] = asNative(wrap(original), original);
    };

    const nativeSetAttribute = Element.prototype.setAttribute;
    const nativeRemoveAttribute = Element.prototype.removeAttribute;

    // ---- FPS probe ----

    // Probe loop body: `if(..., t.length<600)return t.push(s), ...`
    const FPS_PROBE_RE = /\.length<600\)return \w+\.push\(/;
    const probeCache = new WeakMap();

    const isFpsProbe = (cb) => {
        let v = probeCache.get(cb);
        if (v === undefined) {
            v = FPS_PROBE_RE.test(nativeToString.call(cb));
            probeCache.set(cb, v);
        }
        return v;
    };

    hook(window, 'requestAnimationFrame', (raf) => function (cb) {
        if (typeof cb === 'function' && isFpsProbe(cb)) {
            stats.fpsProbeBlocked++;
            return 0; // cancelAnimationFrame(0) is a no-op
        }
        return raf.call(window, cb);
    });

    // ---- mobx-react-lite observer leak ----

    // adm.subscribe / getSnapshot share a closure with the render result, so the
    // FinalizationRegistry keeps every discarded render tree alive. Recreate them
    // in closures that only see adm.
    const cleanedAdms = new WeakSet();

    const isObserverAdm = (target, holdings, token) =>
        holdings !== null && typeof holdings === 'object' && holdings === token && target?.current === holdings &&
        typeof holdings.subscribe === 'function' && typeof holdings.getSnapshot === 'function' &&
        'reaction' in holdings && 'onStoreChange' in holdings && 'stateVersion' in holdings;

    const cleanAdm = (registry, adm) => {
        cleanedAdms.add(adm);
        const Reaction = adm.reaction?.constructor;
        const reactionName = adm.reaction?.name_ ?? 'observer' + adm.name;
        adm.subscribe = (onStoreChange) => {
            registry.unregister(adm);
            adm.onStoreChange = onStoreChange;
            if (!adm.reaction && Reaction) {
                adm.reaction = new Reaction(reactionName, () => {
                    adm.stateVersion = Symbol();
                    adm.onStoreChange?.();
                });
                adm.stateVersion = Symbol();
            }
            return () => {
                adm.onStoreChange = null;
                adm.reaction?.dispose();
                adm.reaction = null;
            };
        };
        adm.getSnapshot = () => adm.stateVersion;
        stats.observerAdmsCleaned++;
    };

    if (typeof FinalizationRegistry === 'function') {
        hook(FinalizationRegistry.prototype, 'register', (register) => function (target, holdings, token) {
            if (isObserverAdm(target, holdings, token) && !cleanedAdms.has(holdings)) {
                try {
                    cleanAdm(this, holdings);
                } catch (e) {}
            }
            return register.call(this, target, holdings, token);
        });
    }

    // ---- Ynison state writes ----

    // The whole queue (~800 KB) is saved every 5 s. Real changes are written at once,
    // position-only ones at most once a minute and on page hide.
    const YNISON_KEY_PREFIX = 'pulsesync.ynison-state.v1:';
    const YNISON_PROGRESS_INTERVAL = 60 * 1000;
    // Fields that change on every save
    const PROGRESS_RE = /"progress_ms":[-\d.e+]+|"version":\{"device_id":"[^"]*","version":[-\d.e+]+,"timestamp_ms":[-\d.e+]+\}/g;
    const nativeSetItem = Storage.prototype.setItem;
    const ynisonSaves = new Map(); // key -> { sig, at, pending, timer }

    const isYnisonKey = (storage, key) =>
        storage === window.localStorage && typeof key === 'string' && key.startsWith(YNISON_KEY_PREFIX);

    const writeYnison = (s, storage, key, value) => {
        clearTimeout(s.timer);
        s.timer = null;
        s.pending = null;
        s.at = Date.now();
        nativeSetItem.call(storage, key, value);
        stats.ynisonWritten++;
    };

    const flushYnison = (key) => {
        const s = ynisonSaves.get(key);
        if (!s || s.pending === null) return;
        try {
            writeYnison(s, window.localStorage, key, s.pending);
        } catch (e) {}
    };

    hook(Storage.prototype, 'setItem', (setItem) => function (key, value) {
        if (!isYnisonKey(this, key)) return setItem.call(this, key, value);
        const v = String(value);
        const sig = v.replace(PROGRESS_RE, '');
        let s = ynisonSaves.get(key);
        if (!s) ynisonSaves.set(key, (s = { sig: null, at: 0, pending: null, timer: null }));
        const now = Date.now();
        if (sig !== s.sig || now - s.at >= YNISON_PROGRESS_INTERVAL) {
            s.sig = sig;
            return writeYnison(s, this, key, v);
        }
        s.pending = v;
        stats.ynisonDeferred++;
        if (!s.timer) s.timer = setTimeout(() => flushYnison(key), s.at + YNISON_PROGRESS_INTERVAL - now);
    });

    hook(Storage.prototype, 'getItem', (getItem) => function (key) {
        if (isYnisonKey(this, key)) {
            const pending = ynisonSaves.get(key)?.pending;
            if (pending != null) return pending;
        }
        return getItem.call(this, key);
    });

    hook(Storage.prototype, 'removeItem', (removeItem) => function (key) {
        if (isYnisonKey(this, key)) {
            clearTimeout(ynisonSaves.get(key)?.timer);
            ynisonSaves.delete(key);
        }
        return removeItem.call(this, key);
    });

    for (const type of ['pagehide', 'beforeunload']) {
        window.addEventListener(type, () => {
            for (const key of ynisonSaves.keys()) flushYnison(key);
        });
    }

    // ---- Stuck loading shimmer ----

    const SHIMMER_PROPS = ['backgroundPosition', 'backgroundPositionX', 'backgroundPositionY'];

    const isShimmer = (a) =>
        a instanceof CSSAnimation && a.effect && a.effect.getKeyframes().some((k) => SHIMMER_PROPS.some((p) => p in k));

    // cancel(), not pause(): a paused animation keeps the removed image's tree alive
    const stopShimmer = (img) => {
        if (!img.complete || !img.naturalWidth) return;
        for (const a of img.getAnimations()) {
            if (a.playState === 'running' && isShimmer(a)) {
                a.cancel();
                stats.shimmerPaused++;
            }
        }
    };

    for (const type of ['animationstart', 'load']) {
        document.addEventListener(type, (e) => {
            if (e.target instanceof HTMLImageElement) stopShimmer(e.target);
        }, true);
    }
    for (const img of document.images) stopShimmer(img);

    // ---- Optional animations ----

    const OPTION_CSS = {
        disablePlayingAnimation: `[class*="PlayingAnimation_root"]::before { animation: none !important; }`,
        disableSmoothProgress: `
:root { --transition-disabled: none !important; }
[class*="Timecode_root"] { transition-property: opacity, filter !important; }`,
        // Near-zero durations instead of `none`, so animationend / transitionend still fire
        hardMode: `
*, *::before, *::after {
    animation-duration: 0.001ms !important;
    animation-delay: 0s !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
    transition-delay: 0s !important;
    scroll-behavior: auto !important;
    backdrop-filter: none !important;
}
/* Blurred glows and image copies turn into sharp spots without blur */
[class*="ArtistRecommendationArtwork_root"]::before,
[class*="ArtistRecommendationCard_root"]::before,
[class*="AlbumPromoCard_artistLink"]::after,
[class*="VibePage_bigCardPanelBackground"]::before,
[class*="VibePage_bigCardPanelBackground"]::after,
[class*="AudioAd_backgroundImage"],
[class*="_imageBlurred"] { display: none !important; }
/* Solid backgrounds for surfaces that relied on blur */
.ym-dark-theme, .ym-light-theme { --ym-background-color-primary-enabled-menu: var(--ym-background-color-primary-enabled-popover) !important; }
[class*="InnerHeader_backdrop"], [class*="StickyHeader_backdrop"], [class*="TextHeader_backdrop"] {
    background: var(--ym-background-color-primary-enabled-content) !important;
}
[class*="ArtistsMenu_root"], [class*="WordsCard_popoverContent"], [class*="PulseSync_castPopover"] {
    background-color: var(--ym-background-color-primary-enabled-popover) !important;
}
[class*="WordsCardFullscreen_root"] {
    background-color: color-mix(in srgb, var(--ym-background-color-primary-enabled-content) 92%, transparent) !important;
}`,
    };

    let hardMode = false;

    // The app checks prefers-reduced-motion before its Web Animations effects
    const REDUCED_MOTION_RE = /prefers-reduced-motion\s*:\s*(reduce|no-preference)/;

    hook(window, 'matchMedia', (matchMedia) => function (query) {
        const m = hardMode && REDUCED_MOTION_RE.exec(String(query));
        if (!m) return matchMedia.call(window, query);
        return {
            matches: m[1] === 'reduce',
            media: String(query),
            onchange: null,
            addListener() {},
            removeListener() {},
            addEventListener() {},
            removeEventListener() {},
            dispatchEvent: () => false,
        };
    });

    hook(Element.prototype, 'animate', (animate) => function (keyframes, options) {
        const a = animate.call(this, keyframes, options);
        if (hardMode) a.effect?.updateTiming({ duration: 0, delay: 0, endDelay: 0, iterations: 1 });
        return a;
    });

    // ---- Tracking ----

    // The music API, Ynison, audio and account requests are never touched.
    // Blocked senders get a "success" so they do not retry.
    const TRACKERS = [
        /^https?:\/\/mc\.yandex\.[a-z.]+\//, // Metrika and Webvisor
        /^https?:\/\/(www\.)?yandex\.[a-z.]+\/clck\//, // RUM and error booster
        /^https?:\/\/(log\.)?strm\.yandex\.[a-z.]+\/perf/, // player performance
        /^https?:\/\/(www\.)?yandex\.[a-z.]+\/an\/(count|rtbcount)\//, // ad impressions
    ];
    // Player telemetry: only Start and a rare PlayerAlive pass, so the player still looks real
    const PLAYER_LOG_RE = /^https?:\/\/log\.strm\.yandex\.[a-z.]+\/log\b/;
    const PLAYER_ALIVE_INTERVAL = 5 * 60 * 1000;
    const BLANK_GIF = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

    let trackingOff = false;
    let lastPlayerAlive = 0;

    const toUrl = (input) => {
        try {
            return new URL(input instanceof Request ? input.url : String(input), location.href);
        } catch (e) {
            return null;
        }
    };

    const allowPlayerLog = (url) => {
        const event = url.searchParams.get('event');
        if (event === 'Start') return true;
        const now = Date.now();
        if (event !== 'PlayerAlive' || now - lastPlayerAlive < PLAYER_ALIVE_INTERVAL) return false;
        lastPlayerAlive = now;
        return true;
    };

    const isBlocked = (input) => {
        if (!trackingOff) return false;
        const url = toUrl(input);
        if (!url) return false;
        let blocked = TRACKERS.some((re) => re.test(url.href));
        if (!blocked && PLAYER_LOG_RE.test(url.href)) {
            blocked = !allowPlayerLog(url);
            if (!blocked) stats.playerLogPassed++;
        }
        if (blocked) stats.trackingBlocked[url.host] = (stats.trackingBlocked[url.host] || 0) + 1;
        return blocked;
    };

    hook(Navigator.prototype, 'sendBeacon', (sendBeacon) => function (url, data) {
        if (isBlocked(url)) return true;
        return sendBeacon.call(this, url, data);
    });

    hook(window, 'fetch', (fetch) => function (input, init) {
        if (isBlocked(input)) return Promise.resolve(new Response(null, { status: 204 }));
        return fetch.call(this, input, init);
    });

    const xhrBlocked = new WeakSet();
    const FAKE_XHR_RESPONSE = { readyState: 4, status: 204, statusText: 'No Content', responseText: '', response: '' };

    hook(XMLHttpRequest.prototype, 'open', (open) => function (method, url, ...rest) {
        if (isBlocked(url)) xhrBlocked.add(this);
        else xhrBlocked.delete(this);
        return open.call(this, method, url, ...rest);
    });

    hook(XMLHttpRequest.prototype, 'send', (send) => function (body) {
        if (!xhrBlocked.has(this)) return send.call(this, body);
        for (const [k, v] of Object.entries(FAKE_XHR_RESPONSE)) {
            Object.defineProperty(this, k, { value: v, configurable: true });
        }
        setTimeout(() => {
            for (const type of ['readystatechange', 'load', 'loadend']) this.dispatchEvent(new Event(type));
        }, 0);
    });

    // <script src> fails like with an ad blocker, pixels get a blank gif
    const blockSrc = (el, value) => {
        if (!(el instanceof HTMLScriptElement || el instanceof HTMLImageElement) || !isBlocked(value)) return false;
        if (el instanceof HTMLImageElement) nativeSetAttribute.call(el, 'src', BLANK_GIF);
        else setTimeout(() => el.dispatchEvent(new Event('error')), 0);
        return true;
    };

    // The layout re-adds the ad SDK (121 KB) on every page change. Once it is loaded,
    // new copies only get a "load" event and the app reuses the existing module.
    const ADSDK_RE = /^https:\/\/yandex\.[a-z.]+\/ads\/system\/adsdk\.js$/;

    const reuseAdsdk = (el, value) => {
        if (!(el instanceof HTMLScriptElement) || !ADSDK_RE.test(String(value))) return false;
        if (typeof window.ya?.videoAd?.loadModule !== 'function') return false;
        setTimeout(() => {
            el.dispatchEvent(new Event('load'));
            el.remove();
        }, 0);
        stats.adsdkReused++;
        return true;
    };

    const interceptSrc = (el, value) => blockSrc(el, value) || reuseAdsdk(el, value);

    for (const proto of [HTMLScriptElement.prototype, HTMLImageElement.prototype]) {
        const desc = Object.getOwnPropertyDescriptor(proto, 'src');
        Object.defineProperty(proto, 'src', {
            ...desc,
            set: asNative(function (value) {
                if (!interceptSrc(this, value)) desc.set.call(this, value);
            }, desc.set),
        });
    }

    // ---- Settings ----

    const optionsStyle = document.createElement('style');
    optionsStyle.id = 'perf-tuner-options';
    document.head.appendChild(optionsStyle);

    const isOn = (raw, key) => {
        const v = raw?.[key];
        return Boolean(v && typeof v === 'object' ? (v.value ?? v.default) : v);
    };

    const applyOptions = (raw) => {
        hardMode = isOn(raw, 'hardMode');
        trackingOff = isOn(raw, 'disableTracking');
        optionsStyle.textContent = Object.keys(OPTION_CSS)
            .filter((key) => isOn(raw, key))
            .map((key) => OPTION_CSS[key])
            .join('\n');
    };

    // By addon id, so renaming the addon keeps its settings
    const settings = window.pulsesyncApi?.getSettings?.('optimization-privacy');
    if (settings) {
        applyOptions(settings.getCurrent());
        settings.onChange(applyOptions);
    }

    // ---- Sprite inlining ----

    // Icons get a local href="#id"; xlink:href stays untouched (plain href wins in SVG2)
    const spriteIds = new Set();
    const localized = new WeakSet(); // icons whose href was set by us

    const isUse = (el) => el instanceof SVGUseElement;

    const spriteIdOf = (value) => {
        if (typeof value !== 'string' || !value.startsWith(SPRITE_PREFIX)) return null;
        const id = value.slice(SPRITE_PREFIX.length);
        return spriteIds.has(id) ? id : null;
    };

    const unlocalize = (el) => {
        localized.delete(el);
        nativeRemoveAttribute.call(el, 'href');
    };

    const localize = (el, xlinkValue) => {
        const id = spriteIdOf(xlinkValue);
        if (!id) {
            if (localized.has(el)) unlocalize(el);
            return;
        }
        const plain = el.getAttribute('href');
        // Plain href set by someone else - leave it as is
        if (plain && !localized.has(el)) {
            stats.skipped++;
            return;
        }
        if (plain !== '#' + id) nativeSetAttribute.call(el, 'href', '#' + id);
        if (!localized.has(el)) {
            localized.add(el);
            stats.localized++;
        }
    };

    const installHooks = () => {
        hook(Element.prototype, 'setAttributeNS', (setAttributeNS) => function (ns, name, value) {
            if (ns === XLINK_NS && isUse(this) && (name === 'xlink:href' || name === 'href')) localize(this, String(value));
            return setAttributeNS.call(this, ns, name, value);
        });
        hook(Element.prototype, 'setAttribute', (setAttribute) => function (name, value) {
            if (name === 'src' && interceptSrc(this, value)) return;
            if (isUse(this)) {
                if (name === 'xlink:href') localize(this, String(value));
                else if (name === 'href') localized.delete(this);
            }
            return setAttribute.call(this, name, value);
        });
        hook(Element.prototype, 'removeAttributeNS', (removeAttributeNS) => function (ns, name) {
            if (ns === XLINK_NS && isUse(this) && name === 'href' && localized.has(this)) unlocalize(this);
            return removeAttributeNS.call(this, ns, name);
        });
        hook(Element.prototype, 'removeAttribute', (removeAttribute) => function (name) {
            if (isUse(this) && name === 'xlink:href' && localized.has(this)) unlocalize(this);
            return removeAttribute.call(this, name);
        });
    };

    const sweep = (root) => {
        const list = isUse(root) ? [root] : root.querySelectorAll ? root.querySelectorAll('use') : [];
        for (const el of list) {
            const x = el.getAttributeNS(XLINK_NS, 'href');
            if (x) localize(el, x);
        }
    };

    // Icons created from markup (innerHTML etc.) bypass the setters
    const observeMarkup = () => {
        new MutationObserver((records) => {
            for (const r of records) {
                for (const n of r.addedNodes) {
                    if (n.nodeType === 1 && (n.localName === 'use' || n.localName === 'svg' || n.firstElementChild)) sweep(n);
                }
            }
        }).observe(document.documentElement, { childList: true, subtree: true });
    };

    const inlineSprite = async () => {
        const res = await fetch(SPRITE_URL);
        if (!res.ok) throw new Error('sprite fetch failed: ' + res.status);
        const parsed = new DOMParser().parseFromString(await res.text(), 'image/svg+xml');
        if (parsed.querySelector('parsererror')) throw new Error('sprite parse failed');

        const container = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        container.id = CONTAINER_ID;
        container.setAttribute('aria-hidden', 'true');
        container.setAttribute('focusable', 'false');
        // Not display:none - gradients and clip paths inside hidden svg can stop rendering
        container.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none');
        for (const child of [...parsed.documentElement.childNodes]) container.appendChild(document.importNode(child, true));

        for (const sym of container.querySelectorAll('symbol[id]')) {
            // An id already in the page would win over the sprite symbol
            if (!document.getElementById(sym.id)) spriteIds.add(sym.id);
        }
        document.body.appendChild(container);
    };

    const start = async () => {
        if (document.getElementById(CONTAINER_ID)) return;
        installHooks(); // before the sprite: setAttribute also blocks tracker src
        try {
            await inlineSprite();
        } catch (e) {
            console.warn(TAG, 'sprite inline disabled:', e);
            return;
        }
        sweep(document);
        observeMarkup();
        console.info(TAG, `sprite inlined: ${spriteIds.size} icons, localized ${stats.localized}, skipped ${stats.skipped}`);
    };

    window.__perfTunerStats = () => ({ ...stats, spriteIds: spriteIds.size });

    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
