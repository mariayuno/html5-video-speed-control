// ==UserScript==
// @name         HTML5 Video Speed Controls
// @namespace    https://github.com/mariayuno/html5-video-speed-control
// @version      2.2
// @description  Simple keyboard controls for HTML5 video speed and frame-stepping
// @author       lunagus, mariayuno
// @license      MIT
// @match        *://*/*
// @grant        none
// @run-at       document-end
// @updateURL    https://raw.githubusercontent.com/mariayuno/html5-video-speed-control/main/videospeedcontrols.user.js
// @downloadURL  https://raw.githubusercontent.com/mariayuno/html5-video-speed-control/main/videospeedcontrols.user.js
// ==/UserScript==

(function () {
    'use strict';

    // ─────────────────────────────────────────────
    //  CONFIGURATION
    // ─────────────────────────────────────────────

    const CONFIG = {
        SPEED_STEP:       0.1,
        CYCLE_SPEEDS:     [1, 2, 3],
        MIN_SPEED:        0.1,
        MAX_SPEED:        16,
        TOOLTIP_DURATION: 1500,
        TOOLTIP_FADE:     300,
        FLOAT_CORNER:     'top-left',   // top-left | top-right | bottom-left | bottom-right
        FLOAT_OFFSET:     12,           // px from the video edge
        KEYS: {
            SPEED_UP:   'd',
            SPEED_DOWN: 's',
            RESET:      'r',
            CYCLE:      ['g', '\\'],
            FRAME_PREV: 'q',
            FRAME_NEXT: 'e',
        },
        // Known toolbar selectors [selector, 'append'|'prepend']
        TOOLBAR_SELECTORS: [
            ['.ytp-left-controls',                    'append'],   // YouTube
            ['.vp-controls',                          'append'],   // Vimeo
            ['.player-controls__right-control-group', 'prepend'],  // Twitch
            ['.vjs-control-bar',                      'append'],   // Video.js
            ['.plyr__controls',                       'append'],   // Plyr
            ['.jw-controlbar',                        'append'],   // JW Player
            ['[class*="control-bar"]',                'append'],
            ['[class*="controlBar"]',                 'append'],
            ['[class*="controls-bar"]',               'append'],
            ['[class*="player-controls"]',            'append'],
            ['[class*="playerControls"]',             'append'],
        ],
    };

    // ─────────────────────────────────────────────
    //  State
    // ─────────────────────────────────────────────

    let activeVideo  = null;
    let cycleIndex   = 0;
    let tooltipEl    = null;
    let tooltipTimer = null;
    let currentSpeed = 1.0;
    let floatBtn     = null;
    let toolbarBtn   = null;
    let panel        = null;
    let panelOpen    = false;
    let pollTimer    = null;
    let rafId        = null;

    // ─────────────────────────────────────────────
    //  Top layer helpers
    //  Popover elements render in the browser's top layer, above ALL page UI
    //  (player overlays, z-index wars, even fullscreen).
    // ─────────────────────────────────────────────

    function uiRoot() {
        const fs = document.fullscreenElement;
        // A <video> can't have children, so fall back to body in that case
        return (fs && fs.tagName !== 'VIDEO') ? fs : document.body;
    }

    function topLayer(el) {
        if (!el || !el.isConnected) return;
        try {
            el.setAttribute('popover', 'manual');
            try { el.hidePopover(); } catch (_) {}
            el.showPopover();
        } catch (_) {}
    }

    function mountInRoot(el) {
        const root = uiRoot();
        if (el.parentNode !== root) root.appendChild(el);
        topLayer(el);
    }

    function isReallyVisible(el) {
        if (!el || !el.isConnected) return false;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        for (let n = el, i = 0; n && i < 8; n = n.parentElement, i++) {
            const cs = getComputedStyle(n);
            if (cs.opacity === '0' || cs.visibility === 'hidden' || cs.display === 'none') return false;
        }
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!hit && el.contains(hit);
    }

    // ─────────────────────────────────────────────
    //  Tooltip
    // ─────────────────────────────────────────────

    function showTooltip(msg) {
        const root = uiRoot();
        if (tooltipEl && tooltipEl.parentNode !== root) { tooltipEl.remove(); tooltipEl = null; }
        if (!tooltipEl) {
            tooltipEl = document.createElement('div');
            tooltipEl.style.cssText = `
                position:fixed;top:20px;left:50%;transform:translateX(-50%);
                margin:0;inset:auto;overflow:visible;border:none;
                background:rgba(0,0,0,0.75);color:#fff;padding:8px 16px;
                border-radius:4px;font-family:Arial,sans-serif;font-size:16px;
                z-index:2147483647;pointer-events:none;
                transition:opacity 0.3s ease;box-shadow:0 2px 8px rgba(0,0,0,0.4);
            `;
            tooltipEl.style.top = '20px';
            tooltipEl.style.left = '50%';
            root.appendChild(tooltipEl);
        }
        topLayer(tooltipEl);
        tooltipEl.textContent = msg;
        tooltipEl.style.opacity = '1';
        tooltipEl.style.display = 'block';
        clearTimeout(tooltipTimer);
        tooltipTimer = setTimeout(() => {
            tooltipEl.style.opacity = '0';
            setTimeout(() => { if (tooltipEl) tooltipEl.style.display = 'none'; }, CONFIG.TOOLTIP_FADE);
        }, CONFIG.TOOLTIP_DURATION);
    }

    // ─────────────────────────────────────────────
    //  Video detection
    // ─────────────────────────────────────────────

    function findBestVideo() {
        const all = Array.from(document.querySelectorAll('video'));
        if (!all.length) return null;
        if (all.length === 1) return all[0];
        const playing = all.find(v => !v.paused && v.readyState > 1);
        if (playing) return playing;
        return all.reduce((a, b) => {
            const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
            return ra.width * ra.height >= rb.width * rb.height ? a : b;
        });
    }

    function updateActiveVideo() {
        const v = findBestVideo();
        if (v && v !== activeVideo) { activeVideo = v; currentSpeed = +v.playbackRate.toFixed(1); }
    }

    // ─────────────────────────────────────────────
    //  Frame stepping
    // ─────────────────────────────────────────────

    function estimateFPS(video) {
        try {
            const q = video.getVideoPlaybackQuality();
            if (q && video.currentTime > 0 && q.totalVideoFrames > 0)
                return q.totalVideoFrames / video.currentTime;
        } catch (_) {}
        return 30;
    }

    function stepFrame(video, dir) {
        if (!video || !video.duration) return;
        video.pause();
        const fd = 1 / estimateFPS(video);
        video.currentTime = dir < 0
            ? Math.max(0, video.currentTime - fd)
            : Math.min(video.duration, video.currentTime + fd);
    }

    // ─────────────────────────────────────────────
    //  Speed
    // ─────────────────────────────────────────────

    function setSpeed(rate) {
        if (!activeVideo) return;
        currentSpeed = +Math.min(CONFIG.MAX_SPEED, Math.max(CONFIG.MIN_SPEED, rate)).toFixed(1);
        activeVideo.playbackRate = currentSpeed;
        updateUI();
        showTooltip(`Speed: ${currentSpeed.toFixed(1)}x`);
    }

    // ─────────────────────────────────────────────
    //  Control panel
    // ─────────────────────────────────────────────

    function buildPanel(anchor) {
        if (panel) panel.remove();
        panel = document.createElement('div');
        panel.style.cssText = `
            position:fixed;margin:0;inset:auto;overflow:visible;
            background:rgba(20,20,20,0.93);border:1px solid rgba(255,255,255,0.15);
            border-radius:8px;padding:10px 12px;z-index:2147483646;
            font-family:Arial,sans-serif;font-size:13px;color:#fff;
            min-width:190px;box-shadow:0 4px 16px rgba(0,0,0,0.6);
            backdrop-filter:blur(8px);user-select:none;
        `;

        const mkBtn = (txt, tip, fn) => {
            const b = document.createElement('button');
            b.textContent = txt; b.title = tip;
            b.style.cssText = `background:rgba(255,255,255,0.12);border:none;color:#fff;
                border-radius:4px;padding:3px 9px;cursor:pointer;font-size:13px;flex-shrink:0;`;
            b.onmouseenter = () => b.style.background = 'rgba(255,255,255,0.25)';
            b.onmouseleave = () => b.style.background = 'rgba(255,255,255,0.12)';
            b.onclick = e => { e.stopPropagation(); fn(); };
            return b;
        };

        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:8px;';
        const disp = document.createElement('span');
        disp.className = 'vsc-disp';
        disp.style.cssText = 'flex:1;text-align:center;font-weight:bold;font-size:15px;';
        disp.textContent = `${currentSpeed.toFixed(1)}x`;
        row.append(
            mkBtn('−', 'Slow down (s)', () => setSpeed(currentSpeed - CONFIG.SPEED_STEP)),
            disp,
            mkBtn('+', 'Speed up (d)',  () => setSpeed(currentSpeed + CONFIG.SPEED_STEP))
        );
        panel.appendChild(row);

        const sl = document.createElement('input');
        sl.type = 'range'; sl.min = CONFIG.MIN_SPEED; sl.max = 4;
        sl.step = CONFIG.SPEED_STEP; sl.value = currentSpeed;
        sl.className = 'vsc-slider';
        sl.style.cssText = 'width:100%;accent-color:#fff;margin-bottom:8px;cursor:pointer;display:block;';
        sl.oninput = e => { e.stopPropagation(); setSpeed(+sl.value); };
        sl.onclick = e => e.stopPropagation();
        panel.appendChild(sl);

        const presets = document.createElement('div');
        presets.style.cssText = 'display:flex;gap:5px;';
        CONFIG.CYCLE_SPEEDS.forEach(spd => {
            const pb = mkBtn(`${spd}x`, `Set ${spd}x`, () => {
                setSpeed(spd); cycleIndex = CONFIG.CYCLE_SPEEDS.indexOf(spd);
            });
            pb.className = `vsc-preset vsc-p${spd}`;
            pb.style.flex = '1';
            presets.appendChild(pb);
        });
        const rb = mkBtn('↺', 'Reset (r)', () => { setSpeed(1.0); cycleIndex = 0; });
        rb.style.flex = '1';
        presets.appendChild(rb);
        panel.appendChild(presets);

        uiRoot().appendChild(panel);
        topLayer(panel);

        // Place above the anchor, or below it if there's no room above
        const ar = anchor.getBoundingClientRect();
        const ph = panel.offsetHeight, pw = panel.offsetWidth;
        const top = ar.top - ph - 6 >= 4 ? ar.top - ph - 6 : ar.bottom + 6;
        panel.style.left = `${Math.min(Math.max(4, ar.left), innerWidth - pw - 4)}px`;
        panel.style.top  = `${Math.min(Math.max(4, top), innerHeight - ph - 4)}px`;

        panelOpen = true;
        updateUI();
        setTimeout(() => document.addEventListener('click', outsideClose, true), 0);
    }

    function outsideClose(e) {
        if (panel && (panel.contains(e.target) || floatBtn?.contains(e.target) || toolbarBtn?.contains(e.target))) return;
        closePanel();
    }

    function closePanel() {
        document.removeEventListener('click', outsideClose, true);
        panel?.remove(); panel = null; panelOpen = false;
    }

    function togglePanel(anchor) { panelOpen ? closePanel() : buildPanel(anchor); }

    // ─────────────────────────────────────────────
    //  Update UI
    // ─────────────────────────────────────────────

    function updateUI() {
        const lbl = `${currentSpeed.toFixed(1)}x`;
        [floatBtn, toolbarBtn].forEach(b => {
            if (!b) return;
            const l = b.querySelector('.vsc-lbl');
            if (l) l.textContent = lbl;
        });

        if (floatBtn) {
            // Toolbar button wins while it's genuinely visible; float covers when it's hidden/missing
            const tbVisible = isReallyVisible(toolbarBtn);
            floatBtn.style.opacity       = tbVisible ? '0' : (currentSpeed !== 1.0 ? '1' : '0.45');
            floatBtn.style.pointerEvents = tbVisible ? 'none' : 'auto';
        }

        if (panel) {
            const d = panel.querySelector('.vsc-disp');   if (d) d.textContent = lbl;
            const s = panel.querySelector('.vsc-slider'); if (s) s.value = currentSpeed;
            panel.querySelectorAll('.vsc-preset').forEach(pb => {
                pb.style.background = parseFloat(pb.textContent) === currentSpeed
                    ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.12)';
            });
        }
    }

    // ─────────────────────────────────────────────
    //  Float button — fixed, top layer, tracks the video's rect
    // ─────────────────────────────────────────────

    function buildFloatBtn() {
        if (floatBtn?.isConnected) return;
        floatBtn?.remove();

        floatBtn = document.createElement('div');
        floatBtn.id = 'vsc-float';
        floatBtn.style.cssText = `
            position:fixed;margin:0;inset:auto;overflow:visible;
            z-index:2147483645;cursor:pointer;
            font-family:Arial,sans-serif;font-size:12px;font-weight:bold;
            color:rgba(255,255,255,0.95);background:rgba(0,0,0,0.6);
            border-radius:4px;padding:3px 8px;
            backdrop-filter:blur(4px);border:1px solid rgba(255,255,255,0.2);
            transition:opacity 0.2s,background 0.15s;user-select:none;opacity:0.45;
        `;
        const lbl = document.createElement('span');
        lbl.className = 'vsc-lbl';
        lbl.textContent = `${currentSpeed.toFixed(1)}x`;
        floatBtn.appendChild(lbl);

        floatBtn.onmouseenter = () => floatBtn.style.background = 'rgba(0,0,0,0.85)';
        floatBtn.onmouseleave = () => floatBtn.style.background = 'rgba(0,0,0,0.6)';
        floatBtn.onclick = e => { e.stopPropagation(); togglePanel(floatBtn); };
        // Keep the player from reacting (pause/seek) when the button is pressed
        ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'touchstart']
            .forEach(t => floatBtn.addEventListener(t, e => e.stopPropagation()));

        mountInRoot(floatBtn);
        positionFloatBtn();
        startPositionTracking();
    }

    function positionFloatBtn() {
        if (!floatBtn || !activeVideo) return;
        const r = activeVideo.getBoundingClientRect();
        const hidden = r.width === 0 || r.height === 0 || r.bottom < 0 || r.top > innerHeight;
        floatBtn.style.visibility = hidden ? 'hidden' : 'visible';
        if (hidden) return;
        const fw = floatBtn.offsetWidth, fh = floatBtn.offsetHeight;
        const o = CONFIG.FLOAT_OFFSET, c = CONFIG.FLOAT_CORNER;
        const x = c.endsWith('left') ? r.left + o : r.right - fw - o;
        const y = c.startsWith('top') ? r.top + o : r.bottom - fh - o;
        floatBtn.style.left = `${Math.min(Math.max(0, x), innerWidth - fw)}px`;
        floatBtn.style.top  = `${Math.min(Math.max(0, y), innerHeight - fh)}px`;
    }

    function startPositionTracking() {
        cancelAnimationFrame(rafId);
        const tick = () => { positionFloatBtn(); rafId = requestAnimationFrame(tick); };
        rafId = requestAnimationFrame(tick);
    }

    // ─────────────────────────────────────────────
    //  Toolbar button
    // ─────────────────────────────────────────────

    function tryBuildToolbarBtn() {
        if (toolbarBtn?.isConnected) return true;
        toolbarBtn?.remove();
        toolbarBtn = null;

        for (const [sel, pos] of CONFIG.TOOLBAR_SELECTORS) {
            const el = document.querySelector(sel);
            if (!el) continue;

            const wrap = document.createElement('div');
            wrap.id = 'vsc-toolbar-btn';
            wrap.style.cssText = `
                position:relative;display:inline-flex;align-items:center;
                height:100%;cursor:pointer;padding:0 7px;
                font-family:Arial,sans-serif;font-size:12px;font-weight:bold;
                color:rgba(255,255,255,0.95);border-radius:4px;
                transition:background 0.15s;flex-shrink:0;
            `;
            wrap.onmouseenter = () => wrap.style.background = 'rgba(255,255,255,0.15)';
            wrap.onmouseleave = () => wrap.style.background = 'transparent';
            wrap.title = 'Video Speed Controls';

            const lbl = document.createElement('span');
            lbl.className = 'vsc-lbl';
            lbl.textContent = `${currentSpeed.toFixed(1)}x`;
            wrap.appendChild(lbl);
            wrap.onclick = e => { e.stopPropagation(); togglePanel(wrap); };

            pos === 'prepend' ? el.prepend(wrap) : el.appendChild(wrap);
            toolbarBtn = wrap;
            updateUI();
            return true;
        }
        return false;
    }

    // ─────────────────────────────────────────────
    //  Setup
    // ─────────────────────────────────────────────

    function setup() {
        if (!activeVideo) return;
        buildFloatBtn();

        clearInterval(pollTimer);
        let tries = 0;
        pollTimer = setInterval(() => {
            tryBuildToolbarBtn();
            updateUI();
            if (++tries > 60 || toolbarBtn?.isConnected) clearInterval(pollTimer);
        }, 500);
    }

    // ─────────────────────────────────────────────
    //  Keys
    // ─────────────────────────────────────────────

    function handleKey(e) {
        const t = e.target;
        if (t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA' || t?.isContentEditable) return;
        if (e.ctrlKey || e.altKey || e.metaKey) return;
        if (!activeVideo?.isConnected) updateActiveVideo();
        if (!activeVideo) return;

        const key = e.key === '\\' ? '\\' : e.key.toLowerCase();
        const K = CONFIG.KEYS;
        let handled = true;

        if      (key === K.SPEED_UP)    setSpeed(currentSpeed + CONFIG.SPEED_STEP);
        else if (key === K.SPEED_DOWN)  setSpeed(currentSpeed - CONFIG.SPEED_STEP);
        else if (key === K.RESET)       { setSpeed(1.0); cycleIndex = 0; }
        else if (K.CYCLE.includes(key)) { cycleIndex = (cycleIndex + 1) % CONFIG.CYCLE_SPEEDS.length; setSpeed(CONFIG.CYCLE_SPEEDS[cycleIndex]); }
        else if (key === K.FRAME_PREV)  { stepFrame(activeVideo, -1); showTooltip('◄ Previous Frame'); }
        else if (key === K.FRAME_NEXT)  { stepFrame(activeVideo,  1); showTooltip('Next Frame ►'); }
        else handled = false;

        if (handled) { e.preventDefault(); e.stopPropagation(); }
    }

    // ─────────────────────────────────────────────
    //  Init
    // ─────────────────────────────────────────────

    function init() {
        updateActiveVideo();
        document.addEventListener('keydown', handleKey, true);

        document.addEventListener('play', e => {
            if (!(e.target instanceof HTMLVideoElement)) return;
            const wasNew = e.target !== activeVideo;
            activeVideo = e.target;
            currentSpeed = +activeVideo.playbackRate.toFixed(1);
            if (wasNew || !floatBtn?.isConnected) setup();
        }, true);

        // Keep UI in sync when the site (or anything else) changes the rate
        document.addEventListener('ratechange', e => {
            if (e.target === activeVideo) { currentSpeed = +activeVideo.playbackRate.toFixed(1); updateUI(); }
        }, true);

        // Re-home UI into the fullscreen element (or back to body) on toggle
        document.addEventListener('fullscreenchange', () => {
            if (floatBtn?.isConnected) mountInRoot(floatBtn);
            if (panel?.isConnected) mountInRoot(panel);
            if (tooltipEl) { tooltipEl.remove(); tooltipEl = null; }
        });

        new MutationObserver(mutations => {
            for (const m of mutations)
                for (const node of m.addedNodes)
                    if (node instanceof Element &&
                        (node.tagName === 'VIDEO' || node.querySelectorAll?.('video').length)) {
                        updateActiveVideo();
                        if (!floatBtn?.isConnected) setup();
                    }
        }).observe(document.body || document.documentElement, { childList: true, subtree: true });

        // Watchdog: if the site re-renders and drops our UI, bring it back
        setInterval(() => {
            if (!activeVideo?.isConnected) updateActiveVideo();
            if (!activeVideo) return;
            if (!floatBtn?.isConnected) { floatBtn = null; setup(); return; }
            try { if (!floatBtn.matches(':popover-open')) topLayer(floatBtn); } catch (_) {}
            if (floatBtn.parentNode !== uiRoot()) mountInRoot(floatBtn);
            if (!toolbarBtn?.isConnected) tryBuildToolbarBtn();
            updateUI();
        }, 1000);

        if (activeVideo) setup();
    }

    document.body ? init() : document.addEventListener('DOMContentLoaded', init);

})();
