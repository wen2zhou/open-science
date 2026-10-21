import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const tests = JSON.parse(readFileSync(new URL('./lifecycle-tests.json', import.meta.url)));
const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', ...tests, '--maxWorkers=2', '--reporter=default', '--reporter=json', '--outputFile=acceptance-results/unit.json'], {stdio:'inherit'});
process.exit(result.status ?? 1);
