/**
 * Names of dependencies a diff adds to a dependency manifest. Reads only the
 * diff's added, removed and context lines: a name counts as new when an added
 * line declares it inside a dependency block and no removed line declared it
 * (a version bump or a moved entry is not a new dependency). Hunks that start
 * inside a block are read conservatively, so the list can miss entries but
 * rarely names something that is not a dependency.
 */

type DiffLine = { kind: '+' | '-' | ' '; text: string };

function diffLines(diff: string): DiffLine[][] {
    const hunks: DiffLine[][] = [];
    let current: DiffLine[] | undefined;
    for (const line of diff.split('\n')) {
        if (line.startsWith('@@')) {
            current = [];
            hunks.push(current);
            continue;
        }
        if (!current || line.startsWith('\\')) continue;
        const kind = line[0];
        if (kind === '+' || kind === '-' || kind === ' ') current.push({ kind, text: line.slice(1) });
        else if (line === '') current.push({ kind: ' ', text: '' });
    }
    return hunks;
}

/** One manifest format: names declared by added and removed lines of one hunk. */
type HunkReader = (hunk: DiffLine[]) => { added: string[]; removed: string[] };

/** Reads hunks with a per-hunk state machine; `declared` sees new-file lines (context and added) and removed lines. */
function reader<State>(initial: () => State, step: (state: State, line: DiffLine) => string[]): HunkReader {
    return hunk => {
        // Removed lines describe the old file, so they advance their own state.
        const newState = initial();
        const oldState = initial();
        const added: string[] = [];
        const removed: string[] = [];
        for (const line of hunk) {
            if (line.kind !== '-') {
                const names = step(newState, line);
                if (line.kind === '+') added.push(...names);
            }
            if (line.kind !== '+') {
                const names = step(oldState, line);
                if (line.kind === '-') removed.push(...names);
            }
        }
        return { added, removed };
    };
}

const JSON_DEPENDENCY_BLOCKS = new Set(['dependencies', 'devdependencies', 'peerdependencies', 'optionaldependencies', 'require', 'require-dev', 'imports']);
/** Top-level keys whose string values look like versions but are not dependencies. */
const JSON_NON_DEPENDENCY_KEYS = new Set(['name', 'version', 'description', 'main', 'module', 'types', 'typings', 'license', 'type', 'packagemanager', 'node', 'npm', 'yarn', 'pnpm', 'bun', 'php', 'homepage']);
const VERSION_LIKE = /^(?:[~^<>=v]*\s*\d|\*$|latest$|next$|workspace:|npm:|file:|link:|git\+|github:|https?:\/\/)/i;

/** package.json, composer.json and deno.json: entries of the dependency objects. */
const jsonManifest = reader<{ stack: string[]; known: boolean }>(() => ({ stack: [], known: false }), (state, { text }) => {
    const open = /^\s*"([^"]+)"\s*:\s*\{\s*$/.exec(text);
    if (open) {
        state.stack.push(open[1].toLowerCase());
        state.known = true;
        return [];
    }
    if (/^\s*\}\s*,?\s*$/.test(text)) {
        if (state.stack.length) state.stack.pop();
        // Closing a block the hunk did not open: the enclosing block is unknown.
        else state.known = false;
        return [];
    }
    const entry = /^\s*"([^"\s]+)"\s*:\s*"([^"]*)"\s*,?\s*$/.exec(text);
    if (!entry) return [];
    const block = state.stack[state.stack.length - 1];
    if (block !== undefined) return JSON_DEPENDENCY_BLOCKS.has(block) ? [entry[1]] : [];
    // The hunk started inside an unknown block: accept only version-like values.
    if (state.known) return [];
    return VERSION_LIKE.test(entry[2].trim()) && !JSON_NON_DEPENDENCY_KEYS.has(entry[1].toLowerCase()) ? [entry[1]] : [];
});

/** requirements.txt and pip-compile inputs: one requirement per line. */
const requirementsManifest = reader<null>(() => null, (_state, { text }) => {
    const match = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(?:[<>=!~;@ ]|$)/.exec(text);
    return match && !text.trim().startsWith('#') ? [match[1]] : [];
});

const TOML_DEPENDENCY_TABLE = /(?:^|\.)(?:dependencies|dev-dependencies|build-dependencies|packages|dev-packages)$/;
const TOML_REQUIREMENT_LIST_TABLE = /^(?:project\.optional-dependencies|dependency-groups)$/;
const QUOTED_REQUIREMENT = /"([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(?:[<>=!~;@ ][^"]*)?"/g;

/** pyproject.toml, Cargo.toml and Pipfile: keys of dependency tables and PEP 508 requirement lists. */
const tomlManifest = reader<{ table?: string; inList: boolean }>(() => ({ inList: false }), (state, { text }) => {
    const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*$/.exec(text);
    if (header) {
        state.table = header[1].replace(/\s+/g, '').replace(/"/g, '').toLowerCase();
        state.inList = false;
        // `[dependencies.serde]` declares serde.
        const dotted = /(?:^|\.)(?:dependencies|dev-dependencies|build-dependencies)\.([^.]+)$/.exec(state.table);
        return dotted ? [dotted[1]] : [];
    }
    if (state.table === undefined) return [];
    const listStart = /^\s*([A-Za-z0-9_.-]+|"[^"]+")\s*=\s*\[(.*)$/.exec(text);
    const startsRequirementList = listStart && ((state.table === 'project' && /^"?(?:dependencies)"?$/.test(listStart[1])) || TOML_REQUIREMENT_LIST_TABLE.test(state.table));
    if (startsRequirementList) {
        state.inList = !listStart[2].includes(']');
        return [...listStart[2].matchAll(QUOTED_REQUIREMENT)].map(match => match[1]);
    }
    if (state.inList) {
        if (text.includes(']')) state.inList = false;
        return [...text.split(']')[0].matchAll(QUOTED_REQUIREMENT)].map(match => match[1]);
    }
    if (!TOML_DEPENDENCY_TABLE.test(state.table)) return [];
    const key = /^\s*("[^"]+"|[A-Za-z0-9_.-]+)\s*=/.exec(text);
    const name = key?.[1].replace(/"/g, '');
    return name && name.toLowerCase() !== 'python' ? [name] : [];
});

/** go.mod: modules in `require` directives. */
const goModManifest = reader<{ block?: string }>(() => ({}), (state, { text }) => {
    const open = /^\s*(require|replace|exclude|retract)\s*\(\s*$/.exec(text);
    if (open) { state.block = open[1]; return []; }
    if (/^\s*\)\s*$/.test(text)) { state.block = undefined; return []; }
    const single = /^\s*require\s+(\S+)\s+v\d/.exec(text);
    if (single) return [single[1]];
    if (state.block !== undefined && state.block !== 'require') return [];
    const entry = /^\s*([A-Za-z0-9.-]+\.[A-Za-z]{2,}\/\S+)\s+v\d\S*(?:\s*\/\/.*)?$/.exec(text);
    return entry && !text.includes('=>') ? [entry[1]] : [];
});

/** Gemfile and gemspecs. */
const rubyManifest = reader<null>(() => null, (_state, { text }) => {
    const match = /^\s*(?:gem|(?:\w+\.)?add_(?:runtime_|development_)?dependency)\s*\(?\s*['"]([^'"]+)['"]/.exec(text);
    return match ? [match[1]] : [];
});

/** Gradle build scripts: `group:artifact` coordinates in dependency configurations. */
const gradleManifest = reader<null>(() => null, (_state, { text }) => {
    const match = /^\s*(?:implementation|api|compileOnly|runtimeOnly|annotationProcessor|kapt|ksp|testImplementation|testRuntimeOnly|androidTestImplementation|classpath)\s*\(?\s*['"]([^'":\s]+:[^'":\s]+)/.exec(text);
    return match ? [match[1]] : [];
});

/** pom.xml: `<dependency>` elements, named `groupId:artifactId`. */
const mavenManifest = reader<{ inDependency: boolean; groupId?: string }>(() => ({ inDependency: false }), (state, { text }) => {
    if (/<dependency>/.test(text)) { state.inDependency = true; state.groupId = undefined; }
    const group = /<groupId>\s*([^<\s]+)\s*<\/groupId>/.exec(text);
    if (state.inDependency && group) state.groupId = group[1];
    const artifact = /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/.exec(text);
    if (/<\/dependency>/.test(text)) state.inDependency = false;
    return state.inDependency && artifact ? [state.groupId ? `${state.groupId}:${artifact[1]}` : artifact[1]] : [];
});

/** .NET project files and central package management. */
const dotnetManifest = reader<null>(() => null, (_state, { text }) => {
    const match = /<Package(?:Reference|Version)\s+(?:Include|Update)="([^"]+)"/i.exec(text);
    return match ? [match[1]] : [];
});

/** pubspec.yaml: keys directly under the dependency maps. */
const pubspecManifest = reader<{ section?: string }>(() => ({}), (state, { text }) => {
    const section = /^([A-Za-z_]+):\s*$/.exec(text);
    if (section) { state.section = section[1]; return []; }
    if (/^\S/.test(text)) { state.section = undefined; return []; }
    const entry = /^ {2}([a-z0-9_]+):/.exec(text);
    return entry && state.section && /^(?:dev_)?dependencies$/.test(state.section) ? [entry[1]] : [];
});

function readerFor(path: string): HunkReader | undefined {
    const name = (path.split('/').pop() || path).toLowerCase();
    if (name === 'package.json' || name === 'composer.json' || name === 'deno.json' || name === 'deno.jsonc') return jsonManifest;
    if (/^requirements(?:[-_.][\w.-]*)?\.(?:txt|in)$/.test(name)) return requirementsManifest;
    if (name === 'pyproject.toml' || name === 'cargo.toml' || name === 'pipfile') return tomlManifest;
    if (name === 'go.mod') return goModManifest;
    if (name === 'gemfile' || name.endsWith('.gemspec')) return rubyManifest;
    if (name === 'build.gradle' || name === 'build.gradle.kts') return gradleManifest;
    if (name === 'pom.xml') return mavenManifest;
    if (/\.(?:csproj|fsproj|vbproj)$/.test(name) || name === 'directory.packages.props') return dotnetManifest;
    if (name === 'pubspec.yaml') return pubspecManifest;
    return undefined;
}

/** Dependencies a manifest's diff adds, in order of appearance; empty for other files. */
export function findAddedDependencies(change: { path: string; diff?: string; status?: string }): string[] {
    const read = readerFor(change.path);
    if (!read || !change.diff || change.status === 'deleted') return [];
    const added: string[] = [];
    const removed = new Set<string>();
    for (const hunk of diffLines(change.diff)) {
        const names = read(hunk);
        added.push(...names.added);
        for (const name of names.removed) removed.add(name.toLowerCase());
    }
    const seen = new Set<string>();
    return added.filter(name => {
        const key = name.toLowerCase();
        if (removed.has(key) || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}
