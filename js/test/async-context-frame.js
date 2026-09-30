'use strict';

// AsyncContextFrame detection. Unlike test.js this file does not bail when ACF
// is off in the test process: each Node line gets one child with ACF on and
// one with it off, to check detection in both directions.

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
// ACF landed in 22.7.0
const hasAcfSupport = major > 22 || (major === 22 && minor >= 7);

// Runs the probe in a child process configured the way the test wants, since
// AsyncContextFrame is decided at process start and can't be toggled
// in-process. NODE_OPTIONS is cleared, so the local environment can't
// interfere.
function probeChild(execArgv = []) {
    return new Promise((resolve, reject) => {
        const child = fork(CHILD, [], {
            execArgv,
            env: { ...process.env, NODE_OPTIONS: '' },
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
            resolve(report.active);
        });
    });
}

test('isAsyncContextFrameActive', async (t) => {
    // Node 24 and later: on by default, and --no-async-context-frame turns it off.
    await t.test('reports it active when Node enables it by default', { skip: major < 24 }, async () => {
        assert.equal(await probeChild(), true);
    });

    await t.test('reports it inactive when the command line turns it off', { skip: major < 24 }, async () => {
        assert.equal(await probeChild(['--no-async-context-frame']), false);
    });

    // Node 22.7 through 23: off by default, and --experimental-async-context-frame turns it on.
    const optInNode = hasAcfSupport && major < 24;

    await t.test('reports it inactive when Node leaves it off by default', { skip: !optInNode }, async () => {
        assert.equal(await probeChild(), false);
    });

    await t.test('reports it active when the command line turns it on', { skip: !optInNode }, async () => {
        assert.equal(await probeChild(['--experimental-async-context-frame']), true);
    });

    // Before Node 22.7 there is no AsyncContextFrame to turn on.
    await t.test('reports it inactive when Node has no support for it', { skip: hasAcfSupport }, async () => {
        assert.equal(await probeChild(), false);
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
