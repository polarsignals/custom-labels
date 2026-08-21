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
const { ThreadContext, getContext, clearContext, getProcessContextAttributes, _currentRecordBytes } = lib;

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

function captureBytes({ traceId, spanId, attributes } = {}) {
    let bytes;
    new ThreadContext(traceId, spanId, attributes).run(() => { bytes = _currentRecordBytes(); });
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
    new ThreadContext(TRACE_ID_BYTES, SPAN_ID_BYTES, [a, b, c, d]).run(() => {
        bytes = _currentRecordBytes();
        truncated = getContext().isTruncated();
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

test('ThreadContext.run returns fn result', () => {
    const result = new ThreadContext(TRACE_ID_BYTES, SPAN_ID_BYTES).run(() => 'ok');
    assert.equal(result, 'ok');
});

test('outside a ThreadContext, no active record', () => {
    assert.equal(_currentRecordBytes(), undefined);
});

test('after ThreadContext.run returns, no active record', () => {
    new ThreadContext(TRACE_ID_BYTES, SPAN_ID_BYTES).run(() => {});
    assert.equal(_currentRecordBytes(), undefined);
});

test('nested ThreadContext.run restores parent context after inner returns', () => {
    const innerSpanBytes = bytesFromHex('aabbccddeeff0011');

    new ThreadContext(TRACE_ID_BYTES, SPAN_ID_BYTES).run(() => {
        const outerBefore = decodeHeader(_currentRecordBytes()).spanId;
        new ThreadContext(TRACE_ID_BYTES, innerSpanBytes).run(() => {
            const inner = decodeHeader(_currentRecordBytes()).spanId;
            assert.deepEqual(inner, innerSpanBytes);
        });
        const outerAfter = decodeHeader(_currentRecordBytes()).spanId;
        assert.deepEqual(outerBefore, outerAfter);
        assert.deepEqual(outerAfter, SPAN_ID_BYTES);
    });
});

test('async work inside ThreadContext.run sees same record after awaits', async () => {
    await new ThreadContext(TRACE_ID_BYTES, SPAN_ID_BYTES).run(async () => {
        const before = decodeHeader(_currentRecordBytes()).spanId;
        await Promise.resolve();
        const afterMicro = decodeHeader(_currentRecordBytes()).spanId;
        await new Promise(setImmediate);
        const afterMacro = decodeHeader(_currentRecordBytes()).spanId;
        assert.deepEqual(before, SPAN_ID_BYTES);
        assert.deepEqual(afterMicro, SPAN_ID_BYTES);
        assert.deepEqual(afterMacro, SPAN_ID_BYTES);
    });
});

test('concurrent async ThreadContext.run calls keep contexts isolated', async () => {
    const aSpan = bytesFromHex('1111111111111111');
    const bSpan = bytesFromHex('2222222222222222');

    async function run(spanBytes) {
        return new ThreadContext(TRACE_ID_BYTES, spanBytes).run(async () => {
            const observed = [];
            for (let i = 0; i < 4; i++) {
                observed.push(decodeHeader(_currentRecordBytes()).spanId);
                await Promise.resolve();
            }
            return observed;
        });
    }

    const [aObs, bObs] = await Promise.all([run(aSpan), run(bSpan)]);
    for (const s of aObs) assert.deepEqual(s, aSpan);
    for (const s of bObs) assert.deepEqual(s, bSpan);
});

test('getProcessContextAttributes rejects non-array keys', () => {
    assert.throws(() => getProcessContextAttributes({}), /must be an array/);
});

test('getProcessContextAttributes rejects more than 256 keys', () => {
    const tooMany = Array.from({ length: 257 }, (_, i) => `k${i}`);
    assert.throws(() => getProcessContextAttributes(tooMany), /exceeds 256/);
});

test('getProcessContextAttributes rejects duplicate names', () => {
    assert.throws(() => getProcessContextAttributes(['x', 'y', 'x']), /duplicate key name/);
});

test('getProcessContextAttributes rejects non-string entries', () => {
    assert.throws(() => getProcessContextAttributes(['ok', 42]), /must be a string/);
});

test('ThreadContext.enter attaches the record to the current async scope', async () => {
    // Provide an outer scope so the enter() attachment can't leak past
    // this test: when this outer run() returns, the inner scope (and
    // anything enter() did within it) is discarded.
    await new ThreadContext(TRACE_ID_BYTES, SPAN_ID_BYTES).run(() => {
        assert.deepEqual(decodeHeader(_currentRecordBytes()).spanId, SPAN_ID_BYTES);

        const newSpan = bytesFromHex('aabbccddeeff0011');
        new ThreadContext(TRACE_ID_BYTES, newSpan).enter();
        assert.deepEqual(decodeHeader(_currentRecordBytes()).spanId, newSpan);

        // Subsequent async work in the same scope still sees the new record.
        return Promise.resolve().then(() => {
            assert.deepEqual(decodeHeader(_currentRecordBytes()).spanId, newSpan);
        });
    });

    assert.equal(_currentRecordBytes(), undefined);
});

test('getProcessContextAttributes returns the expected shape', () => {
    const keys = ['http.method', 'http.route', 'user.id'];
    const pca = getProcessContextAttributes(keys);
    assert.equal(pca['threadlocal.schema_version'], 'nodejs_v1_dev');
    assert.deepEqual(pca['threadlocal.attribute_key_map'], keys);
    // V8 layout constants — on Node's standard build (no pointer
    // compression, no sandbox) these are 24 and 8 respectively.
    assert.equal(pca['threadlocal.wrapped_object_offset'], 24);
    assert.equal(pca['threadlocal.tagged_size'], 8);
    assert.equal(pca['threadlocal.native_wrap_fields_offset'], 0);
    assert.equal(pca['threadlocal.js_map_table_offset'], 0x18);
    assert.equal(pca['threadlocal.ordered_hash_map_header_size'], 0x10);
    assert.deepEqual(Object.keys(pca).sort(), [
        'threadlocal.attribute_key_map',
        'threadlocal.js_map_table_offset',
        'threadlocal.native_wrap_fields_offset',
        'threadlocal.ordered_hash_map_header_size',
        'threadlocal.schema_version',
        'threadlocal.tagged_size',
        'threadlocal.wrapped_object_offset',
    ]);
});

test('getProcessContextAttributes is frozen and a defensive copy', () => {
    const keys = ['http.method', 'http.route'];
    const pca = getProcessContextAttributes(keys);
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

test('clearContext detaches the active record within a scope', () => {
    new ThreadContext(TRACE_ID_BYTES, SPAN_ID_BYTES).run(() => {
        assert.ok(_currentRecordBytes());
        clearContext();
        assert.equal(_currentRecordBytes(), undefined);
    });
});

test('after clearContext, getContext returns undefined', () => {
    new ThreadContext(TRACE_ID_BYTES, SPAN_ID_BYTES).run(() => {
        assert.ok(getContext() !== undefined);
        clearContext();
        assert.equal(getContext(), undefined);
    });
});

test('clearContext is idempotent (calling twice or with no context is a no-op)', () => {
    // Outside any context — should not throw.
    clearContext();
    assert.equal(_currentRecordBytes(), undefined);
    new ThreadContext(TRACE_ID_BYTES, SPAN_ID_BYTES).run(() => {
        clearContext();
        clearContext();
        assert.equal(_currentRecordBytes(), undefined);
    });
});

test('ThreadContext.run re-establishes a record after a clearContext', () => {
    new ThreadContext(TRACE_ID_BYTES, SPAN_ID_BYTES).run(() => {
        clearContext();
        const innerSpan = bytesFromHex('aabbccddeeff0011');
        new ThreadContext(TRACE_ID_BYTES, innerSpan).run(() => {
            assert.deepEqual(decodeHeader(_currentRecordBytes()).spanId, innerSpan);
        });
        // After the inner run() returns, we're back to the post-clear state
        // in the outer scope: no active record.
        assert.equal(_currentRecordBytes(), undefined);
    });
});

test('ThreadContext.enter re-establishes a record after a clearContext', () => {
    new ThreadContext(TRACE_ID_BYTES, SPAN_ID_BYTES).run(() => {
        clearContext();
        const newSpan = bytesFromHex('aabbccddeeff0011');
        new ThreadContext(TRACE_ID_BYTES, newSpan).enter();
        assert.deepEqual(decodeHeader(_currentRecordBytes()).spanId, newSpan);
    });
});

test('appendAttributes adds entries to the current record', () => {
    new ThreadContext(TRACE_ID_BYTES, SPAN_ID_BYTES, ['GET']).run(() => {
        assert.deepEqual(decodeAttrs(_currentRecordBytes()), ['GET']);
        getContext().appendAttributes([, , '200']);
        assert.deepEqual(decodeAttrs(_currentRecordBytes()), ['GET', , '200']);
    });
});

test('appendAttributes is in-place when bytes fit in the slack', () => {
    new ThreadContext(TRACE_ID_BYTES, SPAN_ID_BYTES, ['xxx']).run(() => {
        // Initial allocation has at least 64 bytes of attrs_data capacity;
        // one "xxx" entry occupies 5. An append of "ab" (4 bytes encoded)
        // fits in the slack, so the append takes the in-place path.
        const before = _currentRecordBytes();
        getContext().appendAttributes([, 'ab']);
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
    });
});

test('appendAttributes grows the record geometrically when slack runs out', () => {
    new ThreadContext(TRACE_ID_BYTES, SPAN_ID_BYTES).run(() => {
        // Append 8 × 60-byte values. Each encodes to 62 bytes; 8 of them =
        // 496 bytes total. The initial 64-byte capacity is exhausted quickly;
        // the buffer doubles (64 → 128 → 256 → 512) and ends up with all
        // 8 entries present in the right positions.
        const v = 'y'.repeat(60);
        for (let i = 0; i < 8; i++) {
            const append = [];
            append[i] = v;
            getContext().appendAttributes(append);
        }
        const decoded = decodeAttrs(_currentRecordBytes());
        for (let i = 0; i < 8; i++) {
            assert.equal(decoded[i], v, `slot ${i}`);
        }
        assert.equal(decodeHeader(_currentRecordBytes()).attrsDataSize, 8 * 62);
    });
});

test('appendAttributes is a no-op when given an empty array', () => {
    new ThreadContext(TRACE_ID_BYTES, SPAN_ID_BYTES).run(() => {
        const before = _currentRecordBytes();
        getContext().appendAttributes([]);
        const after = _currentRecordBytes();
        assert.deepEqual(after, before);
    });
});

test('appendAttributes is a no-op when all slots are null/undefined', () => {
    new ThreadContext(TRACE_ID_BYTES, SPAN_ID_BYTES).run(() => {
        const before = _currentRecordBytes();
        getContext().appendAttributes([null, undefined, , null]);
        const after = _currentRecordBytes();
        assert.deepEqual(after, before);
    });
});

test('appendAttributes silently drops entries past the 612-byte cap and sets the truncated flag', () => {
    const big = 'a'.repeat(255); // 257 bytes encoded
    new ThreadContext(TRACE_ID_BYTES, SPAN_ID_BYTES).run(() => {
        const ctx = getContext();
        // 2 × 257 = 514 bytes, all fit.
        ctx.appendAttributes([big, big]);
        assert.equal(ctx.isTruncated(), false);
        // A third 257-byte entry would push to 771 — drops, flag flips.
        ctx.appendAttributes([, , big]);
        assert.equal(ctx.isTruncated(), true);
        assert.equal(decodeHeader(_currentRecordBytes()).attrsDataSize, 514);
        // A subsequent small entry (e.g. 30 bytes) still fits and is kept;
        // skip-and-continue applies to per-call as well as per-record-cap.
        const small = 'x'.repeat(30);
        ctx.appendAttributes([, , , small]);
        const decoded = decodeAttrs(_currentRecordBytes());
        assert.equal(decoded[0], big);
        assert.equal(decoded[1], big);
        assert.equal(decoded[2], undefined);
        assert.equal(decoded[3], small);
        // Flag stays true.
        assert.equal(ctx.isTruncated(), true);
    });
});

test('isTruncated returns false for a non-truncated record', () => {
    new ThreadContext(TRACE_ID_BYTES, SPAN_ID_BYTES, ['GET', '/x']).run(() => {
        assert.equal(getContext().isTruncated(), false);
    });
});

test('isTruncated reflects appended-then-overflowed entries', () => {
    new ThreadContext(TRACE_ID_BYTES, SPAN_ID_BYTES, ['a', 'b']).run(() => {
        const ctx = getContext();
        assert.equal(ctx.isTruncated(), false);
        ctx.appendAttributes([, , 'c'.repeat(255), , , 'd'.repeat(255), , , 'e'.repeat(255)]);
        // Three 257-byte appends past the existing ~2 bytes = 771 > 612.
        // At least one must have been dropped.
        assert.equal(ctx.isTruncated(), true);
    });
});

test('appendAttributes propagates through async continuations', async () => {
    await new ThreadContext(TRACE_ID_BYTES, SPAN_ID_BYTES, ['before']).run(async () => {
        getContext().appendAttributes([, 'after-await']);
        await Promise.resolve();
        // After await, the same wrapper is still in the ALS, and append's
        // effect is observable.
        assert.deepEqual(decodeAttrs(_currentRecordBytes()), ['before', 'after-await']);
    });
});

test('invalidate flips the record\'s valid byte to 0 in place', () => {
    // The invalidation is visible across every async-context frame that
    // holds the same ThreadContext reference — nothing about the async
    // scope changes, only the shared record's `valid` header byte.
    const ctx = new ThreadContext(TRACE_ID_BYTES, SPAN_ID_BYTES);
    ctx.run(() => {
        assert.equal(decodeHeader(_currentRecordBytes()).valid, 1);
        ctx.invalidate();
        assert.equal(decodeHeader(_currentRecordBytes()).valid, 0);
    });
});

test('invalidate is idempotent', () => {
    const ctx = new ThreadContext(TRACE_ID_BYTES, SPAN_ID_BYTES);
    ctx.run(() => {
        ctx.invalidate();
        ctx.invalidate();
        assert.equal(decodeHeader(_currentRecordBytes()).valid, 0);
    });
});

test('appendAttributes after invalidate mutates attrs_data but leaves valid=0', () => {
    // The addon separates `valid` from the attrs-append path: an
    // invalidated record's `attrs_data_size` can still grow, but readers
    // MUST honor `valid == 0` and ignore the record anyway.
    const ctx = new ThreadContext(TRACE_ID_BYTES, SPAN_ID_BYTES);
    ctx.run(() => {
        ctx.invalidate();
        ctx.appendAttributes([, 'late']);
        const hdr = decodeHeader(_currentRecordBytes());
        assert.equal(hdr.valid, 0);
        assert.equal(hdr.attrsDataSize, 6); // key(1) + len(1) + 'late'(4)
    });
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
