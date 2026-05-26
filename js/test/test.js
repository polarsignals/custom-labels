'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

if (process.platform !== 'linux') {
    console.log(`Skipping native tests on ${process.platform}; the addon is Linux-only.`);
    return;
}

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const lib = require('..');
const { runWithContext, enterWithContext, makeNamedContext, _currentRecordBytes } = lib;

const TRACE_ID_BYTES = bytesFromHex('0102030405060708090a0b0c0d0e0f10');
const SPAN_ID_BYTES  = bytesFromHex('1112131415161718');

// Returns a plain Uint8Array (not a Buffer) so assert.deepStrictEqual against
// other Uint8Arrays — including the one the addon returns — succeeds.
function bytesFromHex(hex) {
    return Uint8Array.from(Buffer.from(hex, 'hex'));
}

function decodeHeader(bytes) {
    assert.equal(bytes.length, 640, 'record must be exactly 640 bytes');
    return {
        traceId: bytes.slice(0, 16),
        spanId: bytes.slice(16, 24),
        valid: bytes[24],
        reserved: bytes[25],
        attrsDataSize: bytes[26] | (bytes[27] << 8),
    };
}

// Returns the attribute payload as a positional sparse array, mirroring the
// writer's input shape: index N is the value for uint8 key index N on the
// wire; unset slots are array holes.
function decodeAttrs(bytes) {
    const hdr = decodeHeader(bytes);
    const out = [];
    let i = 28;
    const end = i + hdr.attrsDataSize;
    while (i < end) {
        const idx = bytes[i++];
        const len = bytes[i++];
        out[idx] = Buffer.from(bytes.slice(i, i + len)).toString('utf8');
        i += len;
    }
    assert.equal(i, end, 'attrs payload must be exactly attrsDataSize bytes');
    return out;
}

function captureBytes(opts) {
    let bytes;
    runWithContext(() => { bytes = _currentRecordBytes(); }, opts);
    return bytes;
}

test('traceId/spanId accepted as Uint8Array', () => {
    const bytes = captureBytes({ traceId: TRACE_ID_BYTES, spanId: SPAN_ID_BYTES });
    const hdr = decodeHeader(bytes);
    assert.deepEqual(hdr.traceId, TRACE_ID_BYTES);
    assert.deepEqual(hdr.spanId, SPAN_ID_BYTES);
    assert.equal(hdr.valid, 1);
    assert.equal(hdr.reserved, 0);
    assert.equal(hdr.attrsDataSize, 0);
});

test('traceId/spanId accepted as Buffer (Uint8Array subclass)', () => {
    const bytes = captureBytes({
        traceId: Buffer.from(TRACE_ID_BYTES),
        spanId: Buffer.from(SPAN_ID_BYTES),
    });
    const hdr = decodeHeader(bytes);
    assert.deepEqual(hdr.traceId, TRACE_ID_BYTES);
    assert.deepEqual(hdr.spanId, SPAN_ID_BYTES);
});

test('traceId wrong length is rejected', () => {
    assert.throws(() => captureBytes({ traceId: new Uint8Array(8), spanId: SPAN_ID_BYTES }),
        /traceId must be/);
});

test('spanId wrong length is rejected', () => {
    assert.throws(() => captureBytes({ traceId: TRACE_ID_BYTES, spanId: new Uint8Array(4) }),
        /spanId must be/);
});

test('non-Uint8Array traceId is rejected', () => {
    assert.throws(() => captureBytes({ traceId: 'a'.repeat(32), spanId: SPAN_ID_BYTES }),
        /traceId must be/);
});

test('no attributes leaves attrs_data empty', () => {
    const bytes = captureBytes({ traceId: TRACE_ID_BYTES, spanId: SPAN_ID_BYTES });
    assert.equal(decodeHeader(bytes).attrsDataSize, 0);
});

test('attributes are encoded by position', () => {
    const bytes = captureBytes({
        traceId: TRACE_ID_BYTES,
        spanId:  SPAN_ID_BYTES,
        attributes: ['GET', '/api/v1/widgets'],
    });
    assert.deepEqual(decodeAttrs(bytes), ['GET', '/api/v1/widgets']);
});

test('null and undefined slots are skipped', () => {
    const bytes = captureBytes({
        traceId: TRACE_ID_BYTES,
        spanId:  SPAN_ID_BYTES,
        attributes: ['zero', null, undefined, 'three'],
    });
    assert.deepEqual(decodeAttrs(bytes), ['zero', , , 'three']);
});

test('trailing array holes are skipped', () => {
    // Sparse assignment: index 5 set, lower indexes are holes.
    const attributes = [];
    attributes[5] = 'five';
    const bytes = captureBytes({
        traceId: TRACE_ID_BYTES,
        spanId:  SPAN_ID_BYTES,
        attributes,
    });
    assert.deepEqual(decodeAttrs(bytes), [, , , , , 'five']);
});

test('attributes coerce non-string values via toString', () => {
    const bytes = captureBytes({
        traceId: TRACE_ID_BYTES,
        spanId:  SPAN_ID_BYTES,
        attributes: [42, true],
    });
    assert.deepEqual(decodeAttrs(bytes), ['42', 'true']);
});

test('value longer than 255 bytes is truncated to 255', () => {
    const long = 'x'.repeat(300);
    const bytes = captureBytes({
        traceId: TRACE_ID_BYTES,
        spanId:  SPAN_ID_BYTES,
        attributes: [long],
    });
    assert.deepEqual(decodeAttrs(bytes), ['x'.repeat(255)]);
});

test('truncation does not split a multibyte UTF-8 codepoint', () => {
    // '€' is 3 UTF-8 bytes; 'é' is 2. The writer must drop whole codepoints
    // at the 255-byte cap, never emit a partial sequence, and report the
    // bytes actually written as the length prefix.

    // 85 × € = 255 bytes (exact fit). 86 × € = 258 bytes; cap lands inside
    // the 86th codepoint, so it must be dropped entirely.
    const euro = '€';
    const bytes = captureBytes({
        traceId: TRACE_ID_BYTES,
        spanId:  SPAN_ID_BYTES,
        attributes: [euro.repeat(86)],
    });
    assert.deepEqual(decodeAttrs(bytes), [euro.repeat(85)]);
    assert.equal(decodeHeader(bytes).attrsDataSize, 2 + 255);

    // 84 × € + 2 × 'é' = 252 + 4 = 256 bytes; the cap at 255 lands inside
    // the second 'é', so only 84 × € + 1 × 'é' = 254 bytes get written.
    const bytes2 = captureBytes({
        traceId: TRACE_ID_BYTES,
        spanId:  SPAN_ID_BYTES,
        attributes: [euro.repeat(84) + 'éé'],
    });
    assert.deepEqual(decodeAttrs(bytes2), [euro.repeat(84) + 'é']);
    assert.equal(decodeHeader(bytes2).attrsDataSize, 2 + 254);
});

test('attrs that would exceed the 612-byte payload are dropped at the boundary', () => {
    // Two 255-byte values: 2 * (2 + 255) = 514 bytes used.
    // A third 100-byte value would need 102 more bytes => 616 > 612, dropped.
    const a = 'a'.repeat(255);
    const b = 'b'.repeat(255);
    const c = 'c'.repeat(100);
    const bytes = captureBytes({
        traceId: TRACE_ID_BYTES,
        spanId:  SPAN_ID_BYTES,
        attributes: [a, b, c],
    });
    assert.deepEqual(decodeAttrs(bytes), [a, b]);
    assert.equal(decodeHeader(bytes).attrsDataSize, 514);
});

test('attributes array longer than 256 is rejected', () => {
    const tooLong = new Array(257);
    assert.throws(() => captureBytes({
        traceId: TRACE_ID_BYTES,
        spanId:  SPAN_ID_BYTES,
        attributes: tooLong,
    }), /must not exceed 256/);
});

test('non-array attributes argument is rejected', () => {
    assert.throws(() => captureBytes({
        traceId: TRACE_ID_BYTES,
        spanId:  SPAN_ID_BYTES,
        attributes: { not: 'an array' },
    }), /attributes must be an array/);
});

test('runWithContext returns fn result', () => {
    const result = runWithContext(() => 'ok', { traceId: TRACE_ID_BYTES, spanId: SPAN_ID_BYTES });
    assert.equal(result, 'ok');
});

test('outside runWithContext, no active record', () => {
    assert.equal(_currentRecordBytes(), undefined);
});

test('after runWithContext returns, no active record', () => {
    runWithContext(() => {}, { traceId: TRACE_ID_BYTES, spanId: SPAN_ID_BYTES });
    assert.equal(_currentRecordBytes(), undefined);
});

test('nested runWithContext restores parent context after inner returns', () => {
    const outerOpts = { traceId: TRACE_ID_BYTES, spanId: SPAN_ID_BYTES };
    const innerSpanBytes = bytesFromHex('aabbccddeeff0011');
    const innerOpts = { traceId: TRACE_ID_BYTES, spanId: innerSpanBytes };

    runWithContext(() => {
        const outerBefore = decodeHeader(_currentRecordBytes()).spanId;
        runWithContext(() => {
            const inner = decodeHeader(_currentRecordBytes()).spanId;
            assert.deepEqual(inner, innerSpanBytes);
        }, innerOpts);
        const outerAfter = decodeHeader(_currentRecordBytes()).spanId;
        assert.deepEqual(outerBefore, outerAfter);
        assert.deepEqual(outerAfter, SPAN_ID_BYTES);
    }, outerOpts);
});

test('async work inside runWithContext sees same record after awaits', async () => {
    await runWithContext(async () => {
        const before = decodeHeader(_currentRecordBytes()).spanId;
        await Promise.resolve();
        const afterMicro = decodeHeader(_currentRecordBytes()).spanId;
        await new Promise(setImmediate);
        const afterMacro = decodeHeader(_currentRecordBytes()).spanId;
        assert.deepEqual(before, SPAN_ID_BYTES);
        assert.deepEqual(afterMicro, SPAN_ID_BYTES);
        assert.deepEqual(afterMacro, SPAN_ID_BYTES);
    }, { traceId: TRACE_ID_BYTES, spanId: SPAN_ID_BYTES });
});

test('concurrent async runWithContext calls keep contexts isolated', async () => {
    const aSpan = bytesFromHex('1111111111111111');
    const bSpan = bytesFromHex('2222222222222222');

    async function run(spanBytes) {
        return runWithContext(async () => {
            const observed = [];
            for (let i = 0; i < 4; i++) {
                observed.push(decodeHeader(_currentRecordBytes()).spanId);
                await Promise.resolve();
            }
            return observed;
        }, { traceId: TRACE_ID_BYTES, spanId: spanBytes });
    }

    const [aObs, bObs] = await Promise.all([run(aSpan), run(bSpan)]);
    for (const s of aObs) assert.deepEqual(s, aSpan);
    for (const s of bObs) assert.deepEqual(s, bSpan);
});

test('makeNamedContext rejects non-array keys', () => {
    assert.throws(() => makeNamedContext({}), /must be an array/);
});

test('makeNamedContext rejects more than 256 keys', () => {
    const tooMany = Array.from({ length: 257 }, (_, i) => `k${i}`);
    assert.throws(() => makeNamedContext(tooMany), /exceeds 256/);
});

test('makeNamedContext rejects duplicate names', () => {
    assert.throws(() => makeNamedContext(['x', 'y', 'x']), /duplicate key name/);
});

test('makeNamedContext rejects non-string entries', () => {
    assert.throws(() => makeNamedContext(['ok', 42]), /must be a string/);
});

test('namedAttributes (object form) resolves to indices', () => {
    const named = makeNamedContext(['http.method', 'http.route']);
    let bytes;
    named.runWithContext(() => { bytes = _currentRecordBytes(); }, {
        traceId: TRACE_ID_BYTES,
        spanId:  SPAN_ID_BYTES,
        namedAttributes: { 'http.method': 'GET', 'http.route': '/x' },
    });
    assert.deepEqual(decodeAttrs(bytes), ['GET', '/x']);
});

test('namedAttributes (Map form) resolves to indices', () => {
    const named = makeNamedContext(['a', 'b']);
    let bytes;
    named.runWithContext(() => { bytes = _currentRecordBytes(); }, {
        traceId: TRACE_ID_BYTES,
        spanId:  SPAN_ID_BYTES,
        namedAttributes: new Map([['a', 'A'], ['b', 'B']]),
    });
    assert.deepEqual(decodeAttrs(bytes), ['A', 'B']);
});

test('namedAttributes (array form) resolves to indices', () => {
    const named = makeNamedContext(['a', 'b']);
    let bytes;
    named.runWithContext(() => { bytes = _currentRecordBytes(); }, {
        traceId: TRACE_ID_BYTES,
        spanId:  SPAN_ID_BYTES,
        namedAttributes: [['a', 'A'], ['b', 'B']],
    });
    assert.deepEqual(decodeAttrs(bytes), ['A', 'B']);
});

test('unknown name in namedAttributes is rejected', () => {
    const named = makeNamedContext(['a']);
    assert.throws(() => named.runWithContext(() => {}, {
        traceId: TRACE_ID_BYTES,
        spanId:  SPAN_ID_BYTES,
        namedAttributes: { unknown: 'v' },
    }), /unknown attribute name: unknown/);
});

test('namedAttributes coerces non-string values', () => {
    const named = makeNamedContext(['n']);
    let bytes;
    named.runWithContext(() => { bytes = _currentRecordBytes(); }, {
        traceId: TRACE_ID_BYTES,
        spanId:  SPAN_ID_BYTES,
        namedAttributes: { n: 7 },
    });
    assert.deepEqual(decodeAttrs(bytes), ['7']);
});

test('enterWithContext attaches the record to the current async scope', () => {
    // Provide an outer scope so the enterWith attachment can't leak past
    // this test: when this outer runWithContext returns, the inner scope
    // (and anything enterWith did within it) is discarded.
    runWithContext(() => {
        assert.deepEqual(decodeHeader(_currentRecordBytes()).spanId, SPAN_ID_BYTES);

        const newSpan = bytesFromHex('aabbccddeeff0011');
        enterWithContext({ traceId: TRACE_ID_BYTES, spanId: newSpan });
        assert.deepEqual(decodeHeader(_currentRecordBytes()).spanId, newSpan);

        // Subsequent async work in the same scope still sees the new record.
        return Promise.resolve().then(() => {
            assert.deepEqual(decodeHeader(_currentRecordBytes()).spanId, newSpan);
        });
    }, { traceId: TRACE_ID_BYTES, spanId: SPAN_ID_BYTES });

    assert.equal(_currentRecordBytes(), undefined);
});

test('enterWithContext requires an options object', () => {
    assert.throws(() => enterWithContext(undefined), /options object required/);
});

test('makeNamedContext returns an object with both methods', () => {
    const named = makeNamedContext(['a']);
    assert.equal(typeof named.runWithContext, 'function');
    assert.equal(typeof named.enterWithContext, 'function');
});

test('named.enterWithContext attaches a name-addressed record', () => {
    const named = makeNamedContext(['route']);
    runWithContext(() => {
        named.enterWithContext({
            traceId: TRACE_ID_BYTES,
            spanId:  SPAN_ID_BYTES,
            namedAttributes: { route: '/x' },
        });
        assert.deepEqual(decodeAttrs(_currentRecordBytes()), ['/x']);
    }, { traceId: TRACE_ID_BYTES, spanId: SPAN_ID_BYTES });
});

test('otel_thread_ctx_nodejs_v1 is exported as a TLS dynsym', (t) => {
    const addon = path.join(__dirname, '..', 'build', 'Release', 'customlabels.node');
    const r = spawnSync('readelf', ['--dyn-syms', '--wide', addon], { encoding: 'utf8' });
    if (r.error && r.error.code === 'ENOENT') {
        t.skip('readelf not available (install binutils to run this test)');
        return;
    }
    assert.equal(r.status, 0, `readelf failed: ${r.stderr}`);
    // Match the TLS variable specifically (not the implicit C++ constructor /
    // destructor symbols, which also embed the struct's type name).
    const line = r.stdout
        .split('\n')
        .find(l => /\sotel_thread_ctx_nodejs_v1$/.test(l));
    assert.ok(line, 'otel_thread_ctx_nodejs_v1 not present in dynamic symbol table');
    // Expected columns from readelf --dyn-syms:
    //   Num: Value Size Type Bind Visibility Ndx Name
    assert.match(line, /\bTLS\b/, `expected TLS type, got: ${line.trim()}`);
    assert.match(line, /\bGLOBAL\b/, `expected GLOBAL binding, got: ${line.trim()}`);
    assert.match(line, /\bDEFAULT\b/, `expected DEFAULT visibility, got: ${line.trim()}`);
});

