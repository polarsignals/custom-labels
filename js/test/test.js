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
const { runWithContext, enterWithContext, appendAttributes, makeNamedContext, _currentRecordBytes } = lib;

const TRACE_ID_BYTES = bytesFromHex('0102030405060708090a0b0c0d0e0f10');
const SPAN_ID_BYTES  = bytesFromHex('1112131415161718');

// Returns a plain Uint8Array (not a Buffer) so assert.deepStrictEqual against
// other Uint8Arrays — including the one the addon returns — succeeds.
function bytesFromHex(hex) {
    return Uint8Array.from(Buffer.from(hex, 'hex'));
}

function decodeHeader(bytes) {
    assert.ok(bytes.length >= 28, `record must be at least 28 bytes, got ${bytes.length}`);
    const attrsDataSize = bytes[26] | (bytes[27] << 8);
    assert.equal(bytes.length, 28 + attrsDataSize,
        `record length (${bytes.length}) must equal 28 + attrs_data_size (${attrsDataSize})`);
    return {
        traceId: bytes.slice(0, 16),
        spanId: bytes.slice(16, 24),
        valid: bytes[24],
        reserved: bytes[25],
        attrsDataSize,
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

test('record is right-sized: empty attrs ⇒ 28-byte record', () => {
    const bytes = captureBytes({ traceId: TRACE_ID_BYTES, spanId: SPAN_ID_BYTES });
    assert.equal(bytes.length, 28);
});

test('record is right-sized: one short attribute ⇒ 28 + 2 + len bytes', () => {
    const bytes = captureBytes({
        traceId: TRACE_ID_BYTES,
        spanId:  SPAN_ID_BYTES,
        attributes: ['GET'],
    });
    assert.equal(bytes.length, 28 + 2 + 3);
});

test('large attrs sets fit (no 612-byte cap)', () => {
    // Three 255-byte values: 3 * 257 = 771 bytes — would have been silently
    // dropped past the second under the old 612-byte cap. With the cap
    // removed they're all present.
    const a = 'a'.repeat(255);
    const b = 'b'.repeat(255);
    const c = 'c'.repeat(255);
    const bytes = captureBytes({
        traceId: TRACE_ID_BYTES,
        spanId:  SPAN_ID_BYTES,
        attributes: [a, b, c],
    });
    assert.deepEqual(decodeAttrs(bytes), [a, b, c]);
    assert.equal(decodeHeader(bytes).attrsDataSize, 771);
    assert.equal(bytes.length, 28 + 771);
});

test('total attrs payload exceeding 65535 bytes throws', () => {
    // 256 × 257 = 65792 — three bytes past the uint16 attrs_data_size limit.
    const big = 'x'.repeat(255);
    const attributes = new Array(256).fill(big);
    assert.throws(() => captureBytes({
        traceId: TRACE_ID_BYTES,
        spanId:  SPAN_ID_BYTES,
        attributes,
    }), /65535-byte attrs_data_size limit/);
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

test('makeNamedContext exposes processContextAttributes matching the input keys', () => {
    const keys = ['http.method', 'http.route', 'user.id'];
    const named = makeNamedContext(keys);
    assert.deepEqual(named.processContextAttributes, {
        'threadlocal.schema_version': 'nodejs_v1',
        'threadlocal.attribute_key_map': keys,
    });
});

test('processContextAttributes is frozen and a defensive copy', () => {
    const keys = ['http.method', 'http.route'];
    const named = makeNamedContext(keys);
    const pca = named.processContextAttributes;
    assert.ok(Object.isFrozen(pca));
    assert.ok(Object.isFrozen(pca['threadlocal.attribute_key_map']));

    // Mutating the input array afterwards must not change the snapshot.
    keys.push('mutated.after');
    assert.deepEqual(pca['threadlocal.attribute_key_map'], ['http.method', 'http.route']);

    // Attempting to reassign a property silently no-ops in non-strict, throws
    // in strict (and this test file is strict).
    assert.throws(() => {
        pca['threadlocal.schema_version'] = 'tampered';
    }, /read-only|read only|TypeError/i);
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

test('appendAttributes adds entries to the current record', () => {
    runWithContext(() => {
        assert.deepEqual(decodeAttrs(_currentRecordBytes()), ['GET']);
        appendAttributes([, , '200']);
        assert.deepEqual(decodeAttrs(_currentRecordBytes()), ['GET', , '200']);
    }, {
        traceId: TRACE_ID_BYTES,
        spanId:  SPAN_ID_BYTES,
        attributes: ['GET'],
    });
});

test('appendAttributes is in-place when bytes fit in the slack', () => {
    runWithContext(() => {
        // Initial allocation has at least 64 bytes of attrs_data capacity;
        // one "xxx" entry occupies 5. An append of "ab" (4 bytes encoded)
        // fits in the slack, so the append takes the in-place path.
        const before = _currentRecordBytes();
        appendAttributes([, 'ab']);
        const after = _currentRecordBytes();
        assert.deepEqual(decodeAttrs(after), ['xxx', 'ab']);
        assert.equal(after.length, before.length + 2 + 2);
        // The header up to attrs_data_size and the original entry are
        // untouched. attrs_data_size itself legitimately changes (5 → 9),
        // so we skip it. We can't observe in-place vs reallocate identity
        // from JS, but the unchanged trace_id/span_id/valid/reserved bytes
        // plus the unchanged "xxx" entry are consistent with the in-place
        // path; a behavioral assertion is the closest the JS layer can
        // make.
        assert.deepEqual(after.slice(0, 26), before.slice(0, 26));
        assert.deepEqual(after.slice(28, 33), before.slice(28, 33));
        assert.equal(after[24], 1);  // valid restored to 1 after the dance
    }, {
        traceId: TRACE_ID_BYTES,
        spanId:  SPAN_ID_BYTES,
        attributes: ['xxx'],
    });
});

test('appendAttributes grows the record geometrically when slack runs out', () => {
    runWithContext(() => {
        // Append 8 × 60-byte values. Each encodes to 62 bytes; 8 of them =
        // 496 bytes total. The initial 64-byte capacity is exhausted quickly;
        // the buffer doubles (64 → 128 → 256 → 512) and ends up with all
        // 8 entries present in the right positions.
        const v = 'y'.repeat(60);
        for (let i = 0; i < 8; i++) {
            const append = [];
            append[i] = v;
            appendAttributes(append);
        }
        const decoded = decodeAttrs(_currentRecordBytes());
        for (let i = 0; i < 8; i++) {
            assert.equal(decoded[i], v, `slot ${i}`);
        }
        assert.equal(decodeHeader(_currentRecordBytes()).attrsDataSize, 8 * 62);
    }, { traceId: TRACE_ID_BYTES, spanId: SPAN_ID_BYTES });
});

test('appendAttributes throws when there is no current context', () => {
    assert.throws(() => appendAttributes(['v']), /no active thread context/);
});

test('appendAttributes is a no-op when given an empty array', () => {
    runWithContext(() => {
        const before = _currentRecordBytes();
        appendAttributes([]);
        const after = _currentRecordBytes();
        assert.deepEqual(after, before);
    }, { traceId: TRACE_ID_BYTES, spanId: SPAN_ID_BYTES });
});

test('appendAttributes is a no-op when all slots are null/undefined', () => {
    runWithContext(() => {
        const before = _currentRecordBytes();
        appendAttributes([null, undefined, , null]);
        const after = _currentRecordBytes();
        assert.deepEqual(after, before);
    }, { traceId: TRACE_ID_BYTES, spanId: SPAN_ID_BYTES });
});

test('appendAttributes throws when the combined payload would exceed 65535 bytes', () => {
    runWithContext(() => {
        // Fill the record to ~65000 bytes, then try to append enough to
        // overflow.
        const big = 'a'.repeat(255);
        for (let chunk = 0; chunk < 252; chunk++) {
            const a = [];
            a[chunk % 256] = big;
            appendAttributes(a);
        }
        // attrs_data_size is now 252 × 257 = 64764. Another 257-byte entry
        // brings it to 65021 — still under the cap.
        appendAttributes([big]);
        // Now ~65021 bytes used. Three more 257-byte appends (~771 bytes)
        // would push past 65535. The throw lands on whichever append first
        // crosses the cap.
        assert.throws(() => {
            for (let i = 0; i < 3; i++) appendAttributes([big]);
        }, /65535-byte attrs_data_size limit/);
    }, { traceId: TRACE_ID_BYTES, spanId: SPAN_ID_BYTES });
});

test('appendAttributes propagates through async continuations', async () => {
    await runWithContext(async () => {
        appendAttributes([, 'after-await']);
        await Promise.resolve();
        // After await, the same wrapper is still in the ALS, and append's
        // effect is observable.
        assert.deepEqual(decodeAttrs(_currentRecordBytes()), ['before', 'after-await']);
    }, {
        traceId: TRACE_ID_BYTES,
        spanId:  SPAN_ID_BYTES,
        attributes: ['before'],
    });
});

test('named.appendAttributes appends by name', () => {
    const named = makeNamedContext(['http.method', 'http.route', 'http.status']);
    named.runWithContext(() => {
        named.appendAttributes({ 'http.status': '500' });
        assert.deepEqual(decodeAttrs(_currentRecordBytes()), ['GET', '/x', '500']);
    }, {
        traceId: TRACE_ID_BYTES,
        spanId:  SPAN_ID_BYTES,
        namedAttributes: { 'http.method': 'GET', 'http.route': '/x' },
    });
});

test('named.appendAttributes rejects unknown names', () => {
    const named = makeNamedContext(['known']);
    named.runWithContext(() => {
        assert.throws(
            () => named.appendAttributes({ unknown: 'v' }),
            /unknown attribute name: unknown/,
        );
    }, {
        traceId: TRACE_ID_BYTES,
        spanId:  SPAN_ID_BYTES,
        namedAttributes: { known: 'k' },
    });
});

test('otel_thread_ctx_nodejs_v1 is exported as a TLS dynsym', (t) => {
    const addon = path.join(__dirname, '..', 'build', 'Release', 'customlabels.node');
    const r = spawnSync('readelf', ['--dyn-syms', '--wide', addon], { encoding: 'utf8' });
    if (r.error && r.error.code === 'ENOENT') {
        assert.fail('readelf not available (install binutils to run this test)');
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

