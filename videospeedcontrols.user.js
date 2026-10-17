// ==UserScript==
// @name         HTML5 Video Speed Controls
// @namespace    https://github.com/mariayuno/html5-video-speed-control
// @version      1.3
// @description  Simple keyboard controls for HTML5 video speed and frame-stepping
// @author       lunagus, mariayuno
// @match        *://*/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // ─────────────────────────────────────────────
    //  CONFIGURATION — edit these to your liking
    // ─────────────────────────────────────────────

    const CONFIG = {
        // How much each speed-up / slow-down key changes the rate
        SPEED_STEP: 0.1,

        // Speeds (in order) that the cycle key rotates through
        CYCLE_SPEEDS: [1, 2, 3],

        // Min / max playback rate clamps
        MIN_SPEED: 0.1,
        MAX_SPEED: 16,

        // How long the tooltip stays visible (ms)
        TOOLTIP_DURATION: 1500,

        // Tooltip fade-out duration (ms)
        TOOLTIP_FADE: 300,

        // Key bindings  (lowercase; use '\\' for backslash)
        KEYS: {
            SPEED_UP:    'd',
            SPEED_DOWN:  's',
            RESET:       'r',
            CYCLE:       ['g', '\\'],
            FRAME_PREV:  'q',
            FRAME_NEXT:  'e',
        },
    };

    // ─────────────────────────────────────────────
    //  State
    // ─────────────────────────────────────────────

    let activeVideo  = null;
    let cycleIndex   = 0;
    let tooltipEl    = null;
    let tooltipTimer = null;

    // ─────────────────────────────────────────────
    //  Tooltip
    // ─────────────────────────────────────────────

    function showTooltip(message) {
        if (!tooltipEl) {
            tooltipEl = document.createElement('div');
            tooltipEl.style.cssText = `
                position: fixed;
                top: 20px;
                left: 50%;
                transform: translateX(-50%);
                background: rgba(0, 0, 0, 0.7);
                color: #fff;
                padding: 8px 16px;
                border-radius: 4px;
                font-family: Arial, sans-serif;
                font-size: 16px;
                z-index: 2147483647;
                pointer-events: none;
                transition: opacity 0.3s ease;
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
            `;
            document.body.appendChild(tooltipEl);
        }
        tooltipEl.textContent = message;
        tooltipEl.style.opacity = '1';
        tooltipEl.style.display = 'block';

        clearTimeout(tooltipTimer);
        tooltipTimer = setTimeout(() => {
            tooltipEl.style.opacity = '0';
            setTimeout(() => { tooltipEl.style.display = 'none'; }, CONFIG.TOOLTIP_FADE);
        }, CONFIG.TOOLTIP_DURATION);
    }

    // ─────────────────────────────────────────────
    //  Video detection
    // ─────────────────────────────────────────────

    function findBestVideo() {
        const videos = Array.from(document.querySelectorAll('video'));
        if (videos.length === 0) return null;
        if (videos.length === 1) return videos[0];

        const playing = videos.find(v => !v.paused);
        if (playing) return playing;

        return videos.reduce((best, cur) => {
            const a = cur.getBoundingClientRect();
            const b = best.getBoundingClientRect();
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
        let message = '';

        if (key === K.SPEED_UP) {
            activeVideo.playbackRate = Math.min(CONFIG.MAX_SPEED, +(activeVideo.playbackRate + CONFIG.SPEED_STEP).toFixed(1));
            message = `Speed: ${activeVideo.playbackRate.toFixed(1)}x`;

        } else if (key === K.SPEED_DOWN) {
            activeVideo.playbackRate = Math.max(CONFIG.MIN_SPEED, +(activeVideo.playbackRate - CONFIG.SPEED_STEP).toFixed(1));
            message = `Speed: ${activeVideo.playbackRate.toFixed(1)}x`;

        } else if (key === K.RESET) {
            activeVideo.playbackRate = 1.0;
            cycleIndex = 0;
            message = 'Speed: 1.0x (Reset)';

        } else if (K.CYCLE.includes(key)) {
            cycleIndex = (cycleIndex + 1) % CONFIG.CYCLE_SPEEDS.length;
            activeVideo.playbackRate = CONFIG.CYCLE_SPEEDS[cycleIndex];
            message = `Speed: ${CONFIG.CYCLE_SPEEDS[cycleIndex]}x`;

        } else if (key === K.FRAME_PREV) {
            stepFrame(activeVideo, -1);
            message = '◄ Previous Frame';

        } else if (key === K.FRAME_NEXT) {
            stepFrame(activeVideo, 1);
            message = 'Next Frame ►';

        } else {
            handled = false;
        }

        if (handled) {
            showTooltip(message);
            e.preventDefault();
            e.stopPropagation();
        }
    }

    // ─────────────────────────────────────────────
    //  Init
    // ─────────────────────────────────────────────

    function init() {
        updateActiveVideo();
        document.addEventListener('keydown', handleKeyPress, true);
        document.addEventListener('play', (e) => {
            if (e.target instanceof HTMLVideoElement) activeVideo = e.target;
        }, true);

        new MutationObserver((mutations) => {
            for (const m of mutations)
                for (const node of m.addedNodes)
                    if (node instanceof Element &&
                        (node.tagName === 'VIDEO' || node.querySelectorAll?.('video').length > 0))
                        updateActiveVideo();
        }).observe(document.body || document.documentElement, { childList: true, subtree: true });
    }

    document.body ? init() : document.addEventListener('DOMContentLoaded', init);

})();
