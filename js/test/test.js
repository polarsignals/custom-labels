'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

if (process.platform !== 'linux') {
    console.log(`Skipping native tests on ${process.platform}; the addon is Linux-only.`);
    return;
}

// AsyncContextFrame (the writer's discovery substrate) is opt-in on Node
// 22/23 (via --experimental-async-context-frame), on by default in Node
// 24+ (disable-able via --no-async-context-frame), and absent on Node <
// 22. The "test" npm script supplies the flag, but a direct `node
// test/test.js` invocation without it would have every test fail noisily
// — bail cleanly instead.
function isAsyncContextFrameAvailable() {
    if (process.execArgv.includes('--no-async-context-frame')) return false;
    const major = Number(process.versions.node.split('.')[0]);
    if (major >= 24) return true;
    if (major >= 22) {
        return process.execArgv.includes('--experimental-async-context-frame');
    }
    return false;
}

if (!isAsyncContextFrameAvailable()) {
    console.log('Skipping native tests: AsyncContextFrame is unavailable on this Node. ' +
                'Use Node 24+ or launch with --experimental-async-context-frame on Node 22/23.');
    return;
}

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const lib = require('..');
const { ThreadContext, getContext, clearContext, makeNamedContext, _currentRecordBytes } = lib;

// Helpers bridging the old positional-attrs test shape to the new
// ThreadContext-first API.
function tcRun(fn, opts) {
    return new ThreadContext(opts.traceId, opts.spanId, opts.attributes).run(fn);
}
function tcEnter(opts) {
    new ThreadContext(opts.traceId, opts.spanId, opts.attributes).enter();
}
function tcAppend(attributes) { getContext().appendAttributes(attributes); }
function tcIsTruncated() { const c = getContext(); return c ? c.isTruncated() : false; }

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
    tcRun(() => { bytes = _currentRecordBytes(); }, opts);
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

test('attrs sets past the 612-byte cap are truncated (entries past the limit dropped, smaller subsequent entries still fit)', () => {
    // Two 255-byte values: 2 × 257 = 514 bytes used. A third 255-byte
    // entry would push to 771 — well over the 612-byte attrs_data cap, so
    // it's dropped. The trailing 30-byte entry (32 bytes encoded) brings
    // the total to 546, which still fits — verifies skip-and-continue
    // rather than break-on-first-overflow.
    const a = 'a'.repeat(255);
    const b = 'b'.repeat(255);
    const c = 'c'.repeat(255);
    const d = 'd'.repeat(30);
    let bytes;
    let truncated;
    tcRun(() => {
        bytes = _currentRecordBytes();
        truncated = tcIsTruncated();
    }, {
        traceId: TRACE_ID_BYTES,
        spanId:  SPAN_ID_BYTES,
        attributes: [a, b, c, d],
    });
    assert.deepEqual(decodeAttrs(bytes), [a, b, , d]);
    assert.equal(decodeHeader(bytes).attrsDataSize, 514 + 32);
    assert.equal(truncated, true);
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
    const result = tcRun(() => 'ok', { traceId: TRACE_ID_BYTES, spanId: SPAN_ID_BYTES });
    assert.equal(result, 'ok');
});

test('outside runWithContext, no active record', () => {
    assert.equal(_currentRecordBytes(), undefined);
});

test('after runWithContext returns, no active record', () => {
    tcRun(() => {}, { traceId: TRACE_ID_BYTES, spanId: SPAN_ID_BYTES });
    assert.equal(_currentRecordBytes(), undefined);
});

test('nested runWithContext restores parent context after inner returns', () => {
    const outerOpts = { traceId: TRACE_ID_BYTES, spanId: SPAN_ID_BYTES };
    const innerSpanBytes = bytesFromHex('aabbccddeeff0011');
    const innerOpts = { traceId: TRACE_ID_BYTES, spanId: innerSpanBytes };

    tcRun(() => {
        const outerBefore = decodeHeader(_currentRecordBytes()).spanId;
        tcRun(() => {
            const inner = decodeHeader(_currentRecordBytes()).spanId;
            assert.deepEqual(inner, innerSpanBytes);
        }, innerOpts);
        const outerAfter = decodeHeader(_currentRecordBytes()).spanId;
        assert.deepEqual(outerBefore, outerAfter);
        assert.deepEqual(outerAfter, SPAN_ID_BYTES);
    }, outerOpts);
});

test('async work inside runWithContext sees same record after awaits', async () => {
    await tcRun(async () => {
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
        return tcRun(async () => {
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
    tcRun(() => {
        assert.deepEqual(decodeHeader(_currentRecordBytes()).spanId, SPAN_ID_BYTES);

        const newSpan = bytesFromHex('aabbccddeeff0011');
        tcEnter({ traceId: TRACE_ID_BYTES, spanId: newSpan });
        assert.deepEqual(decodeHeader(_currentRecordBytes()).spanId, newSpan);

        // Subsequent async work in the same scope still sees the new record.
        return Promise.resolve().then(() => {
            assert.deepEqual(decodeHeader(_currentRecordBytes()).spanId, newSpan);
        });
    }, { traceId: TRACE_ID_BYTES, spanId: SPAN_ID_BYTES });

    assert.equal(_currentRecordBytes(), undefined);
});

test('makeNamedContext returns an object exposing buildContext + sugar', () => {
    const named = makeNamedContext(['a']);
    assert.equal(typeof named.buildContext, 'function');
    assert.equal(typeof named.runWithContext, 'function');
    assert.equal(typeof named.enterWithContext, 'function');
    assert.equal(typeof named.clearContext, 'function');
});

test('makeNamedContext exposes processContextAttributes matching the input keys', () => {
    const keys = ['http.method', 'http.route', 'user.id'];
    const named = makeNamedContext(keys);
    const pca = named.processContextAttributes;
    assert.equal(pca['threadlocal.schema_version'], 'nodejs_v1');
    assert.deepEqual(pca['threadlocal.attribute_key_map'], keys);
    // V8 layout constants — on Node's standard build (no pointer
    // compression, no sandbox) these are 24 and 8 respectively.
    assert.equal(pca['threadlocal.nodejs_v1.wrapped_object_offset'], 24);
    assert.equal(pca['threadlocal.nodejs_v1.tagged_size'], 8);
    assert.deepEqual(Object.keys(pca).sort(), [
        'threadlocal.attribute_key_map',
        'threadlocal.nodejs_v1.tagged_size',
        'threadlocal.nodejs_v1.wrapped_object_offset',
        'threadlocal.schema_version',
    ]);
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
    tcRun(() => {
        named.enterWithContext({
            traceId: TRACE_ID_BYTES,
            spanId:  SPAN_ID_BYTES,
            namedAttributes: { route: '/x' },
        });
        assert.deepEqual(decodeAttrs(_currentRecordBytes()), ['/x']);
    }, { traceId: TRACE_ID_BYTES, spanId: SPAN_ID_BYTES });
});

test('clearContext detaches the active record within a scope', () => {
    tcRun(() => {
        assert.ok(_currentRecordBytes());
        clearContext();
        assert.equal(_currentRecordBytes(), undefined);
    }, { traceId: TRACE_ID_BYTES, spanId: SPAN_ID_BYTES });
});

test('after clearContext, getContext returns undefined and isContextTruncated is false', () => {
    tcRun(() => {
        assert.ok(getContext() !== undefined);
        clearContext();
        assert.equal(getContext(), undefined);
        assert.equal(tcIsTruncated(), false);
    }, { traceId: TRACE_ID_BYTES, spanId: SPAN_ID_BYTES });
});

test('clearContext is idempotent (calling twice or with no context is a no-op)', () => {
    // Outside any context — should not throw.
    clearContext();
    assert.equal(_currentRecordBytes(), undefined);
    tcRun(() => {
        clearContext();
        clearContext();
        assert.equal(_currentRecordBytes(), undefined);
    }, { traceId: TRACE_ID_BYTES, spanId: SPAN_ID_BYTES });
});

test('runWithContext re-establishes a record after a clearContext', () => {
    tcRun(() => {
        clearContext();
        const innerSpan = bytesFromHex('aabbccddeeff0011');
        tcRun(() => {
            assert.deepEqual(decodeHeader(_currentRecordBytes()).spanId, innerSpan);
        }, { traceId: TRACE_ID_BYTES, spanId: innerSpan });
        // After the inner runWithContext returns, we're back to the
        // post-clear state in the outer scope: no active record.
        assert.equal(_currentRecordBytes(), undefined);
    }, { traceId: TRACE_ID_BYTES, spanId: SPAN_ID_BYTES });
});

test('enterWithContext re-establishes a record after a clearContext', () => {
    tcRun(() => {
        clearContext();
        const newSpan = bytesFromHex('aabbccddeeff0011');
        tcEnter({ traceId: TRACE_ID_BYTES, spanId: newSpan });
        assert.deepEqual(decodeHeader(_currentRecordBytes()).spanId, newSpan);
    }, { traceId: TRACE_ID_BYTES, spanId: SPAN_ID_BYTES });
});

test('named.clearContext detaches the active record', () => {
    const named = makeNamedContext(['route']);
    named.runWithContext(() => {
        assert.ok(_currentRecordBytes());
        named.clearContext();
        assert.equal(_currentRecordBytes(), undefined);
    }, {
        traceId: TRACE_ID_BYTES,
        spanId:  SPAN_ID_BYTES,
        namedAttributes: { route: '/x' },
    });
});

test('appendAttributes adds entries to the current record', () => {
    tcRun(() => {
        assert.deepEqual(decodeAttrs(_currentRecordBytes()), ['GET']);
        tcAppend([, , '200']);
        assert.deepEqual(decodeAttrs(_currentRecordBytes()), ['GET', , '200']);
    }, {
        traceId: TRACE_ID_BYTES,
        spanId:  SPAN_ID_BYTES,
        attributes: ['GET'],
    });
});

test('appendAttributes is in-place when bytes fit in the slack', () => {
    tcRun(() => {
        // Initial allocation has at least 64 bytes of attrs_data capacity;
        // one "xxx" entry occupies 5. An append of "ab" (4 bytes encoded)
        // fits in the slack, so the append takes the in-place path.
        const before = _currentRecordBytes();
        tcAppend([, 'ab']);
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
    tcRun(() => {
        // Append 8 × 60-byte values. Each encodes to 62 bytes; 8 of them =
        // 496 bytes total. The initial 64-byte capacity is exhausted quickly;
        // the buffer doubles (64 → 128 → 256 → 512) and ends up with all
        // 8 entries present in the right positions.
        const v = 'y'.repeat(60);
        for (let i = 0; i < 8; i++) {
            const append = [];
            append[i] = v;
            tcAppend(append);
        }
        const decoded = decodeAttrs(_currentRecordBytes());
        for (let i = 0; i < 8; i++) {
            assert.equal(decoded[i], v, `slot ${i}`);
        }
        assert.equal(decodeHeader(_currentRecordBytes()).attrsDataSize, 8 * 62);
    }, { traceId: TRACE_ID_BYTES, spanId: SPAN_ID_BYTES });
});

test('appendAttributes is a no-op when given an empty array', () => {
    tcRun(() => {
        const before = _currentRecordBytes();
        tcAppend([]);
        const after = _currentRecordBytes();
        assert.deepEqual(after, before);
    }, { traceId: TRACE_ID_BYTES, spanId: SPAN_ID_BYTES });
});

test('appendAttributes is a no-op when all slots are null/undefined', () => {
    tcRun(() => {
        const before = _currentRecordBytes();
        tcAppend([null, undefined, , null]);
        const after = _currentRecordBytes();
        assert.deepEqual(after, before);
    }, { traceId: TRACE_ID_BYTES, spanId: SPAN_ID_BYTES });
});

test('appendAttributes silently drops entries past the 612-byte cap and sets the truncated flag', () => {
    const big = 'a'.repeat(255); // 257 bytes encoded
    tcRun(() => {
        // 2 × 257 = 514 bytes, all fit.
        tcAppend([big, big]);
        assert.equal(tcIsTruncated(), false);
        // A third 257-byte entry would push to 771 — drops, flag flips.
        tcAppend([, , big]);
        assert.equal(tcIsTruncated(), true);
        assert.equal(decodeHeader(_currentRecordBytes()).attrsDataSize, 514);
        // A subsequent small entry (e.g. 30 bytes) still fits and is kept;
        // skip-and-continue applies to per-call as well as per-record-cap.
        const small = 'x'.repeat(30);
        tcAppend([, , , small]);
        const decoded = decodeAttrs(_currentRecordBytes());
        assert.equal(decoded[0], big);
        assert.equal(decoded[1], big);
        assert.equal(decoded[2], undefined);
        assert.equal(decoded[3], small);
        // Flag stays true.
        assert.equal(tcIsTruncated(), true);
    }, { traceId: TRACE_ID_BYTES, spanId: SPAN_ID_BYTES });
});

test('isContextTruncated returns false outside a context', () => {
    assert.equal(tcIsTruncated(), false);
});

test('isContextTruncated returns false for a non-truncated record', () => {
    tcRun(() => {
        assert.equal(tcIsTruncated(), false);
    }, {
        traceId: TRACE_ID_BYTES,
        spanId:  SPAN_ID_BYTES,
        attributes: ['GET', '/x'],
    });
});

test('isTruncated reflects appended-then-overflowed entries', () => {
    const named = makeNamedContext(['a', 'b', 'c']);
    named.runWithContext(() => {
        assert.equal(tcIsTruncated(), false);
        tcAppend([, , 'c'.repeat(255), , , 'd'.repeat(255), , , 'e'.repeat(255)]);
        // Three 257-byte appends past the existing ~2 bytes = 771 > 612.
        // At least one must have been dropped.
        assert.equal(tcIsTruncated(), true);
    }, {
        traceId: TRACE_ID_BYTES,
        spanId:  SPAN_ID_BYTES,
        namedAttributes: { a: 'a', b: 'b' },
    });
});

test('appendAttributes propagates through async continuations', async () => {
    await tcRun(async () => {
        tcAppend([, 'after-await']);
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

test('buildContext rejects unknown names', () => {
    const named = makeNamedContext(['known']);
    assert.throws(
        () => named.buildContext({
            traceId: TRACE_ID_BYTES,
            spanId:  SPAN_ID_BYTES,
            namedAttributes: { unknown: 'v' },
        }),
        /unknown attribute name: unknown/,
    );
});

test('otel_thread_ctx_nodejs_v1 is exported as a TLS dynsym', (t) => {
    const addon = path.join(__dirname, '..', 'build', 'Release', 'customlabels.node');
    if (!require('node:fs').existsSync(addon)) {
        t.skip(`addon binary not found at ${addon}`);
        return;
    }
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

