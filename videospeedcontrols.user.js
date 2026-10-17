// ==UserScript==
// @name         HTML5 Video Speed Controls
// @namespace    https://github.com/mariayuno/html5-video-speed-control
// @version      1.7
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

        // Ordered list of toolbar selectors to try (most-specific first)
        TOOLBAR_SELECTORS: [
            // YouTube
            '.ytp-right-controls',
            // Vimeo
            '.vp-controls-wrapper .vp-controls',
            // Twitch
            '.player-controls__right-control-group',
            // Dailymotion
            '.dm-player-controlbar',
            // Plyr
            '.plyr__controls',
            // Video.js
            '.vjs-control-bar',
            // JW Player
            '.jw-controlbar-right-group',
            // Generic HTML5 controls (shadow DOM — handled separately)
        ],
    };

    // ─────────────────────────────────────────────
    //  State
    // ─────────────────────────────────────────────

    let activeVideo   = null;
    let cycleIndex    = 0;
    let tooltipEl     = null;
    let tooltipTimer  = null;

    // UI
    let floatBtn      = null;   // always-there floating button
    let panel         = null;   // popup control panel
    let toolbarBtn    = null;   // button injected into player toolbar
    let panelOpen     = false;
    let currentSpeed  = 1.0;

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
    //  Speed helpers
    // ─────────────────────────────────────────────

    function setSpeed(rate) {
        if (!activeVideo) return;
        currentSpeed = Math.min(CONFIG.MAX_SPEED, Math.max(CONFIG.MIN_SPEED, +rate.toFixed(1)));
        activeVideo.playbackRate = currentSpeed;
        updateUI();
        showTooltip(`Speed: ${currentSpeed.toFixed(1)}x`);
    }

    // ─────────────────────────────────────────────
    //  Toolbar detection
    // ─────────────────────────────────────────────

    function findToolbar() {
        for (const sel of CONFIG.TOOLBAR_SELECTORS) {
            const el = document.querySelector(sel);
            if (el) return el;
        }
        return null;
    }

    // ─────────────────────────────────────────────
    //  Control panel (popup)
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

        // Speed row
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:8px;';

        const mkBtn = (label, title, onClick) => {
            const b = document.createElement('button');
            b.textContent = label;
            b.title = title;
            b.style.cssText = `
                background:rgba(255,255,255,0.12);border:none;color:#fff;
                border-radius:4px;padding:3px 8px;cursor:pointer;font-size:13px;
                flex-shrink:0;
            `;
            b.addEventListener('mouseenter', () => b.style.background = 'rgba(255,255,255,0.25)');
            b.addEventListener('mouseleave', () => b.style.background = 'rgba(255,255,255,0.12)');
            b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
            return b;
        };

        const speedDisplay = document.createElement('span');
        speedDisplay.id = 'vsc-speed-display';
        speedDisplay.style.cssText = 'flex:1;text-align:center;font-weight:bold;font-size:14px;';
        speedDisplay.textContent = `${currentSpeed.toFixed(1)}x`;

        row.appendChild(mkBtn('−', 'Slow down (s)', () => setSpeed(currentSpeed - CONFIG.SPEED_STEP)));
        row.appendChild(speedDisplay);
        row.appendChild(mkBtn('+', 'Speed up (d)', () => setSpeed(currentSpeed + CONFIG.SPEED_STEP)));
        panel.appendChild(row);

        // Slider
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min  = CONFIG.MIN_SPEED;
        slider.max  = 4;
        slider.step = CONFIG.SPEED_STEP;
        slider.value = currentSpeed;
        slider.id = 'vsc-slider';
        slider.style.cssText = 'width:100%;accent-color:#fff;margin-bottom:8px;cursor:pointer;';
        slider.addEventListener('input', (e) => { e.stopPropagation(); setSpeed(+slider.value); });
        slider.addEventListener('click', (e) => e.stopPropagation());
        panel.appendChild(slider);

        // Preset buttons
        const presets = document.createElement('div');
        presets.style.cssText = 'display:flex;gap:5px;justify-content:space-between;';
        for (const spd of CONFIG.CYCLE_SPEEDS) {
            const pb = mkBtn(`${spd}x`, `Set ${spd}x`, () => {
                setSpeed(spd);
                cycleIndex = CONFIG.CYCLE_SPEEDS.indexOf(spd);
            });
            pb.id = `vsc-preset-${spd}`;
            pb.style.flex = '1';
            presets.appendChild(pb);
        }
        // Reset
        const rb = mkBtn('↺ Reset', 'Reset to 1x (r)', () => {
            setSpeed(1.0);
            cycleIndex = 0;
        });
        rb.style.flex = '1';
        presets.appendChild(rb);
        panel.appendChild(presets);

        anchorEl.style.position = 'relative';
        anchorEl.appendChild(panel);
        panelOpen = true;

        // Close on outside click
        setTimeout(() => {
            document.addEventListener('click', closePanel, { once: true, capture: true });
        }, 0);
    }

    function closePanel() {
        if (panel) { panel.remove(); panel = null; }
        panelOpen = false;
    }

    function togglePanel(anchorEl) {
        if (panelOpen) { closePanel(); } else { buildPanel(anchorEl); }
    }

    // ─────────────────────────────────────────────
    //  Button factory (shared style)
    // ─────────────────────────────────────────────

    function createSpeedBtn() {
        const btn = document.createElement('div');
        btn.id = 'vsc-btn';
        btn.style.cssText = `
            display:inline-flex;align-items:center;justify-content:center;
            cursor:pointer;
            font-family:Arial,sans-serif;font-size:12px;font-weight:bold;
            color:rgba(255,255,255,0.85);
            background:rgba(0,0,0,0.0);
            border-radius:4px;
            padding:0 6px;
            height:100%;
            min-width:36px;
            position:relative;
            transition:background 0.15s;
            box-sizing:border-box;
            z-index:2147483645;
        `;
        btn.title = 'Video Speed Controls';
        btn.addEventListener('mouseenter', () => btn.style.background = 'rgba(255,255,255,0.15)');
        btn.addEventListener('mouseleave', () => btn.style.background = 'rgba(0,0,0,0.0)');
        return btn;
    }

    // ─────────────────────────────────────────────
    //  Floating button (fallback / always-on-top when toolbar hidden)
    // ─────────────────────────────────────────────

    function buildFloatBtn() {
        if (floatBtn) floatBtn.remove();

        floatBtn = document.createElement('div');
        floatBtn.id = 'vsc-float';
        floatBtn.style.cssText = `
            position:absolute;
            bottom:48px;
            left:10px;
            z-index:2147483645;
            cursor:pointer;
            font-family:Arial,sans-serif;font-size:12px;font-weight:bold;
            color:rgba(255,255,255,0.85);
            background:rgba(0,0,0,0.45);
            border-radius:4px;
            padding:3px 7px;
            backdrop-filter:blur(4px);
            border:1px solid rgba(255,255,255,0.15);
            transition:opacity 0.2s, background 0.15s;
            user-select:none;
        `;
        floatBtn.title = 'Video Speed Controls';
        floatBtn.addEventListener('mouseenter', () => floatBtn.style.background = 'rgba(0,0,0,0.7)');
        floatBtn.addEventListener('mouseleave', () => floatBtn.style.background = 'rgba(0,0,0,0.45)');
        floatBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePanel(floatBtn); });

        let parent = activeVideo.parentElement;
        const ps = getComputedStyle(parent).position;
        if (ps === 'static') parent.style.position = 'relative';
        parent.appendChild(floatBtn);

        updateUI();
    }

    // ─────────────────────────────────────────────
    //  Toolbar button
    // ─────────────────────────────────────────────

    function buildToolbarBtn(toolbar) {
        if (toolbarBtn) toolbarBtn.remove();

        const wrap = document.createElement('div');
        wrap.style.cssText = 'position:relative;display:inline-flex;align-items:center;height:100%;';

        const btn = createSpeedBtn();
        btn.addEventListener('click', (e) => { e.stopPropagation(); togglePanel(wrap); });
        wrap.appendChild(btn);
        toolbar.appendChild(wrap);
        toolbarBtn = wrap;

        updateUI();
    }

    // ─────────────────────────────────────────────
    //  Update UI labels
    // ─────────────────────────────────────────────

    function updateUI() {
        const label = currentSpeed === 1.0 ? '⏩' : `${currentSpeed.toFixed(1)}x`;

        if (toolbarBtn) {
            const b = toolbarBtn.querySelector('#vsc-btn');
            if (b) b.textContent = label;
        }

        if (floatBtn) {
            floatBtn.textContent = label;
            // Hide float button if toolbar button is visible
            const tb = toolbarBtn;
            if (tb && tb.offsetParent !== null) {
                floatBtn.style.opacity = '0';
                floatBtn.style.pointerEvents = 'none';
            } else {
                // Show float: always if speed≠1, otherwise subtle
                floatBtn.style.opacity = currentSpeed !== 1.0 ? '1' : '0.35';
                floatBtn.style.pointerEvents = 'auto';
            }
        }

        // Sync panel if open
        const disp = document.getElementById('vsc-speed-display');
        if (disp) disp.textContent = `${currentSpeed.toFixed(1)}x`;
        const sl = document.getElementById('vsc-slider');
        if (sl) sl.value = currentSpeed;

        // Highlight active preset
        for (const spd of CONFIG.CYCLE_SPEEDS) {
            const pb = document.getElementById(`vsc-preset-${spd}`);
            if (pb) pb.style.background = spd === currentSpeed
                ? 'rgba(255,255,255,0.35)'
                : 'rgba(255,255,255,0.12)';
        }
    }

    // ─────────────────────────────────────────────
    //  Setup UI
    // ─────────────────────────────────────────────

    function setupUI() {
        if (!activeVideo) return;

        const toolbar = findToolbar();
        if (toolbar) {
            buildToolbarBtn(toolbar);
        }
        // Always build float too — it hides itself when toolbar btn is visible
        buildFloatBtn();

        // Watch for toolbar visibility changes (player idle hides controls)
        if (toolbar) {
            new MutationObserver(updateUI).observe(toolbar, { attributes: true, attributeFilter: ['style', 'class'] });

            // Also watch parent containers
            let el = toolbar.parentElement;
            for (let i = 0; i < 4 && el; i++, el = el.parentElement) {
                new MutationObserver(updateUI).observe(el, { attributes: true, attributeFilter: ['style', 'class'] });
            }
        }

        // Update float position on fullscreen toggle
        document.addEventListener('fullscreenchange', () => {
            const fs = document.fullscreenElement;
            if (fs && floatBtn && !fs.contains(floatBtn)) {
                fs.appendChild(floatBtn);
            }
        });
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

        if (key === K.SPEED_UP) {
            setSpeed(currentSpeed + CONFIG.SPEED_STEP);
        } else if (key === K.SPEED_DOWN) {
            setSpeed(currentSpeed - CONFIG.SPEED_STEP);
        } else if (key === K.RESET) {
            setSpeed(1.0); cycleIndex = 0;
        } else if (K.CYCLE.includes(key)) {
            cycleIndex = (cycleIndex + 1) % CONFIG.CYCLE_SPEEDS.length;
            setSpeed(CONFIG.CYCLE_SPEEDS[cycleIndex]);
        } else if (key === K.FRAME_PREV) {
            stepFrame(activeVideo, -1); showTooltip('◄ Previous Frame');
        } else if (key === K.FRAME_NEXT) {
            stepFrame(activeVideo, 1);  showTooltip('Next Frame ►');
        } else {
            handled = false;
        }

        if (handled) { e.preventDefault(); e.stopPropagation(); }
    }

    // ─────────────────────────────────────────────
    //  Init
    // ─────────────────────────────────────────────

    function init() {
        updateActiveVideo();

        document.addEventListener('keydown', handleKeyPress, true);

        document.addEventListener('play', (e) => {
            if (!(e.target instanceof HTMLVideoElement)) return;
            activeVideo = e.target;
            currentSpeed = activeVideo.playbackRate;
            if (!floatBtn || !floatBtn.isConnected) setupUI();
        }, true);

        new MutationObserver((mutations) => {
            for (const m of mutations)
                for (const node of m.addedNodes)
                    if (node instanceof Element &&
                        (node.tagName === 'VIDEO' || node.querySelectorAll?.('video').length > 0)) {
                        updateActiveVideo();
                        if (!floatBtn || !floatBtn.isConnected) setupUI();
                    }
        }).observe(document.body || document.documentElement, { childList: true, subtree: true });

        if (activeVideo) setupUI();
    }

    document.body ? init() : document.addEventListener('DOMContentLoaded', init);

})();
