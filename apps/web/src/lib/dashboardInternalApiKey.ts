import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';

const PRODUCTION_SECRET_PATH = '/run/secrets/headlessx-dashboard-internal-api-key';
const MAX_SECRET_BYTES = 16 * 1024;

type CredentialSource = {
    nodeEnv?: string;
    environmentValue?: string;
    productionSecretPath?: string;
    requiredUid?: number;
    requiredGid?: number;
};

export function loadDashboardInternalApiKey(source: CredentialSource = {}): string | null {
    const nodeEnv = source.nodeEnv ?? process.env.NODE_ENV;
    if (nodeEnv !== 'production') {
        return (source.environmentValue ?? process.env.DASHBOARD_INTERNAL_API_KEY)?.trim() || null;
    }

    const secretPath = source.productionSecretPath ?? PRODUCTION_SECRET_PATH;
    const requiredUid = source.requiredUid ?? 0;
    const requiredGid = source.requiredGid ?? 0;
    let descriptor: number | null = null;

    try {
        descriptor = openSync(secretPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = fstatSync(descriptor);
        if (
            !stat.isFile() ||
            stat.uid !== requiredUid ||
            stat.gid !== requiredGid ||
            stat.nlink !== 1 ||
            (stat.mode & 0o777) !== 0o400 ||
            stat.size < 32 ||
            stat.size > MAX_SECRET_BYTES
        ) {
            return null;
        }

        const value = readFileSync(descriptor);
        if (value.some((byte) => byte <= 0x20 || byte === 0x7f)) {
            value.fill(0);
            return null;
        }
        const secret = value.toString('utf-8');
        value.fill(0);
        return secret;
    } catch {
        return null;
    } finally {
        if (descriptor !== null) {
            closeSync(descriptor);
        }
    }
}

let cachedProductionKey: string | null | undefined;

export function getDashboardInternalApiKey(): string | null {
    if (process.env.NODE_ENV !== 'production') {
        return loadDashboardInternalApiKey();
    }
    if (cachedProductionKey === undefined) {
        cachedProductionKey = loadDashboardInternalApiKey();
    }
    return cachedProductionKey;
}
