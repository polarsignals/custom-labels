'use strict';

// Spawned by the "contexts collected during isolate teardown" test. Runs in
// its own process because the failure mode is a SIGABRT, which would take the
// whole test run down with it.
//
// When CtxWrap derived from node::ObjectWrap, a CtxWrap collected during
// isolate teardown ran ~ObjectWrap -> RemoveEnvironmentCleanupHook, which
// CHECKs that an Environment is current. It is not, during teardown, so:
//
//     Assertion failed: (env) != nullptr
//      3: otel_thread_ctx_nodejs::CtxWrap::~CtxWrap()
//
// It needs enough instances (~1000) that V8 still has some left to collect
// at teardown.

const { ThreadContext } = require('..');

const N = Number(process.argv[2] || 3000);

function id(n, len) {
    const b = Buffer.alloc(len);
    b.writeUInt32BE(n >>> 0, 0);
    return b;
}

const retained = [];

for (let i = 0; i < N; i++) {
    const ctx = new ThreadContext(id(i, 16), id(i, 8), ['k', String(i)]);
    if (i % 4 === 0) {
        // Still strongly reachable at exit.
        retained.push(ctx);
    } else {
        // Reachable only through the async context frame, so collectable
        // whenever V8 decides — including during teardown.
        ctx.enter();
    }
}

if (retained.length > 0) {
    retained[0].enter();
}
globalThis.__retained = retained;

// Exit through the normal path so the Environment is torn down and the
// isolate disposed; that is where the weak callbacks in question fire.
console.log(`created ${N}, retained ${retained.length}`);
