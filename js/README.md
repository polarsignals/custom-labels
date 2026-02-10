# @polarsignals/custom-labels

Node.js library for attaching arbitrary key/value labels to profiling stack traces at runtime. Labels are propagated through asynchronous operations and can be used to correlate profiling data with distributed tracing, user contexts, or any other metadata.

## Installation

```bash
npm install @polarsignals/custom-labels
```

## Requirements

- Node.js v22 or later
- Node.js v22-v23: requires `--experimental-async-context-frame` flag
- Node.js v24+: works without additional flags
- Native compilation tools (node-gyp)

## Usage

```javascript
const cl = require('@polarsignals/custom-labels');

cl.withLabels(
    () => {
        // Code executed here will have the specified labels attached
        // to all CPU profiling stack traces, including any async work
        performWork();
    },
    "username", currentUserName,
    "traceId", currentTraceId
);
```

## API

### withLabels(callback, ...labelPairs)

Executes the callback function with the specified labels attached to all CPU profiling samples. Labels are automatically propagated through asynchronous operations spawned by the callback.

**Parameters:**
- `callback` - Function to execute with labels applied
- `...labelPairs` - Alternating key/value pairs for labels. Values can be `string`, `boolean`, `number`, `null`, or `undefined` and are coerced to strings.

**Synchronous callback:**
```javascript
cl.withLabels(
    () => {
        // Synchronous work will be labeled
        processDataSync();
    },
    "username", currentUserName,
    "traceId", currentTraceId
);
```

**Async callback:**
```javascript
await cl.withLabels(
    async () => {
        // Both synchronous and asynchronous work will be labeled
        await processRequest();
    },
    "service", "api-server",
    "endpoint", "/users",
    "version", "1.2.3"
);
```

When passing an async function, `withLabels` returns a Promise that must be awaited. When passing a synchronous function, it executes immediately and returns the function's result.

## Technical Details

For technical details about the implementation, see the [blog post](https://example.com).

## License

Apache-2.0
