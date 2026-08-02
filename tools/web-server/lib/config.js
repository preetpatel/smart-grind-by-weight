// Operational limits (docs/CLOUD_SYNC.md "Limits"). Env-overridable so the
// self-hosted Docker deployment can raise or disable them.
function intEnv(name, fallback) {
    const value = Number.parseInt(process.env[name] ?? '', 10);
    return Number.isFinite(value) ? value : fallback;
}

export const config = {
    // Largest legitimate session is ~36 KB; anything bigger is rejected
    // before it touches storage.
    get maxSessionBytes() { return intEnv('SYNC_MAX_SESSION_BYTES', 64 * 1024); },
    get maxSnapshotBytes() { return intEnv('SYNC_MAX_SNAPSHOT_BYTES', 4 * 1024); },
    // 0 disables the quota (self-host default via env).
    get sessionQuota() { return intEnv('SYNC_SESSION_QUOTA', 10000); },
    get uploadsPerHour() { return intEnv('SYNC_UPLOADS_PER_HOUR', 200); },
    get storesPerIpPerDay() { return intEnv('SYNC_STORES_PER_IP_PER_DAY', 20); },
    // Stores with no successful upload within this window are garbage-collected.
    get provisionalTtlHours() { return intEnv('SYNC_PROVISIONAL_TTL_HOURS', 48); },
    get manifestMaxEntries() { return intEnv('SYNC_MANIFEST_MAX_ENTRIES', 4096); },
};
