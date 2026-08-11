'use strict';

// Node flags needed to make AsyncContextFrame — the writer's discovery
// substrate — available on the running Node.
//
// Node 22/23 need the --experimental-async-context-frame opt-in. Node 24
// turned ACF on by default and *removed* the flag, so passing it there is a
// hard `node: bad option` failure rather than a no-op. Anything that spawns a
// Node process for these tests has to compute the list rather than hardcode
// it; that includes `npm test` itself (see run.js).
function acfFlags() {
    const major = Number(process.versions.node.split('.')[0]);
    return major >= 22 && major < 24 ? ['--experimental-async-context-frame'] : [];
}

module.exports = { acfFlags };
