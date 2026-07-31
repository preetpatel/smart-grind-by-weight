// Grinder card: the device-centric header above the tabs.
//
// No known grinder → a "Connect your grinder" hero (one-time pairing).
// Known grinder → a compact card rendered from the cached snapshot
// (firmware version, sessions on device, WiFi state), refreshed silently
// in the background when the browser supports persistent BLE permissions.
// Also drives the snapshot-aware states inside the Update and WiFi panels.
(function () {
    'use strict';

    const GS = window.GrinderSession;
    let busy = false;

    const $ = (id) => document.getElementById(id);

    function el(tag, attrs = {}, children = []) {
        const node = document.createElement(tag);
        for (const [key, value] of Object.entries(attrs)) {
            if (key === 'class') node.className = value;
            else if (key === 'text') node.textContent = value;
            else node.setAttribute(key, value);
        }
        for (const child of children) node.appendChild(child);
        return node;
    }

    function agoLabel(ts) {
        if (!ts) return null;
        const minutes = Math.floor((Date.now() - ts) / 60000);
        if (minutes < 1) return 'just now';
        if (minutes < 60) return `${minutes}m ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 48) return `${hours}h ago`;
        return `${Math.floor(hours / 24)}d ago`;
    }

    // "1.7.0" vs "1.6.0-rc.1" → positive when a is newer. Prerelease of the
    // same numeric version sorts below its release.
    function compareVersions(a, b) {
        const parse = (v) => {
            const [main, pre] = String(v).replace(/^v/, '').split('-');
            return { nums: main.split('.').map((n) => parseInt(n, 10) || 0), pre: pre || null };
        };
        const va = parse(a);
        const vb = parse(b);
        for (let i = 0; i < 3; i++) {
            const diff = (va.nums[i] || 0) - (vb.nums[i] || 0);
            if (diff) return diff;
        }
        if (!va.pre && vb.pre) return 1;
        if (va.pre && !vb.pre) return -1;
        if (va.pre && vb.pre) return va.pre.localeCompare(vb.pre);
        return 0;
    }

    // Latest release the device could move to; set by loadReleases().
    function latestRelease() {
        return window.latestFirmware?.stable || null;
    }

    function updateAvailable(snapshot) {
        const latest = latestRelease();
        const current = snapshot?.system?.version;
        if (!latest || !current) return null;
        return compareVersions(latest.version, current) > 0 ? latest : null;
    }

    function wifiShortLabel(wifi) {
        if (!wifi) return null;
        if (!wifi.configured) return 'WiFi not set up';
        if (!wifi.enabled) return 'WiFi off';
        if (wifi.time_synced) return 'WiFi · clock synced';
        return 'WiFi configured';
    }

    // ---- card ----------------------------------------------------------

    function renderHero(host) {
        const hero = el('div', { class: 'grinder-hero' });
        hero.appendChild(el('h2', { text: 'Connect your grinder' }));
        hero.appendChild(el('p', {
            class: 'lede-line',
            text: 'Pair it once with this browser — its firmware, WiFi and grind data status then show up here on every visit.',
        }));

        const button = el('button', { class: 'btn', text: 'Connect grinder' });
        button.addEventListener('click', () => runBusy(async () => {
            await GS.addGrinder();
            if (typeof window.showGrinderTab === 'function') window.showGrinderTab('ota');
        }, 'Could not connect'));
        hero.appendChild(button);

        const links = el('p', { class: 'hero-links' });
        links.appendChild(document.createTextNode('New grinder without firmware yet? '));
        links.appendChild(link('Start here', () => window.showGrinderTab?.('initial')));
        links.appendChild(document.createTextNode(' · Or '));
        links.appendChild(link('browse analytics', () => window.showTab?.('analytics')));
        links.appendChild(document.createTextNode(' without a device.'));
        hero.appendChild(links);
        host.appendChild(hero);
    }

    function link(text, onClick) {
        const a = el('a', { text, href: '#' });
        a.addEventListener('click', (event) => {
            event.preventDefault();
            onClick();
        });
        return a;
    }

    function renderCard(host, active) {
        const card = el('div', { class: 'grinder-card' });
        const snapshot = active.snapshot;

        card.appendChild(el('span', { class: `conn-dot ${GS.isConnected() ? 'connected' : ''}` }));
        card.appendChild(el('span', { class: 'g-name', text: active.label }));

        const facts = el('div', { class: 'g-facts' });
        if (snapshot?.system?.version) {
            facts.appendChild(el('span', { text: `v${snapshot.system.version}${snapshot.build ? ` · build ${snapshot.build}` : ''}` }));
        }
        if (snapshot?.sessions?.total_sessions !== undefined) {
            facts.appendChild(el('span', { text: `${snapshot.sessions.total_sessions} sessions on device` }));
        }
        const wifiLabel = wifiShortLabel(snapshot?.wifi);
        if (wifiLabel) facts.appendChild(el('span', { text: wifiLabel }));
        const ago = agoLabel(snapshot?.fetchedAt);
        facts.appendChild(el('span', { text: snapshot ? `checked ${ago}` : 'not checked yet — hit Refresh' }));
        card.appendChild(facts);

        const newer = updateAvailable(snapshot);
        if (newer) {
            const chip = el('button', { class: 'g-chip update', text: `Update available: v${newer.version}` });
            chip.addEventListener('click', () => window.showGrinderTab?.('ota'));
            card.appendChild(chip);
        }
        if (snapshot?.sessions?.logging_enabled === false) {
            card.appendChild(el('span', { class: 'g-chip warn', text: 'Grind logging off' }));
        }

        const actions = el('div', { class: 'g-actions' });
        const grinders = GS.listGrinders();
        if (grinders.length > 1) {
            const switcher = el('select', {});
            for (const grinder of grinders) {
                const option = el('option', { value: grinder.id, text: grinder.label });
                if (grinder.id === active.id) option.selected = true;
                switcher.appendChild(option);
            }
            switcher.addEventListener('change', () => GS.setActive(switcher.value));
            actions.appendChild(switcher);
        }
        actions.appendChild(ghostButton('Refresh', () => runBusy(
            () => GS.refreshSnapshot({ interactive: true }), 'Refresh failed')));
        actions.appendChild(ghostButton('+ Add', () => runBusy(
            () => GS.addGrinder(), 'Could not add grinder')));
        actions.appendChild(ghostButton('Forget', () => {
            if (window.confirm(`Forget ${active.label} in this browser? The grinder itself is not changed.`)) {
                GS.forget(active.id);
            }
        }, 'danger'));
        card.appendChild(actions);
        host.appendChild(card);
    }

    function ghostButton(text, onClick, extraClass = '') {
        const button = el('button', { class: `btn-ghost ${extraClass}`, text });
        button.addEventListener('click', onClick);
        return button;
    }

    async function runBusy(fn, errorPrefix) {
        if (busy) return;
        busy = true;
        render();
        try {
            await fn();
        } catch (error) {
            if (error.name !== 'NotFoundError') { // chooser dismissed — not an error
                console.error(`${errorPrefix}:`, error);
                alert(`${errorPrefix}: ${error.message}`);
            }
        } finally {
            busy = false;
            render();
        }
    }

    function render() {
        const host = $('grinderCard');
        if (!host) return;
        host.textContent = '';
        const active = GS.getActive();
        if (!active) renderHero(host);
        else renderCard(host, active);
        if (busy) {
            host.querySelectorAll('button, select').forEach((node) => { node.disabled = true; });
        }
    }

    // ---- snapshot-aware panel states ----------------------------------

    function updateOtaPanel() {
        const box = $('otaDeviceState');
        if (!box) return;
        const snapshot = GS.getActive()?.snapshot;
        const current = snapshot?.system?.version;
        if (!current || !latestRelease()) {
            box.style.display = 'none';
            return;
        }
        const newer = updateAvailable(snapshot);
        box.style.display = 'block';
        if (newer) {
            box.className = 'status warning';
            box.textContent = `Update available: v${newer.version} — your grinder runs v${current}.`;
        } else {
            box.className = 'status success';
            box.textContent = `Your grinder is on the latest firmware (v${current}).`;
        }
    }

    function updateWifiPanel() {
        const box = $('wifiKnownStatus');
        const ssidInput = $('wifiSsid');
        const wifi = GS.getActive()?.snapshot?.wifi;
        if (!box) return;
        if (!wifi) {
            box.style.display = 'none';
            return;
        }
        box.style.display = 'block';
        box.className = wifi.time_synced ? 'status success' : 'status info';
        box.textContent = typeof window.describeWifiStatus === 'function'
            ? window.describeWifiStatus(wifi)
            : (wifiShortLabel(wifi) || '');
        if (ssidInput && !ssidInput.value && wifi.ssid) ssidInput.value = wifi.ssid;
    }

    function refreshAll() {
        render();
        updateOtaPanel();
        updateWifiPanel();
    }

    window.addEventListener('load', () => {
        const host = $('grinderCard');
        if (!GS || !GS.isSupported()) {
            if (host) host.style.display = 'none';
            return;
        }
        GS.onChange(refreshAll);
        window.addEventListener('releases-loaded', () => {
            render();
            updateOtaPanel();
        });
        refreshAll();

        // Background refresh of the active grinder — silent (no chooser),
        // quiet on failure (grinder off / browser without getDevices).
        if (GS.getActive()) {
            GS.refreshSnapshot({ interactive: false }).catch(() => {});
        }
    });
})();
