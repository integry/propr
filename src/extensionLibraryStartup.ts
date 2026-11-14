import { logger } from '@propr/core';
/** Copy extension profiles into the extension library once; never blocks startup. */
export async function migrateExtensionLibrary(): Promise<void> {
    try {
        const core = await import('@propr/core');
        if (typeof core.migrateExtensionProfilesToLibrary === 'function') await core.migrateExtensionProfilesToLibrary(core.db);
    } catch (error) {
        logger.warn({ error: (error as Error).message }, 'Extension library migration skipped; it will retry at the next start');
    }
}

