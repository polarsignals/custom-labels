'use strict';

// `npm test` entry point.
//
// The script used to pass --experimental-async-context-frame unconditionally,
// which works on Node 22/23 and fails outright from Node 24 on, where the flag
// was removed:
//
//     node: bad option: --experimental-async-context-frame
//
// so `npm test` was broken on every current Node. Compute the flags instead.

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const { acfFlags } = require('./node-flags');

const major = Number(process.versions.node.split('.')[0]);
const flags = [...acfFlags()];
// --disable-warning landed in Node 21.3; on older Node it would itself be a
// bad option. Nothing below 22 can run these tests anyway (test.js bails).
if (major >= 22) {
    flags.push('--disable-warning=ExperimentalWarning');
}

const res = spawnSync(
    process.execPath,
    [...flags, '--test', path.join(__dirname, 'test.js')],
    { stdio: 'inherit' },
);

if (res.error) {
    console.error(res.error);
    process.exit(1);
}
process.exit(res.status === null ? 1 : res.status);
