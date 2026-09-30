'use strict';

// Reports how this process sees AsyncContextFrame, for async-context-frame.js
// to compare against how the child was launched.

const { _isAsyncContextFrameActive } = require('..');

process.send({ active: _isAsyncContextFrameActive() });
