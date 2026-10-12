import 'dotenv/config';
import { managedDiagnostics, nativeDiagnosticStatus } from '../packages/core/src/diagnostics/managedLogRuntime.js';

// Private Fleet pipe only. Do not attach output to tasks, public artifacts or GitHub.
try {
    const spool = managedDiagnostics();
    if (!spool) throw new Error('disabled');
    const [command, id, sha256, confirmation] = process.argv.slice(2);
    if (command === 'status') process.stdout.write(JSON.stringify(nativeDiagnosticStatus()) + '\n');
    else if (command === 'export') {
        const item = spool.exportOne();
        process.stdout.write(JSON.stringify(item ? { manifest: item.manifest, gzipBase64: item.data.toString('base64') } : null) + '\n');
    } else if (command === 'reset-native-capacity' && /^[a-f0-9]{64}$/.test(id ?? '') && sha256 === '--operator-storage-remediation-verified' && confirmation === undefined) {
        spool.resetNativeCapacity(id);
        process.stdout.write('{"nativeCapacityReset":true,"offsiteAcknowledged":false}\n');
    } else if (command === 'ack' && /^\d+$/.test(id ?? '') && /^[a-f0-9]{64}$/.test(sha256 ?? '') && confirmation === '--encrypted-upload-readback-verified') {
        spool.acknowledge(Number(id), sha256);
        process.stdout.write('{"acknowledged":true}\n');
    } else if (command === 'discard-local' && /^\d+$/.test(id ?? '') && /^[a-f0-9]{64}$/.test(sha256 ?? '') && confirmation === '--accept-local-diagnostic-loss') {
        spool.discardLocal(Number(id), sha256);
        process.stdout.write('{"discardedLocally":true,"offsiteAcknowledged":false}\n');
    } else if (command === 'dispose-local' && /^\d+$/.test(id ?? '') && /^[a-f0-9]{64}$/.test(sha256 ?? '') && confirmation === '--local-only-loss-accepted') {
        spool.disposeLocal(Number(id), sha256);
        process.stdout.write('{"disposedLocally":true,"offsiteAcknowledged":false}\n');
    } else throw new Error('invalid command');
    spool.close();
} catch {
    process.stderr.write('managed diagnostics command refused; check activation, private root, instance, or command arguments\n');
    process.exitCode = 1;
}
