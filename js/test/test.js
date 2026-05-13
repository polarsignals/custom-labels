'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

if (process.platform !== 'linux') {
    console.log(`Skipping native tests on ${process.platform}; the addon is Linux-only.`);
    return;
}

const lib = require('..');
const { withContext, makeNamedContext, _currentRecordBytes } = lib;

const TRACE_ID_HEX = '0102030405060708090a0b0c0d0e0f10';
const SPAN_ID_HEX  = '1112131415161718';
const ROOT_ID_HEX  = '2122232425262728';

const TRACE_ID_BYTES = bytesFromHex(TRACE_ID_HEX);
const SPAN_ID_BYTES  = bytesFromHex(SPAN_ID_HEX);
const ROOT_ID_BYTES  = bytesFromHex(ROOT_ID_HEX);

function bytesFromHex(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
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

function decodeAttrs(bytes) {
    const hdr = decodeHeader(bytes);
    const out = [];
    let i = 28;
    const end = 28 + hdr.attrsDataSize;
    while (i < end) {
        const idx = bytes[i++];
        const len = bytes[i++];
        const val = Buffer.from(bytes.slice(i, i + len)).toString('utf8');
        out.push([idx, val]);
        i += len;
    }
    assert.equal(i, end, 'attrs payload must be exactly attrsDataSize bytes');
    return out;
}

function captureBytes(opts) {
    let bytes;
    withContext(() => { bytes = _currentRecordBytes(); }, opts);
    return bytes;
}

test('traceId/spanId accepted as hex strings', () => {
    const bytes = captureBytes({ traceId: TRACE_ID_HEX, spanId: SPAN_ID_HEX });
    const hdr = decodeHeader(bytes);
    assert.deepEqual(hdr.traceId, TRACE_ID_BYTES);
    assert.deepEqual(hdr.spanId, SPAN_ID_BYTES);
    assert.equal(hdr.valid, 1);
    assert.equal(hdr.reserved, 0);
    assert.equal(hdr.attrsDataSize, 0);
});

test('traceId/spanId accepted as Uint8Array', () => {
    const bytes = captureBytes({ traceId: TRACE_ID_BYTES, spanId: SPAN_ID_BYTES });
    const hdr = decodeHeader(bytes);
    assert.deepEqual(hdr.traceId, TRACE_ID_BYTES);
    assert.deepEqual(hdr.spanId, SPAN_ID_BYTES);
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

test('mixed hex and Uint8Array inputs work', () => {
    const bytes = captureBytes({ traceId: TRACE_ID_HEX, spanId: SPAN_ID_BYTES });
    const hdr = decodeHeader(bytes);
    assert.deepEqual(hdr.traceId, TRACE_ID_BYTES);
    assert.deepEqual(hdr.spanId, SPAN_ID_BYTES);
});

test('uppercase hex is accepted', () => {
    const bytes = captureBytes({
        traceId: TRACE_ID_HEX.toUpperCase(),
        spanId: SPAN_ID_HEX.toUpperCase(),
    });
    const hdr = decodeHeader(bytes);
    assert.deepEqual(hdr.traceId, TRACE_ID_BYTES);
    assert.deepEqual(hdr.spanId, SPAN_ID_BYTES);
});

test('traceId wrong length (hex) is rejected', () => {
    assert.throws(() => captureBytes({ traceId: '00', spanId: SPAN_ID_HEX }),
        /traceId must be/);
});

test('traceId wrong length (Uint8Array) is rejected', () => {
    assert.throws(() => captureBytes({ traceId: new Uint8Array(8), spanId: SPAN_ID_HEX }),
        /traceId must be/);
});

test('spanId wrong length (hex) is rejected', () => {
    assert.throws(() => captureBytes({ traceId: TRACE_ID_HEX, spanId: '00' }),
        /spanId must be/);
});

test('non-hex characters in hex string are rejected', () => {
    const bad = 'g'.repeat(32);
    assert.throws(() => captureBytes({ traceId: bad, spanId: SPAN_ID_HEX }),
        /traceId must be/);
});

test('localRootSpanId omitted leaves attrs_data empty', () => {
    const bytes = captureBytes({ traceId: TRACE_ID_HEX, spanId: SPAN_ID_HEX });
    assert.equal(decodeHeader(bytes).attrsDataSize, 0);
});

test('localRootSpanId encodes as 16-char lowercase hex at key index 0', () => {
    const bytes = captureBytes({
        traceId: TRACE_ID_HEX,
        spanId:  SPAN_ID_HEX,
        localRootSpanId: ROOT_ID_BYTES,
    });
    const attrs = decodeAttrs(bytes);
    assert.equal(attrs.length, 1);
    assert.deepEqual(attrs[0], [0, ROOT_ID_HEX]);
    // attrs_data_size == 2 (header) + 16 (hex value) = 18.
    assert.equal(decodeHeader(bytes).attrsDataSize, 18);
});

test('localRootSpanId from hex string is normalized to lowercase', () => {
    const bytes = captureBytes({
        traceId: TRACE_ID_HEX,
        spanId:  SPAN_ID_HEX,
        localRootSpanId: ROOT_ID_HEX.toUpperCase(),
    });
    assert.deepEqual(decodeAttrs(bytes)[0], [0, ROOT_ID_HEX]);
});

test('attributes encoded after the root-span entry', () => {
    const bytes = captureBytes({
        traceId: TRACE_ID_HEX,
        spanId:  SPAN_ID_HEX,
        localRootSpanId: ROOT_ID_BYTES,
        attributes: [[1, 'GET'], [2, '/api/v1/widgets']],
    });
    assert.deepEqual(decodeAttrs(bytes), [
        [0, ROOT_ID_HEX],
        [1, 'GET'],
        [2, '/api/v1/widgets'],
    ]);
});

test('attributes without localRootSpanId may use index 0', () => {
    const bytes = captureBytes({
        traceId: TRACE_ID_HEX,
        spanId:  SPAN_ID_HEX,
        attributes: [[0, 'whatever']],
    });
    assert.deepEqual(decodeAttrs(bytes), [[0, 'whatever']]);
});

test('attributes coerce non-string values via toString', () => {
    const bytes = captureBytes({
        traceId: TRACE_ID_HEX,
        spanId:  SPAN_ID_HEX,
        attributes: [[1, 42], [2, true]],
    });
    assert.deepEqual(decodeAttrs(bytes), [[1, '42'], [2, 'true']]);
});

test('value longer than 255 bytes is truncated to 255', () => {
    const long = 'x'.repeat(300);
    const bytes = captureBytes({
        traceId: TRACE_ID_HEX,
        spanId:  SPAN_ID_HEX,
        attributes: [[1, long]],
    });
    const decoded = decodeAttrs(bytes);
    assert.equal(decoded.length, 1);
    assert.equal(decoded[0][1].length, 255);
    assert.equal(decoded[0][1], 'x'.repeat(255));
});

test('attrs that would exceed the 612-byte payload are dropped at the boundary', () => {
    // Two 255-byte values: 2 * (2 + 255) = 514 bytes used.
    // A third 100-byte value would need 102 more bytes => 616 > 612, dropped.
    const a = 'a'.repeat(255);
    const b = 'b'.repeat(255);
    const c = 'c'.repeat(100);
    const bytes = captureBytes({
        traceId: TRACE_ID_HEX,
        spanId:  SPAN_ID_HEX,
        attributes: [[1, a], [2, b], [3, c]],
    });
    const decoded = decodeAttrs(bytes);
    assert.equal(decoded.length, 2);
    assert.deepEqual(decoded[0], [1, a]);
    assert.deepEqual(decoded[1], [2, b]);
    assert.equal(decodeHeader(bytes).attrsDataSize, 514);
});

test('keyIndex 0 with localRootSpanId is rejected', () => {
    assert.throws(() => captureBytes({
        traceId: TRACE_ID_HEX,
        spanId:  SPAN_ID_HEX,
        localRootSpanId: ROOT_ID_BYTES,
        attributes: [[0, 'collision']],
    }), /keyIndex 0 is reserved/);
});

test('keyIndex out of [0,255] is rejected', () => {
    for (const bad of [-1, 256, 1000, 1.5]) {
        assert.throws(() => captureBytes({
            traceId: TRACE_ID_HEX,
            spanId:  SPAN_ID_HEX,
            attributes: [[bad, 'v']],
        }), /keyIndex must be an integer in \[0, 255\]/, `bad=${bad}`);
    }
});

test('non-array attributes argument is rejected', () => {
    assert.throws(() => captureBytes({
        traceId: TRACE_ID_HEX,
        spanId:  SPAN_ID_HEX,
        attributes: { not: 'an array' },
    }), /attributes must be an array/);
});

test('malformed attribute pair is rejected', () => {
    assert.throws(() => captureBytes({
        traceId: TRACE_ID_HEX,
        spanId:  SPAN_ID_HEX,
        attributes: [[1]],
    }), /\[keyIndex, value\] pair/);
    assert.throws(() => captureBytes({
        traceId: TRACE_ID_HEX,
        spanId:  SPAN_ID_HEX,
        attributes: ['not-a-pair'],
    }), /\[keyIndex, value\] pair/);
});

test('withContext returns fn result', () => {
    const result = withContext(() => 'ok', { traceId: TRACE_ID_HEX, spanId: SPAN_ID_HEX });
    assert.equal(result, 'ok');
});

test('outside withContext, no active record', () => {
    assert.equal(_currentRecordBytes(), undefined);
});

test('after withContext returns, no active record', () => {
    withContext(() => {}, { traceId: TRACE_ID_HEX, spanId: SPAN_ID_HEX });
    assert.equal(_currentRecordBytes(), undefined);
});

test('nested withContext restores parent context after inner returns', () => {
    const outerOpts = { traceId: TRACE_ID_HEX, spanId: SPAN_ID_HEX };
    const innerSpan = 'aabbccddeeff0011';
    const innerOpts = { traceId: TRACE_ID_HEX, spanId: innerSpan };

    withContext(() => {
        const outerBefore = decodeHeader(_currentRecordBytes()).spanId;
        withContext(() => {
            const inner = decodeHeader(_currentRecordBytes()).spanId;
            assert.deepEqual(inner, bytesFromHex(innerSpan));
        }, innerOpts);
        const outerAfter = decodeHeader(_currentRecordBytes()).spanId;
        assert.deepEqual(outerBefore, outerAfter);
        assert.deepEqual(outerAfter, SPAN_ID_BYTES);
    }, outerOpts);
});

test('async work inside withContext sees same record after awaits', async () => {
    await withContext(async () => {
        const before = decodeHeader(_currentRecordBytes()).spanId;
        await Promise.resolve();
        const afterMicro = decodeHeader(_currentRecordBytes()).spanId;
        await new Promise(setImmediate);
        const afterMacro = decodeHeader(_currentRecordBytes()).spanId;
        assert.deepEqual(before, SPAN_ID_BYTES);
        assert.deepEqual(afterMicro, SPAN_ID_BYTES);
        assert.deepEqual(afterMacro, SPAN_ID_BYTES);
    }, { traceId: TRACE_ID_HEX, spanId: SPAN_ID_HEX });
});

test('concurrent async withContext calls keep contexts isolated', async () => {
    const aSpan = '1111111111111111';
    const bSpan = '2222222222222222';

    async function run(spanHex) {
        return withContext(async () => {
            const observed = [];
            for (let i = 0; i < 4; i++) {
                observed.push(decodeHeader(_currentRecordBytes()).spanId);
                await Promise.resolve();
            }
            return observed;
        }, { traceId: TRACE_ID_HEX, spanId: spanHex });
    }

    const [aObs, bObs] = await Promise.all([run(aSpan), run(bSpan)]);
    for (const s of aObs) assert.deepEqual(s, bytesFromHex(aSpan));
    for (const s of bObs) assert.deepEqual(s, bytesFromHex(bSpan));
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
    const withNamed = makeNamedContext(['root', 'http.method', 'http.route']);
    let bytes;
    withNamed(() => { bytes = _currentRecordBytes(); }, {
        traceId: TRACE_ID_HEX,
        spanId:  SPAN_ID_HEX,
        namedAttributes: { 'http.method': 'GET', 'http.route': '/x' },
    });
    assert.deepEqual(decodeAttrs(bytes), [[1, 'GET'], [2, '/x']]);
});

test('namedAttributes (Map form) resolves to indices', () => {
    const withNamed = makeNamedContext(['root', 'a', 'b']);
    let bytes;
    withNamed(() => { bytes = _currentRecordBytes(); }, {
        traceId: TRACE_ID_HEX,
        spanId:  SPAN_ID_HEX,
        namedAttributes: new Map([['a', 'A'], ['b', 'B']]),
    });
    assert.deepEqual(decodeAttrs(bytes), [[1, 'A'], [2, 'B']]);
});

test('namedAttributes (array form) resolves to indices', () => {
    const withNamed = makeNamedContext(['root', 'a', 'b']);
    let bytes;
    withNamed(() => { bytes = _currentRecordBytes(); }, {
        traceId: TRACE_ID_HEX,
        spanId:  SPAN_ID_HEX,
        namedAttributes: [['a', 'A'], ['b', 'B']],
    });
    assert.deepEqual(decodeAttrs(bytes), [[1, 'A'], [2, 'B']]);
});

test('unknown name in namedAttributes is rejected', () => {
    const withNamed = makeNamedContext(['root', 'a']);
    assert.throws(() => withNamed(() => {}, {
        traceId: TRACE_ID_HEX,
        spanId:  SPAN_ID_HEX,
        namedAttributes: { unknown: 'v' },
    }), /unknown attribute name: unknown/);
});

test('namedAttributes coerces non-string values', () => {
    const withNamed = makeNamedContext(['root', 'n']);
    let bytes;
    withNamed(() => { bytes = _currentRecordBytes(); }, {
        traceId: TRACE_ID_HEX,
        spanId:  SPAN_ID_HEX,
        namedAttributes: { n: 7 },
    });
    assert.deepEqual(decodeAttrs(bytes), [[1, '7']]);
});

test('makeNamedContext returned function passes through localRootSpanId', () => {
    const withNamed = makeNamedContext(['local_root_span_id']);
    let bytes;
    withNamed(() => { bytes = _currentRecordBytes(); }, {
        traceId: TRACE_ID_HEX,
        spanId:  SPAN_ID_HEX,
        localRootSpanId: ROOT_ID_BYTES,
    });
    assert.deepEqual(decodeAttrs(bytes), [[0, ROOT_ID_HEX]]);
});
