'use strict';

// AsyncContextFrame detection. Unlike test.js this file does not bail when ACF
// is off in the test process: the cases that matter most are the ones where a
// child process has it off, or has it on by a route execArgv doesn't show.

const test = require('node:test');
const assert = require('node:assert/strict');

if (process.platform !== 'linux') {
    console.log(`Skipping native tests on ${process.platform}; the addon is Linux-only.`);
    return;
}

const { AsyncLocalStorage } = require('node:async_hooks');
const { fork } = require('node:child_process');
const path = require('node:path');

const { _isAsyncContextFrameActive } = require('..');
const addon = require('bindings')('customlabels');

const CHILD = path.join(__dirname, 'async-context-frame-child.js');

const [major, minor] = process.versions.node.split('.').map(Number);
// ACF landed in 22.7.0, so the opt-in routes are gated on that, not on major 22.
const hasAcfSupport = major > 22 || (major === 22 && minor >= 7);

// Runs the probe in a child process configured the way the test wants, since
// AsyncContextFrame is decided at process start and can't be toggled
// in-process. NODE_OPTIONS is cleared unless the test sets it, so the
// developer's own environment can't answer for the child.
function probeChild({ execArgv = [], nodeOptions = '' } = {}) {
    return new Promise((resolve, reject) => {
        const child = fork(CHILD, [], {
            execArgv,
            env: { ...process.env, NODE_OPTIONS: nodeOptions },
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
        let report;
        let stderr = '';
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('message', message => { report = message; });
        child.on('error', reject);
        child.on('exit', code => {
            if (report === undefined) {
                reject(new Error(`child exited with ${code} and no report; stderr: ${stderr}`));
                return;
            }
            resolve(report);
        });
    });
}

test('isAsyncContextFrameActive', async (t) => {
    await t.test('gives the same answer on every call', () => {
        const first = _isAsyncContextFrameActive();
        assert.equal(typeof first, 'boolean');
        assert.equal(_isAsyncContextFrameActive(), first);
    });

    await t.test('reports it active when Node enables it by default', { skip: major < 24 }, async () => {
        const { active } = await probeChild();
        assert.equal(active, true);
    });

    await t.test('reports it inactive when Node has no support for it', { skip: hasAcfSupport }, async () => {
        const { active } = await probeChild();
        assert.equal(active, false);
    });

    // The flag only exists from Node 24, where ACF is the default.
    await t.test('reports it inactive when the command line turns it off', { skip: major < 24 }, async () => {
        const { active } = await probeChild({ execArgv: ['--no-async-context-frame'] });
        assert.equal(active, false);
    });

    await t.test('reports it inactive when NODE_OPTIONS turns it off', { skip: major < 24 }, async () => {
        // The regression this detection exists for: Node 24 accepts the flag
        // in NODE_OPTIONS, where it does not reach execArgv, so inferring from
        // execArgv concludes ACF is on. It is off, the CPED slot is never
        // written, and a writer that trusted the inference would emit records
        // nothing updates.
        const { active, execArgv } = await probeChild({ nodeOptions: '--no-async-context-frame' });
        assert.deepEqual(execArgv, []);
        assert.equal(active, false);
    });

    await t.test('reports it active when NODE_OPTIONS turns it on', { skip: !hasAcfSupport || major >= 24 }, async () => {
        // The mirror image, on the other Node line: 22.7.0 through 23 accept
        // the flag in NODE_OPTIONS (24 rejects it outright), again without it
        // reaching execArgv, so inferring from execArgv concludes ACF is off
        // when it is on — and the writer refuses to run in a process that
        // would have worked.
        const { active, execArgv } = await probeChild({ nodeOptions: '--experimental-async-context-frame' });
        assert.deepEqual(execArgv, []);
        assert.equal(active, true);
    });
});

// The detection asks whether the running storage is bound to its own store,
// not merely whether the CPED slot holds a Map. These pin that difference:
// without them, weakening the helper to a bare IsMap check would still pass
// every test above.
test('cpedMapContains', { skip: !_isAsyncContextFrameActive() && 'AsyncContextFrame is off in this process' }, async (t) => {
    await t.test('finds the running storage bound to its store', () => {
        const als = new AsyncLocalStorage();
        const store = {};
        let found = false;
        als.run(store, () => { found = addon.cpedMapContains(als, store); });
        als.disable();
        assert.equal(found, true);
    });

    await t.test('does not match a foreign key', () => {
        // CPED is a general embedder slot. Another native addon storing a Map
        // there must not be able to answer for us, which is the false positive
        // an IsMap check would admit.
        const als = new AsyncLocalStorage();
        const store = {};
        let found = true;
        als.run(store, () => { found = addon.cpedMapContains(new AsyncLocalStorage(), store); });
        als.disable();
        assert.equal(found, false);
    });

    await t.test('does not match a different value for the right key', () => {
        const als = new AsyncLocalStorage();
        let found = true;
        als.run({}, () => { found = addon.cpedMapContains(als, {}); });
        als.disable();
        assert.equal(found, false);
    });

    await t.test('is false outside any run', () => {
        const als = new AsyncLocalStorage();
        const store = {};
        als.run(store, () => {});
        als.disable();
        assert.equal(addon.cpedMapContains(als, store), false);
    });

    await t.test('is false when called without a key and value', () => {
        // An absent key reads as undefined; so would a missing expected value,
        // so a malformed call must not compare the two and report success.
        const als = new AsyncLocalStorage();
        let found = true;
        als.run({}, () => { found = addon.cpedMapContains(); });
        als.disable();
        assert.equal(found, false);
    });
});
