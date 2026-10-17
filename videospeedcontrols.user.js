// ==UserScript==
// @name         HTML5 Video Speed Controls
// @namespace    https://github.com/mariayuno/html5-video-speed-control
// @version      1.9
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
        // Toolbar selectors: [selector, insertPosition]
        // insertPosition: 'left' appends to left controls, 'right' prepends to right controls
        TOOLBAR_SELECTORS: [
            ['.ytp-left-controls',                    'append'],   // YouTube left
            ['.vp-controls-wrapper .vp-controls',     'append'],   // Vimeo
            ['.player-controls__right-control-group', 'prepend'],  // Twitch
            ['.vjs-control-bar',                      'append'],   // Video.js
            ['.plyr__controls',                       'append'],   // Plyr
            ['.jw-controlbar-right-group',            'prepend'],  // JW Player
            ['.dm-player-controlbar',                 'append'],   // Dailymotion
            ['[class*="controlBar"]',                 'append'],   // generic
            ['[class*="control-bar"]',                'append'],   // generic kebab
            ['[class*="player-controls"]',            'append'],   // generic
        ],
    };

    // ─────────────────────────────────────────────
    //  State
    // ─────────────────────────────────────────────

    let activeVideo   = null;
    let cycleIndex    = 0;
    let tooltipEl     = null;
    let tooltipTimer  = null;
    let currentSpeed  = 1.0;

    let floatBtn      = null;
    let toolbarBtn    = null;
    let panel         = null;
    let panelOpen     = false;

    let toolbarPollTimer = null;

    // ─────────────────────────────────────────────
    //  Tooltip
    // ─────────────────────────────────────────────

    function getTooltipRoot() {
        const fs = document.fullscreenElement;
        return (fs && fs.contains(activeVideo)) ? fs : document.body;
    }

    function showTooltip(message) {
        const root = getTooltipRoot();
        if (tooltipEl && tooltipEl.parentNode !== root) { tooltipEl.remove(); tooltipEl = null; }
        if (!tooltipEl) {
            tooltipEl = document.createElement('div');
            tooltipEl.style.cssText = `
                position:fixed;top:20px;left:50%;transform:translateX(-50%);
                background:rgba(0,0,0,0.7);color:#fff;padding:8px 16px;
                border-radius:4px;font-family:Arial,sans-serif;font-size:16px;
                z-index:2147483647;pointer-events:none;
                transition:opacity 0.3s ease;box-shadow:0 2px 8px rgba(0,0,0,0.3);
            `;
            root.appendChild(tooltipEl);
        }
        tooltipEl.textContent = message;
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
        const videos = Array.from(document.querySelectorAll('video'));
        if (!videos.length) return null;
        if (videos.length === 1) return videos[0];
        const playing = videos.find(v => !v.paused);
        if (playing) return playing;
        return videos.reduce((best, cur) => {
            const a = cur.getBoundingClientRect(), b = best.getBoundingClientRect();
            return a.width * a.height > b.width * b.height ? cur : best;
        });
    }

    function updateActiveVideo() {
        const v = findBestVideo();
        if (v) activeVideo = v;
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

    function stepFrame(video, direction) {
        if (!video || !video.duration) return;
        video.pause();
        const fd = 1 / estimateFPS(video);
        video.currentTime = direction < 0
            ? Math.max(0, video.currentTime - fd)
            : Math.min(video.duration, video.currentTime + fd);
    }

    // ─────────────────────────────────────────────
    //  Speed
    // ─────────────────────────────────────────────

    function setSpeed(rate) {
        if (!activeVideo) return;
        currentSpeed = Math.min(CONFIG.MAX_SPEED, Math.max(CONFIG.MIN_SPEED, +rate.toFixed(1)));
        activeVideo.playbackRate = currentSpeed;
        updateUI();
        showTooltip(`Speed: ${currentSpeed.toFixed(1)}x`);
    }

    // ─────────────────────────────────────────────
    //  Control panel
    // ─────────────────────────────────────────────

    function buildPanel(anchorEl) {
        if (panel) panel.remove();

        panel = document.createElement('div');
        panel.style.cssText = `
            position:absolute;
            bottom:calc(100% + 8px);
            left:0;
            background:rgba(20,20,20,0.92);
            border:1px solid rgba(255,255,255,0.15);
            border-radius:8px;
            padding:10px 12px;
            z-index:2147483646;
            font-family:Arial,sans-serif;
            font-size:13px;
            color:#fff;
            min-width:180px;
            box-shadow:0 4px 16px rgba(0,0,0,0.5);
            backdrop-filter:blur(6px);
            user-select:none;
        `;

        const mkBtn = (label, title, onClick) => {
            const b = document.createElement('button');
            b.textContent = label;
            b.title = title;
            b.style.cssText = `
                background:rgba(255,255,255,0.12);border:none;color:#fff;
                border-radius:4px;padding:3px 8px;cursor:pointer;font-size:13px;flex-shrink:0;
            `;
            b.onmouseenter = () => b.style.background = 'rgba(255,255,255,0.25)';
            b.onmouseleave = () => b.style.background = 'rgba(255,255,255,0.12)';
            b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
            return b;
        };

        // Speed row
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:8px;';
        const speedDisplay = document.createElement('span');
        speedDisplay.className = 'vsc-speed-display';
        speedDisplay.style.cssText = 'flex:1;text-align:center;font-weight:bold;font-size:14px;';
        speedDisplay.textContent = `${currentSpeed.toFixed(1)}x`;
        row.append(
            mkBtn('−', 'Slow down', () => setSpeed(currentSpeed - CONFIG.SPEED_STEP)),
            speedDisplay,
            mkBtn('+', 'Speed up',  () => setSpeed(currentSpeed + CONFIG.SPEED_STEP))
        );
        panel.appendChild(row);

        // Slider
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = CONFIG.MIN_SPEED; slider.max = 4; slider.step = CONFIG.SPEED_STEP;
        slider.value = currentSpeed;
        slider.className = 'vsc-slider';
        slider.style.cssText = 'width:100%;accent-color:#fff;margin-bottom:8px;cursor:pointer;';
        slider.addEventListener('input', (e) => { e.stopPropagation(); setSpeed(+slider.value); });
        slider.addEventListener('click', (e) => e.stopPropagation());
        panel.appendChild(slider);

        // Presets + reset
        const presets = document.createElement('div');
        presets.style.cssText = 'display:flex;gap:5px;';
        for (const spd of CONFIG.CYCLE_SPEEDS) {
            const pb = mkBtn(`${spd}x`, `Set ${spd}x`, () => {
                setSpeed(spd); cycleIndex = CONFIG.CYCLE_SPEEDS.indexOf(spd);
            });
            pb.className = `vsc-preset vsc-preset-${spd}`;
            pb.style.flex = '1';
            presets.appendChild(pb);
        }
        const rb = mkBtn('↺', 'Reset to 1x (r)', () => { setSpeed(1.0); cycleIndex = 0; });
        rb.style.flex = '1';
        presets.appendChild(rb);
        panel.appendChild(presets);

        anchorEl.style.position = 'relative';
        anchorEl.appendChild(panel);
        panelOpen = true;

        setTimeout(() => {
            document.addEventListener('click', closePanel, { once: true, capture: true });
        }, 0);
    }

    function closePanel() {
        if (panel) { panel.remove(); panel = null; }
        panelOpen = false;
    }

    function togglePanel(anchorEl) {
        panelOpen ? closePanel() : buildPanel(anchorEl);
    }

    // ─────────────────────────────────────────────
    //  Update UI
    // ─────────────────────────────────────────────

    function updateUI() {
        const label = `${currentSpeed.toFixed(1)}x`;

        // Toolbar button label
        if (toolbarBtn) {
            const lbl = toolbarBtn.querySelector('.vsc-label');
            if (lbl) lbl.textContent = label;
            // Show/hide based on toolbar btn visibility
            const tbVisible = toolbarBtn.offsetParent !== null;
            if (floatBtn) {
                if (tbVisible) {
                    floatBtn.style.opacity = '0';
                    floatBtn.style.pointerEvents = 'none';
                } else {
                    floatBtn.style.opacity = currentSpeed !== 1.0 ? '1' : '0.4';
                    floatBtn.style.pointerEvents = 'auto';
                }
            }
        } else if (floatBtn) {
            // No toolbar btn — float always shown, dimmed at 1x
            floatBtn.style.opacity = currentSpeed !== 1.0 ? '1' : '0.4';
            floatBtn.style.pointerEvents = 'auto';
        }

        // Float label
        if (floatBtn) {
            const lbl = floatBtn.querySelector('.vsc-label');
            if (lbl) lbl.textContent = label;
        }

        // Panel sync
        if (panel) {
            const d = panel.querySelector('.vsc-speed-display');
            if (d) d.textContent = label;
            const sl = panel.querySelector('.vsc-slider');
            if (sl) sl.value = currentSpeed;
            panel.querySelectorAll('.vsc-preset').forEach(pb => {
                const spd = parseFloat(pb.textContent);
                pb.style.background = spd === currentSpeed
                    ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.12)';
            });
        }
    }

    // ─────────────────────────────────────────────
    //  Floating button — always built, lives on video parent
    // ─────────────────────────────────────────────

    function buildFloatBtn() {
        if (floatBtn && floatBtn.isConnected) return;
        if (floatBtn) floatBtn.remove();
        if (!activeVideo) return;

        floatBtn = document.createElement('div');
        floatBtn.style.cssText = `
            position:absolute;
            bottom:12px;
            left:10px;
            z-index:2147483645;
            cursor:pointer;
            font-family:Arial,sans-serif;font-size:12px;font-weight:bold;
            color:rgba(255,255,255,0.9);
            background:rgba(0,0,0,0.5);
            border-radius:4px;
            padding:3px 7px;
            backdrop-filter:blur(4px);
            border:1px solid rgba(255,255,255,0.2);
            transition:opacity 0.2s,background 0.15s;
            user-select:none;
            opacity:0.4;
        `;
        const lbl = document.createElement('span');
        lbl.className = 'vsc-label';
        lbl.textContent = `${currentSpeed.toFixed(1)}x`;
        floatBtn.appendChild(lbl);

        floatBtn.onmouseenter = () => floatBtn.style.background = 'rgba(0,0,0,0.75)';
        floatBtn.onmouseleave = () => floatBtn.style.background = 'rgba(0,0,0,0.5)';
        floatBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePanel(floatBtn); });

        const parent = activeVideo.parentElement;
        if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
        parent.appendChild(floatBtn);

        // Re-parent into fullscreen element when needed
        document.addEventListener('fullscreenchange', () => {
            const fs = document.fullscreenElement;
            if (fs && floatBtn && !fs.contains(floatBtn)) fs.appendChild(floatBtn);
        });

        updateUI();
    }

    // ─────────────────────────────────────────────
    //  Toolbar button — injected if toolbar found
    // ─────────────────────────────────────────────

    function buildToolbarBtn(toolbar, position) {
        if (toolbarBtn && toolbarBtn.isConnected) return;
        if (toolbarBtn) toolbarBtn.remove();

        const wrap = document.createElement('div');
        wrap.style.cssText = `
            position:relative;display:inline-flex;align-items:center;
            height:100%;cursor:pointer;padding:0 6px;
            font-family:Arial,sans-serif;font-size:12px;font-weight:bold;
            color:rgba(255,255,255,0.9);border-radius:4px;
            transition:background 0.15s;
        `;
        wrap.onmouseenter = () => wrap.style.background = 'rgba(255,255,255,0.15)';
        wrap.onmouseleave = () => wrap.style.background = 'transparent';
        wrap.title = 'Video Speed Controls';

        const lbl = document.createElement('span');
        lbl.className = 'vsc-label';
        lbl.textContent = `${currentSpeed.toFixed(1)}x`;
        wrap.appendChild(lbl);
        wrap.addEventListener('click', (e) => { e.stopPropagation(); togglePanel(wrap); });

        position === 'prepend' ? toolbar.prepend(wrap) : toolbar.appendChild(wrap);
        toolbarBtn = wrap;

        updateUI();
    }

    // ─────────────────────────────────────────────
    //  Toolbar polling — retries until found or gives up
    // ─────────────────────────────────────────────

    function tryInjectToolbar() {
        if (toolbarBtn && toolbarBtn.isConnected) return;

        for (const [sel, pos] of CONFIG.TOOLBAR_SELECTORS) {
            const el = document.querySelector(sel);
            if (el && el !== toolbarBtn?.parentElement) {
                buildToolbarBtn(el, pos);
                return;
            }
        }
    }

    function startToolbarPolling() {
        clearInterval(toolbarPollTimer);
        let attempts = 0;
        toolbarPollTimer = setInterval(() => {
            tryInjectToolbar();
            attempts++;
            // Give up after 30s but keep float
            if (attempts > 60 || (toolbarBtn && toolbarBtn.isConnected)) {
                clearInterval(toolbarPollTimer);
            }
        }, 500);
    }

    // ─────────────────────────────────────────────
    //  Key handler
    // ─────────────────────────────────────────────

    function handleKeyPress(e) {
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        if (e.ctrlKey || e.altKey || e.metaKey) return;

        if (!activeVideo || !activeVideo.isConnected) updateActiveVideo();
        if (!activeVideo) return;

        const key = e.key === '\\' ? '\\' : e.key.toLowerCase();
        const K = CONFIG.KEYS;
        let handled = true;

        if      (key === K.SPEED_UP)          setSpeed(currentSpeed + CONFIG.SPEED_STEP);
        else if (key === K.SPEED_DOWN)        setSpeed(currentSpeed - CONFIG.SPEED_STEP);
        else if (key === K.RESET)             { setSpeed(1.0); cycleIndex = 0; }
        else if (K.CYCLE.includes(key))       { cycleIndex = (cycleIndex + 1) % CONFIG.CYCLE_SPEEDS.length; setSpeed(CONFIG.CYCLE_SPEEDS[cycleIndex]); }
        else if (key === K.FRAME_PREV)        { stepFrame(activeVideo, -1); showTooltip('◄ Previous Frame'); }
        else if (key === K.FRAME_NEXT)        { stepFrame(activeVideo,  1); showTooltip('Next Frame ►'); }
        else handled = false;

        if (handled) { e.preventDefault(); e.stopPropagation(); }
    }

    // ─────────────────────────────────────────────
    //  Init
    // ─────────────────────────────────────────────

    function setup() {
        if (!activeVideo) return;
        buildFloatBtn();
        tryInjectToolbar();
        startToolbarPolling();
    }

    function init() {
        updateActiveVideo();
        document.addEventListener('keydown', handleKeyPress, true);

        document.addEventListener('play', (e) => {
            if (!(e.target instanceof HTMLVideoElement)) return;
            activeVideo = e.target;
            currentSpeed = activeVideo.playbackRate;
            setup();
        }, true);

        new MutationObserver((mutations) => {
            for (const m of mutations)
                for (const node of m.addedNodes)
                    if (node instanceof Element &&
                        (node.tagName === 'VIDEO' || node.querySelectorAll?.('video').length > 0)) {
                        updateActiveVideo();
                        setup();
                    }
        }).observe(document.body || document.documentElement, { childList: true, subtree: true });

        if (activeVideo) setup();
    }

    document.body ? init() : document.addEventListener('DOMContentLoaded', init);

})();
