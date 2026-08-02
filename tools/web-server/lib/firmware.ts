// Firmware release index, built server-side from the GitHub releases API.
// Replaces the old GitHub Pages CI step that downloaded every release asset
// into the static site: the index lists releases, and binaries stream
// through /api/firmware/[tag]/[asset] so USB manifests and OTA binaries are
// same-origin for the browser.

export const GITHUB_REPO = process.env.SGBW_GITHUB_REPO ?? 'preetpatel/smart-grind-by-weight';

export interface FirmwareEntry {
    tag: string;
    version: string;
    display: string;
    prerelease: boolean;
    /** Same-origin proxy path to the esp-web-tools manifest, when published. */
    manifest: string | null;
    /** Same-origin proxy path to the BLE OTA binary, when published. */
    ota: string | null;
}

interface GitHubAsset {
    name: string;
}

interface GitHubRelease {
    tag_name: string;
    draft: boolean;
    prerelease: boolean;
    assets: GitHubAsset[];
}

// Sort tags by semantic version so v1.10.0 outranks v1.5.0; a final release
// outranks its own pre-releases (1.5.0 > 1.5.0-rc.2). Mirrors the old CI
// index generator.
function versionKey(tag: string): [number[], number, number[]] {
    const [base = '', suffix = ''] = tag.replace(/^v/, '').split(/-(.*)/s);
    const parts = base.split('.').map((p) => Number.parseInt(p, 10) || 0);
    if (!suffix) return [parts, 1, []];
    return [parts, 0, (suffix.match(/\d+/g) ?? []).map((n) => Number.parseInt(n, 10))];
}

function compareVersionKeys(a: string, b: string): number {
    const ka = versionKey(a);
    const kb = versionKey(b);
    for (let i = 0; i < Math.max(ka[0].length, kb[0].length); i++) {
        const diff = (ka[0][i] ?? 0) - (kb[0][i] ?? 0);
        if (diff) return diff;
    }
    if (ka[1] !== kb[1]) return ka[1] - kb[1];
    for (let i = 0; i < Math.max(ka[2].length, kb[2].length); i++) {
        const diff = (ka[2][i] ?? 0) - (kb[2][i] ?? 0);
        if (diff) return diff;
    }
    return 0;
}

export async function fetchFirmwareIndex(): Promise<FirmwareEntry[]> {
    const response = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=100`,
        {
            headers: { accept: 'application/vnd.github+json' },
            // Cache release metadata; new releases show up within a few minutes.
            next: { revalidate: 300 },
        },
    );
    if (!response.ok) {
        throw new Error(`GitHub releases API returned ${response.status}`);
    }
    const releases = (await response.json()) as GitHubRelease[];

    const entries: FirmwareEntry[] = [];
    for (const release of releases) {
        if (release.draft) continue;
        const tag = release.tag_name;
        const base = `smart-grind-by-weight-${tag}`;
        const names = new Set(release.assets.map((a) => a.name));
        const manifestName = `${base}.manifest.json`;
        const otaName = `${base}-web-ota.bin`;
        if (!names.has(manifestName) && !names.has(otaName)) continue;
        entries.push({
            tag,
            version: tag.replace(/^v/, ''),
            display: tag,
            prerelease:
                release.prerelease || ['-rc', '-beta', '-alpha'].some((k) => tag.includes(k)),
            manifest: names.has(manifestName) ? `/api/firmware/${tag}/${manifestName}` : null,
            ota: names.has(otaName) ? `/api/firmware/${tag}/${otaName}` : null,
        });
    }
    // Newest first: clients preselect the first entry as "latest".
    entries.sort((a, b) => compareVersionKeys(b.tag, a.tag));
    return entries;
}
