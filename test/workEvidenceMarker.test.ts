import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildWorkEvidenceMarker } from '../src/shared/workEvidenceMarker.js';

describe('work evidence marker', () => {
    it('builds stable, deduplicated evidence independent of visible comment copy', () => {
        assert.equal(
            buildWorkEvidenceMarker('started', [4992520130, 4992520130, 4992520131]),
            '<!-- propr:work-evidence phase=started trigger-comment-ids=4992520130,4992520131 -->',
        );
    });

    it('drops synthetic and invalid comment IDs', () => {
        assert.equal(buildWorkEvidenceMarker('completed', [0, -1, Number.NaN]), '');
    });
});
