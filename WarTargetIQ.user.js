// ==UserScript==
// @name         WarTargetIQ
// @namespace    samara.WarTargetIQ
// @version      0.1.4
// @description  Manually open an Okay enemy from an active faction war within your estimated FF range. TornPDA compatible.
// @match        https://www.torn.com/*
// @match        https://torn.com/*
// @grant        GM_xmlhttpRequest
// @connect      api.torn.com
// @connect      ffscouter.com
// @run-at       document-end
// @license      MIT
// @homepageURL  https://github.com/swilliams9114-collab/WarTargetIQ
// @downloadURL  https://raw.githubusercontent.com/swilliams9114-collab/WarTargetIQ/main/WarTargetIQ.user.js
// @updateURL    https://raw.githubusercontent.com/swilliams9114-collab/WarTargetIQ/main/WarTargetIQ.user.js
// ==/UserScript==

/* Independently written companion for standard FF Scouter V2.
 * Data: Torn API v2 and FFScouter's public get-stats endpoint.
 * No Torn HTML fetching, background-page scraping, combat requests or automatic navigation.
 * API keys stay in this browser's localStorage, unencrypted. The FF key is sent to
 * ffscouter.com for estimates; the Torn key (or FF key when blank) goes to api.torn.com.
 * FFScouter handles its data under https://ffscouter.com/ data policy.
 * No remote storage operated by this script. Local storage contains settings only.
 * No target history or accumulating logs. Estimates/rosters are temporary in memory.
 */
(function () {
    'use strict';
    const STORAGE = 'wartargetiq_settings_v1';
    const POSITION = 'wartargetiq_position_v1';
    const DEFAULTS = { ffKey: '', tornKey: '', min: 1, max: 3, enabled: true };
    let settings;
    try { settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE) || '{}') }; }
    catch (_) { settings = { ...DEFAULTS }; }
    let busy = false, lastClick = 0, generation = 0, hasWar = false;
    let apiPaused = false, retryAfter = 0;
    let root, action, message, panel, keyInput, tornInput, minInput, maxInput;

    function validSettings(s) {
        return /^[a-zA-Z0-9]{16}$/.test(s.ffKey) &&
            (!s.tornKey || /^[a-zA-Z0-9]{16}$/.test(s.tornKey)) &&
            Number.isFinite(s.min) && Number.isFinite(s.max) && s.min >= 1 && s.max >= s.min;
    }
    function activeEnemies(wars, ownId, now = Date.now() / 1000) {
        if (!wars || !Object.prototype.hasOwnProperty.call(wars, 'ranked') ||
            !Array.isArray(wars.raids) || !Array.isArray(wars.territory)) {
            throw new Error('Unexpected war API response. No target opened.');
        }
        const enemies = new Map();
        for (const war of [wars.ranked, ...wars.raids, ...wars.territory].filter(Boolean)) {
            if (!(Number(war.start) > 0 && Number(war.start) <= now) ||
                (war.end !== null && Number(war.end) !== 0) || Number(war.winner) > 0) continue;
            if (!Array.isArray(war.factions) || !war.factions.some(f => Number(f.id) === ownId)) continue;
            for (const f of war.factions) {
                const id = Number(f.id);
                if (id > 0 && id !== ownId) enemies.set(id, { id, name: f.name });
            }
        }
        return enemies;
    }
    function estimates(data) {
        if (!Array.isArray(data)) throw new Error('FFScouter returned an unexpected response.');
        const map = new Map();
        for (const row of data) {
            const ff = row.available_estimates?.[row.source]?.fair_fight ?? row.fair_fight;
            if (row.player_id && typeof ff === 'number' && Number.isFinite(ff) && ff >= 1)
                map.set(Number(row.player_id), ff);
        }
        return map;
    }
    function eligible(members, ffMap, s) {
        return members.filter(m => m.status?.state === 'Okay' &&
            Number.isInteger(Number(m.id)) && Number(m.id) > 0 &&
            ffMap.has(Number(m.id)) && ffMap.get(Number(m.id)) >= s.min &&
            ffMap.get(Number(m.id)) <= s.max);
    }
    async function request(url, service) {
        if (settings.enabled === false) throw new Error('WarIQ is disabled. Enable it in profile settings.');
        if (apiPaused) throw new Error('API requests paused. Check your keys and save settings to resume.');
        if (Date.now() < retryAfter) throw new Error('API rate limit reached. Wait two minutes before retrying.');
        let response;
        try {
            if (typeof window.PDA_httpGet === 'function') {
                response = await Promise.race([
                    window.PDA_httpGet(url, {}),
                    new Promise((_, reject) => setTimeout(() => reject(new Error()), 20000))
                ]);
            } else if (typeof GM_xmlhttpRequest === 'function') {
                response = await new Promise((resolve, reject) => GM_xmlhttpRequest({
                    method: 'GET', url, timeout: 20000, onload: resolve,
                    onerror: reject, ontimeout: reject
                }));
            } else {
                throw new Error();
            }
        } catch (_) { throw new Error(service + ' request failed. Check your connection and script permissions.'); }
        if (Number(response?.status) === 429) retryAfter = Date.now() + 120000;
        if (!response || Number(response.status) !== 200)
            throw new Error(service + ' HTTP error. Try again later.');
        let data;
        try { data = JSON.parse(response.responseText); }
        catch (_) { throw new Error(service + ' returned invalid data.'); }
        if (data.error || (data.code !== undefined && !Array.isArray(data))) {
            // Do not print upstream error text or request URLs: either could contain a key.
            const code = data.error?.code ?? data.code;
            if (service === 'Torn') {
                const n = Number(code);
                if ([2, 13, 18].includes(n)) {
                    apiPaused = true;
                    if (settings.tornKey) settings.tornKey = '';
                    else settings.ffKey = '';
                    try { localStorage.setItem(STORAGE, JSON.stringify(settings)); } catch (_) {}
                    if (keyInput) keyInput.value = settings.ffKey;
                    if (tornInput) tornInput.value = settings.tornKey;
                } else if (n === 16) apiPaused = true;
                else if ([5, 8].includes(n)) retryAfter = Date.now() + 120000;
            }
            throw new Error(service + ' API error' + (Number.isFinite(Number(code)) ? ' ' + Number(code) : '') +
                '. Check key access/FFScouter registration, or retry later.');
        }
        return data;
    }
    function torn(path) {
        const q = new URLSearchParams({ key: settings.tornKey || settings.ffKey,
            comment: 'WarTargetIQ-0.1.4', timestamp: String(Math.floor(Date.now() / 1000)) });
        return request('https://api.torn.com/v2/' + path + '?' + q, 'Torn');
    }
    async function context() {
        const [user, data] = await Promise.all([torn('user/faction'), torn('faction/wars')]);
        if (!user.faction?.id) return { ownId: 0, enemies: new Map() };
        const ownId = Number(user.faction.id);
        return { ownId, enemies: activeEnemies(data.wars, ownId) };
    }
    let syncEnabledUI = () => {};
    let profileDetails;
    let toastTimer;
    let positionPopup = () => {};
    function say(text, show = false) {
        message.textContent = text;
        if (action) action.title = text + '. Hold WFF for settings.';
        if (show && root) {
            const content = root.querySelector('.wti-content');
            content.hidden = false;
            positionPopup();
            clearTimeout(toastTimer);
            toastTimer = setTimeout(() => { if (panel.hidden) content.hidden = true; }, 6000);
        }
    }
    function resetAction() {
        action.disabled = busy;
        action.textContent = busy ? '…' : 'WFF';
        action.setAttribute?.('aria-label', busy ? 'Checking war targets' : 'Find war target. Hold for settings');
    }
    async function checkWar() {
        if (settings.enabled === false || busy || document.hidden || apiPaused || Date.now() < retryAfter || !validSettings(settings)) return;
        const token = generation;
        try {
            const c = await context();
            if (token !== generation || busy) return;
            hasWar = c.enemies.size > 0;
            say(hasWar ? 'Active war · FF ' + settings.min + '–' + settings.max : 'No active war');
        } catch (e) {
            if (token !== generation || busy) return;
            hasWar = false;
            say(e.message);
        }
        resetAction();
    }
    async function findTarget() {
        if (settings.enabled === false || busy || document.hidden) return;
        if (apiPaused) { panel.hidden = false; say('API requests paused. Check your keys and save settings to resume.', true); return; }
        if (!validSettings(settings)) { panel.hidden = false; say('Save your FFScouter key and FF range first.', true); return; }
        if (Date.now() - lastClick < 8000) { say('Wait a few seconds before checking again.', true); return; }
        lastClick = Date.now(); busy = true; generation++; resetAction();
        const token = generation;
        say('Checking current war and available enemies…', true);
        try {
            const c = await context();
            hasWar = c.enemies.size > 0;
            if (!hasWar) { say('No active war', true); return; }
            const members = [];
            // Sequential rosters keep simultaneous API usage modest.
            for (const enemy of c.enemies.values()) {
                const data = await torn('faction/' + enemy.id + '/members');
                if (!Array.isArray(data.members)) throw new Error('Unexpected member API response.');
                members.push(...data.members.map(m => ({ ...m, factionId: enemy.id })));
            }
            const available = members.filter(m => m.status?.state === 'Okay');
            if (!available.length) { say('No available targets — enemies are not Okay.', true); return; }
            const ffMap = new Map();
            for (let i = 0; i < available.length; i += 50) {
                const q = new URLSearchParams({ key: settings.ffKey,
                    targets: available.slice(i, i + 50).map(m => m.id).join(',') });
                const data = await request('https://ffscouter.com/api/v1/get-stats?' + q, 'FFScouter');
                for (const [id, ff] of estimates(data)) ffMap.set(id, ff);
            }
            const candidates = eligible(available, ffMap, settings);
            if (!candidates.length) {
                say('No available targets in FF ' + settings.min + '–' + settings.max +
                    '. ' + available.filter(m => !ffMap.has(Number(m.id))).length + ' lack an FF estimate.', true);
                return;
            }
            const chosen = candidates[Math.floor(Math.random() * candidates.length)];
            // Re-check wars and chosen player's status/faction just before navigation.
            const [current, detail] = await Promise.all([context(), torn('user/' + chosen.id + '/profile')]);
            if (settings.enabled === false || token !== generation || document.hidden) { say('Cancelled — tap again when viewing Torn.', true); return; }
            const p = detail.profile;
            if (current.ownId !== c.ownId || !current.enemies.has(chosen.factionId)) {
                hasWar = current.enemies.size > 0;
                say('War changed or ended. Tap again to check current opponents.', true); return;
            }
            if (Number(p?.id) !== Number(chosen.id) || p.status?.state !== 'Okay' ||
                Number(p.faction_id) !== chosen.factionId) {
                say('Target became unavailable. Tap again for another.', true); return;
            }
            say('Opening ' + chosen.name + ' · estimated FF ' + ffMap.get(Number(chosen.id)).toFixed(2), true);
            // The only non-API request initiated by this script: one navigation from this tap.
            window.location.assign('https://www.torn.com/loader.php?sid=attack&user2ID=' + Number(chosen.id));
        } catch (e) { say(e.message, true); }
        finally { busy = false; resetAction(); }
    }
    function boot() {
        if (document.getElementById('wartargetiq')) return;
        const style = document.createElement('style');
        style.textContent = `#wartargetiq{position:fixed;left:8px;bottom:76px;z-index:999990;font:12px Arial,sans-serif;color:#eee}:is(#wartargetiq,#wartargetiq-profile) button{min-height:36px;background:#3d3d3d;color:#fff;border:1px solid #777;border-radius:5px;padding:6px 8px;font-size:12px}#wartargetiq button.wti-action{display:block;width:42px;height:42px;min-height:42px;padding:0;border-radius:50%;background:#c62828;border:1px solid #ff7474;color:#fff;font-size:12px;font-weight:bold;box-shadow:0 2px 8px #0007;touch-action:none;cursor:grab;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}#wartargetiq button.wti-action:active{background:#a51e1e}#wartargetiq button:disabled{opacity:.65}#wartargetiq .wti-content{position:absolute;left:0;bottom:50px;width:260px;max-width:calc(100vw - 24px);max-height:calc(100dvh - 140px);overflow:auto;box-sizing:border-box;padding:10px;background:#242424;border:1px solid #777;border-radius:8px;box-shadow:0 3px 12px #0008}:is(#wartargetiq,#wartargetiq-profile) .wti-row{display:flex;gap:6px}#wartargetiq .wti-head{display:flex;justify-content:space-between;align-items:center}#wartargetiq .wti-close{min-height:28px;padding:2px 8px}#wartargetiq .wti-message{margin-top:6px;line-height:1.35;overflow-wrap:anywhere}:is(#wartargetiq,#wartargetiq-profile) label{display:block;margin-top:8px}:is(#wartargetiq,#wartargetiq-profile) input{width:100%;box-sizing:border-box;min-height:32px;margin-top:3px;background:#151515;color:#fff;border:1px solid #777;border-radius:4px;padding:5px}:is(#wartargetiq,#wartargetiq-profile) .wti-range label{width:50%}:is(#wartargetiq,#wartargetiq-profile) small{display:block;line-height:1.35;color:#ccc;margin-top:8px}:is(#wartargetiq,#wartargetiq-profile) .wti-tos{overflow-x:auto;margin-top:8px}:is(#wartargetiq,#wartargetiq-profile) table{border-collapse:collapse;min-width:620px;font-size:11px;line-height:1.35}#wartargetiq th,:is(#wartargetiq,#wartargetiq-profile) td{border:1px solid #666;padding:6px;text-align:left;vertical-align:top}:is(#wartargetiq,#wartargetiq-profile) a{color:#ffaaaa}:is(#wartargetiq,#wartargetiq-profile) [hidden]{display:none!important}:is(#wartargetiq,#wartargetiq-profile) .wti-save{margin-top:8px;width:100%}`;
        style.textContent += `#wartargetiq-profile{clear:both;margin:12px 0;padding:0;background:var(--default-bg-panel-color,#242424);color:var(--default-color,#eee);border:1px solid #777;border-radius:6px;font:12px Arial,sans-serif}#wartargetiq-profile>summary{padding:12px;font-weight:bold;cursor:pointer}#wartargetiq-profile .wti-profile-body{padding:0 12px 12px}#wartargetiq-profile .wti-enable-label{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:bold;margin:8px 0}#wartargetiq-profile input.wti-enable{width:20px;min-height:20px;height:20px;margin:0;padding:0;accent-color:#c62828}#wartargetiq-profile .wti-profile-status{margin:6px 0;line-height:1.4}#wartargetiq-profile .wti-panel>b{display:none}`;
        document.head.appendChild(style);
        root = document.createElement('div'); root.id = 'wartargetiq';
        root.innerHTML = `<button class="wti-action" type="button" aria-label="Find war target. Hold for settings" title="Tap to find a war target. Hold for settings.">WFF</button><div class="wti-content" hidden><div class="wti-head"><b>WarTargetIQ</b><button class="wti-close" type="button" aria-label="Close WarTargetIQ panel">×</button></div><div class="wti-message" role="status" aria-live="polite"></div><div class="wti-panel" hidden><b>WarTargetIQ · v0.1.4</b><small><b>API data use</b> — read before entering a key. Swipe the table sideways.</small><div class="wti-tos"><table><thead><tr><th>Data Storage</th><th>Data Sharing</th><th>Purpose of Use</th><th>Key Storage &amp; Sharing</th><th>Key Access Level</th></tr></thead><tbody><tr><td>WarTargetIQ: settings remain locally until removed. Rosters and estimates exist only in memory during requests.</td><td>WarTargetIQ sends target IDs and your FF key to FFScouter. Direct Torn requests go to Torn. No developer server, analytics or Discord sharing.</td><td>Competitive advantage: filter available current war enemies by estimated FF and open one attack page following your tap.</td><td>Keys stored locally, unencrypted; accessible to scripts/device users with access to this browser. HTTPS requests send FF key to ffscouter.com and effective Torn key to api.torn.com. Never embedded in this published script.</td><td>Torn calls: Public, or Custom user faction/profile and faction wars/members. FF key: registered FFScouter Custom key; see linked terms. Full access unnecessary.</td></tr><tr><td>FFScouter: player IDs/public scores persist indefinitely; key, private score and personal data retained until service-account deletion. Attack/HoF data processed briefly.</td><td>FFScouter owners access private data/key; public IDs and opponent estimates are shared publicly. Private stats are not published.</td><td>FFScouter estimates opponent strength and uses permitted private score/personal data for analysis and model training.</td><td>FFScouter retains registered keys for its API processing. Removing local settings does not erase its records; use its removal form or revoke the key in Torn.</td><td>FFScouter core: basic, battlestats, attacks, hof, personalstats. Registration builder includes additional selections; current scope appears in its terms.</td></tr></tbody></table></div><small><a href="https://www.torn.com/api.html" target="_blank" rel="noopener noreferrer">Torn API terms</a> · <a href="https://www.torn.com/rules.php" target="_blank" rel="noopener noreferrer">Scripting rules</a> · <a href="https://ffscouter.com/" target="_blank" rel="noopener noreferrer">FFScouter terms, Data Policy &amp; removal form</a></small><small>API-only data collection; no background-page scraping, CAPTCHA bypass, automatic attacks or combat clicks. Navigation requires your tap. Independent tool; no Torn staff endorsement.</small><label>Registered FFScouter Torn API key<input class="wti-key" type="password" autocomplete="off" spellcheck="false"></label><label>Separate Torn API key (optional)<input class="wti-torn" type="password" autocomplete="off" spellcheck="false" placeholder="Blank = use FFScouter key"></label><div class="wti-row wti-range"><label>Minimum FF<input class="wti-min" type="number" min="1" step="0.1"></label><label>Maximum FF<input class="wti-max" type="number" min="1" step="0.1"></label></div><small>Uses your currently active ranked wars, raids and territory wars. Only Okay enemies with known FF estimates qualify. FF is an estimate, not a guaranteed win.</small><small>Keys are saved on this device. FF key → ffscouter.com; Torn key → api.torn.com. Use the same registered key as standard FF Scouter. A separate Torn key needs public faction/profile access.</small><button class="wti-save" type="button">Save settings</button><button class="wti-forget wti-save" type="button">Remove saved settings</button></div></div>`;
        document.body.appendChild(root);
        action = root.querySelector('.wti-action'); message = root.querySelector('.wti-message');
        panel = root.querySelector('.wti-panel'); keyInput = root.querySelector('.wti-key');
        tornInput = root.querySelector('.wti-torn'); minInput = root.querySelector('.wti-min'); maxInput = root.querySelector('.wti-max');
        const fill = () => { keyInput.value = settings.ffKey; tornInput.value = settings.tornKey;
            minInput.value = settings.min; maxInput.value = settings.max; };
        fill();
        const openSettings = () => {
            clearTimeout(toastTimer);
            if (profileDetails?.isConnected) { profileDetails.open = true; panel.hidden = false; return; }
            root.querySelector('.wti-content').hidden = false;
            panel.hidden = false;
            positionPopup();
        };
        let pressTimer, held = false, gesture = null;
        const place = (x, y) => {
            const size = action.getBoundingClientRect();
            const maxX = Math.max(0, window.innerWidth - size.width - 8);
            const maxY = Math.max(0, window.innerHeight - size.height - 8);
            x = Math.max(Math.min(8, maxX), Math.min(x, maxX));
            y = Math.max(Math.min(8, maxY), Math.min(y, maxY));
            root.style.left = x + 'px'; root.style.top = y + 'px';
            root.style.bottom = 'auto'; root.style.right = 'auto';
            positionPopup();
            return { x, y };
        };
        positionPopup = () => {
            const content = root.querySelector('.wti-content');
            const rect = action.getBoundingClientRect();
            const width = Math.min(260, window.innerWidth - 24);
            const left = Math.max(8 - rect.left, Math.min(0, window.innerWidth - 8 - width - rect.left));
            content.style.left = left + 'px';
            const above = rect.top > (window.innerHeight - rect.bottom);
            content.style.bottom = above ? '50px' : 'auto';
            content.style.top = above ? 'auto' : '50px';
            content.style.maxHeight = Math.max(40, (above ? rect.top : window.innerHeight - rect.bottom) - 16) + 'px';
        };
        try {
            const saved = JSON.parse(localStorage.getItem(POSITION) || 'null');
            if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) place(saved.x, saved.y);
        } catch (_) {}
        positionPopup();
        const savePosition = position => {
            try { localStorage.setItem(POSITION, JSON.stringify(position)); } catch (_) {}
        };
        action.addEventListener('pointerdown', e => {
            if (e.button !== 0 || e.isPrimary === false || busy || gesture) return;
            held = false;
            const rect = action.getBoundingClientRect();
            gesture = { id: e.pointerId, x: e.clientX, y: e.clientY,
                left: rect.left, top: rect.top, dragging: false };
            try { action.setPointerCapture(e.pointerId); } catch (_) {}
            clearTimeout(pressTimer);
            pressTimer = setTimeout(() => { held = true; openSettings(); }, 550);
        });
        action.addEventListener('pointermove', e => {
            if (!gesture || gesture.id !== e.pointerId) return;
            const dx = e.clientX - gesture.x, dy = e.clientY - gesture.y;
            if (!gesture.dragging && Math.hypot(dx, dy) <= 8) return;
            gesture.dragging = true; held = true; clearTimeout(pressTimer);
            root.querySelector('.wti-content').hidden = true;
            action.style.cursor = 'grabbing';
            place(gesture.left + dx, gesture.top + dy);
            e.preventDefault();
        });
        const finishGesture = e => {
            if (!gesture || gesture.id !== e.pointerId) return;
            clearTimeout(pressTimer);
            if (gesture.dragging) {
                held = true;
                const rect = action.getBoundingClientRect();
                savePosition(place(rect.left, rect.top));
            }
            gesture = null; action.style.cursor = '';
            try { if (action.hasPointerCapture(e.pointerId)) action.releasePointerCapture(e.pointerId); } catch (_) {}
        };
        action.addEventListener('pointerup', finishGesture);
        action.addEventListener('pointercancel', finishGesture);
        action.addEventListener('lostpointercapture', finishGesture);
        action.addEventListener('contextmenu', e => {
            e.preventDefault();
            if (gesture?.dragging) return;
            held = true; openSettings();
        });
        action.addEventListener('click', e => {
            if (held) { held = false; e.preventDefault(); return; }
            if (e.shiftKey) { openSettings(); return; }
            findTarget();
        });
        window.addEventListener('resize', () => {
            const rect = action.getBoundingClientRect();
            if (root.style.top) savePosition(place(rect.left, rect.top));
            else positionPopup();
        });
        root.querySelector('.wti-close').addEventListener('click', () => {
            clearTimeout(toastTimer); root.querySelector('.wti-content').hidden = true;
        });
        root.querySelector('.wti-save').addEventListener('click', () => {
            if (busy) return;
            const next = { enabled: settings.enabled !== false, ffKey: keyInput.value.trim(), tornKey: tornInput.value.trim(),
                min: minInput.value.trim() ? Number(minInput.value) : NaN,
                max: maxInput.value.trim() ? Number(maxInput.value) : NaN };
            if (!validSettings(next)) { say('Use 16-character keys and an FF range with 1 ≤ minimum ≤ maximum.'); return; }
            try { localStorage.setItem(STORAGE, JSON.stringify(next)); }
            catch (_) { say('Could not save settings on this device.'); return; }
            settings = next; apiPaused = false; retryAfter = 0; generation++; panel.hidden = !!(!profileDetails?.isConnected); root.querySelector('.wti-content').hidden = true; hasWar = false; syncEnabledUI();
            say('Saved. Checking for war…'); checkWar();
        });
        root.querySelector('.wti-forget').addEventListener('click', () => {
            if (busy || !window.confirm('Remove WarTargetIQ keys and settings from this device?')) return;
            try { localStorage.removeItem(STORAGE); localStorage.removeItem(POSITION); }
            catch (_) { say('Could not remove saved settings.'); return; }
            settings = { ...DEFAULTS }; apiPaused = false; retryAfter = 0; generation++; hasWar = false; fill();
            panel.hidden = false; syncEnabledUI(); say('Settings removed.'); resetAction();
        });
        const mountProfileSettings = () => {
            if (document.hidden || location.pathname !== '/profiles.php') return;
            const ff = document.querySelector('ff-settings-panel');
            const wrapper = document.querySelector('.profile-wrapper');
            const anchor = ff || wrapper;
            if (!anchor?.parentNode) return;
            if (!profileDetails) {
                profileDetails = document.createElement('details');
                profileDetails.id = 'wartargetiq-profile';
                profileDetails.className = 'cont-gray border-round';
                profileDetails.innerHTML = `<summary>WarIQ Settings</summary><div class="wti-profile-body"><label class="wti-enable-label"><input class="wti-enable" type="checkbox">Enable WarIQ</label><div class="wti-profile-status" role="status"></div><div class="wti-profile-form"></div></div>`;
                const toggle = profileDetails.querySelector('.wti-enable');
                const status = profileDetails.querySelector('.wti-profile-status');
                syncEnabledUI = () => {
                    root.hidden = settings.enabled === false;
                    toggle.checked = settings.enabled !== false;
                    status.textContent = settings.enabled === false
                        ? 'Off — WFF is hidden and WarIQ makes no new API requests.'
                        : 'On — tap WFF to find a target. Drag to move it; hold for settings.';
                };
                toggle.addEventListener('change', () => {
                    const next = { ...settings, enabled: toggle.checked };
                    try { localStorage.setItem(STORAGE, JSON.stringify(next)); }
                    catch (_) { toggle.checked = settings.enabled !== false; status.textContent = 'Could not save the toggle on this device.'; return; }
                    settings = next; generation++; hasWar = false;
                    clearTimeout(toastTimer); root.querySelector('.wti-content').hidden = true;
                    syncEnabledUI();
                    if (settings.enabled !== false) checkWar();
                });
                profileDetails.querySelector('.wti-profile-form').appendChild(panel);
                panel.hidden = false;
                syncEnabledUI();
            }
            // Observe only the current foreground profile layout, never scrape another tab.
            if (anchor.nextElementSibling !== profileDetails)
                anchor.parentNode.insertBefore(profileDetails, anchor.nextSibling);
        };
        root.hidden = settings.enabled === false;
        mountProfileSettings();
        if (location.pathname === '/profiles.php') {
            let mountTimer;
            const observer = new MutationObserver(() => {
                if (document.hidden) return;
                clearTimeout(mountTimer);
                mountTimer = setTimeout(mountProfileSettings, 100);
            });
            observer.observe(document.body, { childList: true, subtree: true });
            document.addEventListener('visibilitychange', () => {
                if (!document.hidden) mountProfileSettings();
            });
        }
        if (!validSettings(settings)) { openSettings(); say('Enter your FFScouter key to get started.'); }
        else checkWar();
        resetAction();
        // API-only monitoring; never read a background Torn page or open an attack automatically.
        setInterval(checkWar, 60000);
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) generation++;
            else checkWar();
        });
    }
    boot();
})();
