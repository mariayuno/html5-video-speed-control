// ==UserScript==
// @name         HTML5 Video Speed Controls
// @namespace    https://github.com/mariayuno/html5-video-speed-control
// @version      2.0
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
        KEYS: {
            SPEED_UP:   'd',
            SPEED_DOWN: 's',
            RESET:      'r',
            CYCLE:      ['g', '\\'],
            FRAME_PREV: 'q',
            FRAME_NEXT: 'e',
        },
        // Known control bar selectors [selector, 'append'|'prepend']
        TOOLBAR_SELECTORS: [
            ['.ytp-left-controls',                    'append'],
            ['.vp-controls',                          'append'],
            ['.player-controls__right-control-group', 'prepend'],
            ['.vjs-control-bar',                      'append'],
            ['.plyr__controls',                       'append'],
            ['.jw-controlbar',                        'append'],
            ['.vilos-controls-top',                   'append'],  // Crunchyroll vilos
            ['.vilos-controls',                       'append'],  // Crunchyroll
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

    let activeVideo      = null;
    let cycleIndex       = 0;
    let tooltipEl        = null;
    let tooltipTimer     = null;
    let currentSpeed     = 1.0;
    let floatBtn         = null;
    let toolbarBtn       = null;
    let panel            = null;
    let panelOpen        = false;
    let pollTimer        = null;

    // ─────────────────────────────────────────────
    //  Tooltip
    // ─────────────────────────────────────────────

    function getTooltipRoot() {
        const fs = document.fullscreenElement;
        return (fs && fs.contains(activeVideo)) ? fs : document.body;
    }

    function showTooltip(msg) {
        const root = getTooltipRoot();
        if (tooltipEl && tooltipEl.parentNode !== root) { tooltipEl.remove(); tooltipEl = null; }
        if (!tooltipEl) {
            tooltipEl = document.createElement('div');
            tooltipEl.style.cssText = `
                position:fixed;top:20px;left:50%;transform:translateX(-50%);
                background:rgba(0,0,0,0.75);color:#fff;padding:8px 16px;
                border-radius:4px;font-family:Arial,sans-serif;font-size:16px;
                z-index:2147483647;pointer-events:none;
                transition:opacity 0.3s ease;box-shadow:0 2px 8px rgba(0,0,0,0.4);
            `;
            root.appendChild(tooltipEl);
        }
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
        if (v && v !== activeVideo) { activeVideo = v; currentSpeed = v.playbackRate; }
    }

    // ─────────────────────────────────────────────
    //  Find player wrapper
    //  Walk up from video until we find a container
    //  that is roughly as large as the video itself.
    // ─────────────────────────────────────────────

    function findPlayerWrapper(video) {
        const vr = video.getBoundingClientRect();
        const vArea = vr.width * vr.height;
        if (vArea === 0) return video.parentElement;

        let el = video.parentElement;
        for (let i = 0; i < 8 && el && el !== document.body; i++) {
            const r = el.getBoundingClientRect();
            const area = r.width * r.height;
            // Accept the first ancestor whose area is close to the video's
            if (area > 0 && area <= vArea * 1.5) return el;
            el = el.parentElement;
        }
        return video.parentElement;
    }

    // ─────────────────────────────────────────────
    //  Find control bar — search INSIDE player wrapper
    // ─────────────────────────────────────────────

    function findToolbar(wrapper) {
        // 1. Try known selectors globally
        for (const [sel] of CONFIG.TOOLBAR_SELECTORS) {
            const el = document.querySelector(sel);
            if (el) return { el, pos: CONFIG.TOOLBAR_SELECTORS.find(s => s[0] === sel)[1] };
        }

        // 2. Heuristic: find a short wide bar near the bottom of the wrapper
        const wr = wrapper.getBoundingClientRect();
        const candidates = Array.from(wrapper.querySelectorAll('*')).filter(el => {
            if (el.id === 'vsc-toolbar-btn' || el.closest('#vsc-toolbar-btn')) return false;
            const r = el.getBoundingClientRect();
            if (r.width < wr.width * 0.4) return false;   // must be wide
            if (r.height < 24 || r.height > 80) return false; // must be bar-shaped
            if (r.bottom < wr.bottom - r.height * 3) return false; // must be near bottom
            const style = getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            return true;
        });

        if (candidates.length) {
            // Pick the one closest to the bottom
            const best = candidates.reduce((a, b) =>
                b.getBoundingClientRect().bottom > a.getBoundingClientRect().bottom ? b : a
            );
            return { el: best, pos: 'append' };
        }

        return null;
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
            position:absolute;bottom:calc(100% + 8px);left:0;
            background:rgba(20,20,20,0.93);border:1px solid rgba(255,255,255,0.15);
            border-radius:8px;padding:10px 12px;z-index:2147483646;
            font-family:Arial,sans-serif;font-size:13px;color:#fff;
            min-width:190px;box-shadow:0 4px 16px rgba(0,0,0,0.6);
            backdrop-filter:blur(8px);user-select:none;
        `;

        const btn = (txt, tip, fn) => {
            const b = document.createElement('button');
            b.textContent = txt; b.title = tip;
            b.style.cssText = `background:rgba(255,255,255,0.12);border:none;color:#fff;
                border-radius:4px;padding:3px 9px;cursor:pointer;font-size:13px;flex-shrink:0;`;
            b.onmouseenter = () => b.style.background = 'rgba(255,255,255,0.25)';
            b.onmouseleave = () => b.style.background = 'rgba(255,255,255,0.12)';
            b.onclick = e => { e.stopPropagation(); fn(); };
            return b;
        };

        // Row
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:8px;';
        const disp = document.createElement('span');
        disp.className = 'vsc-disp';
        disp.style.cssText = 'flex:1;text-align:center;font-weight:bold;font-size:15px;';
        disp.textContent = `${currentSpeed.toFixed(1)}x`;
        row.append(
            btn('−', 'Slow down (s)', () => setSpeed(currentSpeed - CONFIG.SPEED_STEP)),
            disp,
            btn('+', 'Speed up (d)',  () => setSpeed(currentSpeed + CONFIG.SPEED_STEP))
        );
        panel.appendChild(row);

        // Slider
        const sl = document.createElement('input');
        sl.type = 'range'; sl.min = CONFIG.MIN_SPEED; sl.max = 4;
        sl.step = CONFIG.SPEED_STEP; sl.value = currentSpeed;
        sl.className = 'vsc-slider';
        sl.style.cssText = 'width:100%;accent-color:#fff;margin-bottom:8px;cursor:pointer;display:block;';
        sl.oninput = e => { e.stopPropagation(); setSpeed(+sl.value); };
        sl.onclick = e => e.stopPropagation();
        panel.appendChild(sl);

        // Presets
        const presets = document.createElement('div');
        presets.style.cssText = 'display:flex;gap:5px;';
        CONFIG.CYCLE_SPEEDS.forEach(spd => {
            const pb = btn(`${spd}x`, `Set ${spd}x`, () => {
                setSpeed(spd); cycleIndex = CONFIG.CYCLE_SPEEDS.indexOf(spd);
            });
            pb.className = `vsc-preset vsc-p${spd}`;
            pb.style.flex = '1';
            presets.appendChild(pb);
        });
        const rb = btn('↺', 'Reset (r)', () => { setSpeed(1.0); cycleIndex = 0; });
        rb.style.flex = '1';
        presets.appendChild(rb);
        panel.appendChild(presets);

        anchor.style.position = 'relative';
        anchor.appendChild(panel);
        panelOpen = true;
        setTimeout(() => document.addEventListener('click', closePanel, { once: true, capture: true }), 0);
    }

    function closePanel() {
        panel?.remove(); panel = null; panelOpen = false;
    }

    function togglePanel(anchor) {
        panelOpen ? closePanel() : buildPanel(anchor);
    }

    // ─────────────────────────────────────────────
    //  Update UI state
    // ─────────────────────────────────────────────

    function updateUI() {
        const lbl = `${currentSpeed.toFixed(1)}x`;

        [floatBtn, toolbarBtn].forEach(b => {
            if (!b) return;
            const l = b.querySelector('.vsc-lbl');
            if (l) l.textContent = lbl;
        });

        // Float visibility logic
        if (floatBtn) {
            const tbVisible = toolbarBtn?.isConnected && toolbarBtn.offsetParent !== null;
            floatBtn.style.opacity  = tbVisible ? '0' : (currentSpeed !== 1.0 ? '1' : '0.4');
            floatBtn.style.pointerEvents = tbVisible ? 'none' : 'auto';
        }

        // Panel sync
        if (panel) {
            const d = panel.querySelector('.vsc-disp');
            if (d) d.textContent = lbl;
            const s = panel.querySelector('.vsc-slider');
            if (s) s.value = currentSpeed;
            panel.querySelectorAll('.vsc-preset').forEach(pb => {
                const spd = parseFloat(pb.textContent);
                pb.style.background = spd === currentSpeed
                    ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.12)';
            });
        }
    }

    // ─────────────────────────────────────────────
    //  Build floating button
    // ─────────────────────────────────────────────

    function buildFloatBtn(wrapper) {
        if (floatBtn?.isConnected) return;
        floatBtn?.remove();

        floatBtn = document.createElement('div');
        floatBtn.id = 'vsc-float';
        floatBtn.style.cssText = `
            position:absolute;bottom:10px;left:10px;
            z-index:2147483645;cursor:pointer;
            font-family:Arial,sans-serif;font-size:12px;font-weight:bold;
            color:rgba(255,255,255,0.95);background:rgba(0,0,0,0.55);
            border-radius:4px;padding:3px 8px;
            backdrop-filter:blur(4px);border:1px solid rgba(255,255,255,0.2);
            transition:opacity 0.2s,background 0.15s;user-select:none;
            opacity:0.4;
        `;
        const lbl = document.createElement('span');
        lbl.className = 'vsc-lbl';
        lbl.textContent = `${currentSpeed.toFixed(1)}x`;
        floatBtn.appendChild(lbl);

        floatBtn.onmouseenter = () => floatBtn.style.background = 'rgba(0,0,0,0.8)';
        floatBtn.onmouseleave = () => floatBtn.style.background = 'rgba(0,0,0,0.55)';
        floatBtn.onclick = e => { e.stopPropagation(); togglePanel(floatBtn); };

        if (getComputedStyle(wrapper).position === 'static') wrapper.style.position = 'relative';
        wrapper.appendChild(floatBtn);

        document.addEventListener('fullscreenchange', () => {
            const fs = document.fullscreenElement;
            if (fs && floatBtn && !fs.contains(floatBtn)) {
                if (getComputedStyle(fs).position === 'static') fs.style.position = 'relative';
                fs.appendChild(floatBtn);
            }
        });
    }

    // ─────────────────────────────────────────────
    //  Build toolbar button
    // ─────────────────────────────────────────────

    function buildToolbarBtn(el, pos) {
        if (toolbarBtn?.isConnected) return;
        toolbarBtn?.remove();

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
    }

    // ─────────────────────────────────────────────
    //  Setup — called whenever a new video is found
    // ─────────────────────────────────────────────

    function setup() {
        if (!activeVideo) return;

        const wrapper = findPlayerWrapper(activeVideo);
        buildFloatBtn(wrapper);

        // Poll for toolbar
        clearInterval(pollTimer);
        let tries = 0;
        pollTimer = setInterval(() => {
            if (!toolbarBtn?.isConnected) {
                const tb = findToolbar(wrapper);
                if (tb) buildToolbarBtn(tb.el, tb.pos);
            }
            updateUI();
            if (++tries > 60) clearInterval(pollTimer); // 30s timeout
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

        if      (key === K.SPEED_UP)       setSpeed(currentSpeed + CONFIG.SPEED_STEP);
        else if (key === K.SPEED_DOWN)     setSpeed(currentSpeed - CONFIG.SPEED_STEP);
        else if (key === K.RESET)          { setSpeed(1.0); cycleIndex = 0; }
        else if (K.CYCLE.includes(key))    { cycleIndex = (cycleIndex+1) % CONFIG.CYCLE_SPEEDS.length; setSpeed(CONFIG.CYCLE_SPEEDS[cycleIndex]); }
        else if (key === K.FRAME_PREV)     { stepFrame(activeVideo,-1); showTooltip('◄ Previous Frame'); }
        else if (key === K.FRAME_NEXT)     { stepFrame(activeVideo, 1); showTooltip('Next Frame ►'); }
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
            currentSpeed = activeVideo.playbackRate;
            if (wasNew || !floatBtn?.isConnected) setup();
        }, true);

        new MutationObserver(mutations => {
            for (const m of mutations)
                for (const node of m.addedNodes)
                    if (node instanceof Element &&
                        (node.tagName === 'VIDEO' || node.querySelectorAll?.('video').length)) {
                        updateActiveVideo();
                        if (!floatBtn?.isConnected) setup();
                    }
        }).observe(document.body || document.documentElement, { childList: true, subtree: true });

        if (activeVideo) setup();
    }

    document.body ? init() : document.addEventListener('DOMContentLoaded', init);

})();
