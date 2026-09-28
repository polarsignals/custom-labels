'use strict';

// Reports how this process sees AsyncContextFrame, for async-context-frame.js
// to compare against how the flags reached it. Also reports execArgv, so a
// failure shows whether the flag was visible there at all.

const { _isAsyncContextFrameActive } = require('..');

process.send({
    active: _isAsyncContextFrameActive(),
    execArgv: process.execArgv,
});
