const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const { test } = require('node:test');

const customLabels = require('..');

test('preserves Unicode labels and nested async context', async () => {
    const result = await customLabels.withLabels(async () => {
        assert.equal(customLabels.curLabels().toString(), '{customer: 東京🌍}');

        return customLabels.withLabels(async () => {
            await Promise.resolve();
            assert.equal(customLabels.curLabels().toString(), '{customer: 東京🌍, request: café🧪}');
            return customLabels.curLabels().toString();
        }, 'request', 'café🧪');
    }, 'customer', '東京🌍');

    assert.equal(result, '{customer: 東京🌍, request: café🧪}');
});

test('exits cleanly after labels are stored in the main environment', () => {
    const nodeMajor = Number(process.versions.node.split('.')[0]);
    const args = [];
    if (nodeMajor === 22 || nodeMajor === 23) {
        args.push('--experimental-async-context-frame');
    }
    args.push('-e', `const labels = require(${JSON.stringify(require.resolve('..'))}); labels.withLabels(() => {}, 'key', 'value');`);

    const child = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.signal, null);
});

test('exits cleanly after labels are stored in a worker environment', async () => {
    const nodeMajor = Number(process.versions.node.split('.')[0]);
    const execArgv = nodeMajor === 22 || nodeMajor === 23
        ? ['--experimental-async-context-frame']
        : [];
    const worker = new Worker(
        `const labels = require(${JSON.stringify(require.resolve('..'))}); labels.withLabels(() => {}, 'key', 'value');`,
        { eval: true, execArgv }
    );

    const exitCode = await new Promise((resolve, reject) => {
        worker.once('error', reject);
        worker.once('exit', resolve);
    });
    assert.equal(exitCode, 0);
});
