/**
 * Pure PR diff formatting for review prompts. Kept free of runtime
 * dependencies so prompt budgeting can be exercised without @propr/core.
 */

export interface PRFile {
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
}

export interface FormattedPRDiff {
    diff: string;
    omittedFiles: string[];
}

/**
 * Formats PR files into a diff string for inclusion in review prompts.
 * Prioritizes concise, reviewable text diffs so the prompt budget is used on
 * changes the reviewer can act on before large/generated/binary artifacts.
 */
export function formatPRDiff(files: PRFile[], maxChars: number = 100000): string {
    return formatPRDiffWithMetadata(files, maxChars).diff;
}

export function formatPRDiffWithMetadata(files: PRFile[], maxChars: number = 100000): FormattedPRDiff {
    if (files.length === 0) return { diff: '', omittedFiles: [] };

    const prepared = preparePRDiff(files, Number.POSITIVE_INFINITY);
    const included = new Set<string>();
    let currentSize = 0;
    for (const file of prepared.files) {
        if (currentSize + file.section.length > maxChars) continue;
        included.add(file.filename);
        currentSize += file.section.length;
    }
    const assembled = assemblePRDiff(prepared, included);
    return { diff: assembled.diff, omittedFiles: assembled.omittedFiles };
}

export interface PreparedPRDiffFile {
    filename: string;
    section: string;
}

/**
 * Untrimmed review diff shared by every reviewer of one job. Files appear in
 * review priority order; per-reviewer budgeting later selects which of them
 * fit. Only the bounded I/O guard and GitHub itself can drop files here.
 */
export interface PreparedPRDiff {
    summary: string;
    files: PreparedPRDiffFile[];
    /** Text changes GitHub returned without patch content. */
    missingPatchFiles: string[];
    /** Files dropped by the in-memory diff size guard, not by token capacity. */
    ioGuardOmittedFiles: string[];
}

export interface AssembledPRDiff {
    diff: string;
    includedFiles: string[];
    /** Files that had patch content but did not fit the reviewer's budget. */
    budgetOmittedFiles: string[];
    missingPatchFiles: string[];
    ioGuardOmittedFiles: string[];
    /** Every file absent from the diff, for partial-review marking. */
    omittedFiles: string[];
}

export function preparePRDiff(files: PRFile[], ioGuardMaxChars: number): PreparedPRDiff {
    const totalAdditions = files.reduce((s, f) => s + f.additions, 0);
    const totalDeletions = files.reduce((s, f) => s + f.deletions, 0);
    const prepared: PreparedPRDiff = {
        summary: files.length > 0 ? `**${files.length} files changed** (+${totalAdditions}/-${totalDeletions})` : '',
        files: [],
        missingPatchFiles: [],
        ioGuardOmittedFiles: [],
    };
    let currentSize = 0;

    for (const file of [...files].sort(comparePRFilesForReview)) {
        // GitHub omits `patch` for text diffs that exceed its per-file limit.
        // A placeholder is not review coverage: fail closed by reporting the
        // file as omitted so downstream review/Ultrafix logic stays partial.
        if (!file.patch && !isBinaryFile(file.filename) && changedLineCount(file) > 0) {
            prepared.missingPatchFiles.push(file.filename);
            continue;
        }

        const section = formatPRFileDiffSection(file);
        if (currentSize + section.length > ioGuardMaxChars) {
            prepared.ioGuardOmittedFiles.push(file.filename);
            continue;
        }
        prepared.files.push({ filename: file.filename, section });
        currentSize += section.length;
    }

    return prepared;
}

/** Build the diff text for the files a reviewer's budget selected. */
export function assemblePRDiff(prepared: PreparedPRDiff, includedFilenames: ReadonlySet<string>): AssembledPRDiff {
    const included = prepared.files.filter(file => includedFilenames.has(file.filename));
    const budgetOmittedFiles = prepared.files.filter(file => !includedFilenames.has(file.filename)).map(file => file.filename);
    const omittedFiles = [...prepared.missingPatchFiles, ...prepared.ioGuardOmittedFiles, ...budgetOmittedFiles];
    const note = buildOmittedFilesNote({
        missingPatchFiles: prepared.missingPatchFiles,
        ioGuardOmittedFiles: prepared.ioGuardOmittedFiles,
        budgetOmittedFiles,
    });
    return {
        diff: prepared.summary ? `${prepared.summary}\n\n${included.map(file => file.section).join('\n')}${note}` : '',
        includedFiles: included.map(file => file.filename),
        budgetOmittedFiles,
        missingPatchFiles: [...prepared.missingPatchFiles],
        ioGuardOmittedFiles: [...prepared.ioGuardOmittedFiles],
        omittedFiles,
    };
}

const MAX_LISTED_OMITTED_FILES = 50;

function listOmittedFiles(heading: string, filenames: string[]): string[] {
    if (filenames.length === 0) return [];
    const listed = filenames.slice(0, MAX_LISTED_OMITTED_FILES).map(filename => `  - ${filename}`);
    const remaining = filenames.length - MAX_LISTED_OMITTED_FILES;
    return [`- ${heading} (${filenames.length}):`, ...listed, ...(remaining > 0 ? [`  - ...and ${remaining} more`] : [])];
}

function buildOmittedFilesNote(groups: { missingPatchFiles: string[]; ioGuardOmittedFiles: string[]; budgetOmittedFiles: string[] }): string {
    const total = groups.missingPatchFiles.length + groups.ioGuardOmittedFiles.length + groups.budgetOmittedFiles.length;
    if (total === 0) return '';

    return [
        '',
        '',
        `*Note: Review diff is partial. ${total} ${total === 1 ? 'file was' : 'files were'} omitted from this diff. Large, binary, generated, and lockfile changes are deprioritized so smaller source changes fit first.*`,
        '',
        '**Files omitted from review diff:**',
        ...listOmittedFiles('GitHub supplied no patch content; a larger review budget cannot recover these', groups.missingPatchFiles),
        ...listOmittedFiles('Did not fit the review context budget', groups.budgetOmittedFiles),
        ...listOmittedFiles('Exceeded the diff size safety guard', groups.ioGuardOmittedFiles),
    ].join('\n');
}

function formatPRFileDiffSection(file: PRFile): string {
    const header = `## ${file.filename} (${file.status}, +${file.additions}/-${file.deletions})`;
    const patch = file.patch || '(binary or too large to display)';
    return `${header}\n\`\`\`diff\n${patch}\n\`\`\`\n`;
}

function comparePRFilesForReview(a: PRFile, b: PRFile): number {
    return reviewPriority(a) - reviewPriority(b)
        || patchSize(a) - patchSize(b)
        || changedLineCount(a) - changedLineCount(b)
        || a.filename.localeCompare(b.filename);
}

function reviewPriority(file: PRFile): number {
    if (!file.patch || isBinaryFile(file.filename)) return 50;
    if (isLockfile(file.filename)) return 40;
    if (isGeneratedOrVendorFile(file.filename)) return 35;
    if (isDocumentationFile(file.filename)) return 20;
    return 0;
}

function patchSize(file: PRFile): number {
    return formatPRFileDiffSection(file).length;
}

function changedLineCount(file: PRFile): number {
    return file.additions + file.deletions;
}

function isLockfile(filename: string): boolean {
    const basename = filename.split('/').pop()?.toLowerCase() || filename.toLowerCase();
    return basename === 'package-lock.json'
        || basename === 'npm-shrinkwrap.json'
        || basename === 'yarn.lock'
        || basename === 'pnpm-lock.yaml'
        || basename === 'bun.lock'
        || basename === 'bun.lockb'
        || basename === 'composer.lock'
        || basename === 'poetry.lock'
        || basename === 'cargo.lock'
        || basename === 'gemfile.lock';
}

function isBinaryFile(filename: string): boolean {
    return /\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|pdf|zip|tar|gz|tgz|bz2|xz|7z|rar|woff2?|ttf|eot|otf|mp4|mov|avi|webm|mp3|wav|flac|exe|dll|so|dylib|class|jar)$/i.test(filename);
}

function isGeneratedOrVendorFile(filename: string): boolean {
    return /(^|\/)(dist|build|coverage|vendor|third_party|node_modules)\//.test(filename)
        || /\.min\.(js|css)$/i.test(filename)
        || /\.(generated|gen)\.[cm]?[jt]sx?$/i.test(filename)
        || /\.snap$/i.test(filename);
}

function isDocumentationFile(filename: string): boolean {
    return /\.(md|mdx|rst|txt|adoc)$/i.test(filename)
        || /(^|\/)docs\//i.test(filename);
}
