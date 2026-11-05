// Docker lifecycle simulator. Redis is real; immutable IDs and create/start/
// remove races are exercised without a provider, Docker daemon or credentials.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
const root = process.env.PROPR_TEST_ADMISSION_DOCKER;
if (process.env.PROPR_TEST_EXPECT_HOST && process.env.DOCKER_HOST !== process.env.PROPR_TEST_EXPECT_HOST) throw new Error('Wrong Docker host');
if (process.env.PROPR_TEST_EXPECT_CONTEXT && process.env.DOCKER_CONTEXT !== process.env.PROPR_TEST_EXPECT_CONTEXT) throw new Error('Wrong Docker context');
const [command, ...args] = process.argv.slice(2);
fs.appendFileSync(path.join(root, 'commands'), command + '\n');
const file = id => path.join(root, id + '.json');
const records = () => fs.readdirSync(root).filter(name => name.endsWith('.json')).flatMap(name => {
    try { return [JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'))]; }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
});
const writeRecord = record => {
    const temporary = file(record.id) + `.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(record));
    fs.renameSync(temporary, file(record.id));
};
if (command === 'info') console.log('test-daemon');
else if (command === 'create') {
    if (args.includes('fixture-fail-create')) { console.error(args.join(' ')); process.exit(1); }
    const id = randomBytes(32).toString('hex');
    writeRecord({ id, args, state: 'created' });
    // Hold the create response after the daemon has created the immutable ID.
    if (args.includes('fixture-slow-create')) {
        while (!fs.existsSync(path.join(root, 'release-create'))) await new Promise(resolve => setTimeout(resolve, 10));
    }
    console.log(id);
} else if (command === 'start') {
    const id = args.at(-1);
    if (!fs.existsSync(file(id))) process.exit(1);
    const r = JSON.parse(fs.readFileSync(file(id), 'utf8'));
    if (r.args.includes('fixture-slow-create')) console.log('fixture partial output');
    r.state = 'running';
    writeRecord(r);
    fs.appendFileSync(path.join(root, 'starts'), id + '\n');
    const timer = setInterval(() => {
        if (!fs.existsSync(file(id))) { clearInterval(timer); process.exit(0); }
        const state = JSON.parse(fs.readFileSync(file(id), 'utf8'));
        if (state.stop) { fs.unlinkSync(file(id)); clearInterval(timer); process.exit(0); }
    }, 10);
} else if (command === 'rm') {
    fs.rmSync(file(args.at(-1)), { force: true });
} else if (command === 'ps') {
    const filter = args[args.indexOf('--filter') + 1];
    for (const r of records()) if (filter === `id=${r.id}` || (filter?.startsWith('label=') && r.args.includes(filter.slice(6)))) console.log(r.id);
} else {
    console.error(`Unsupported fixture command: ${command}`);
    process.exit(1);
}
