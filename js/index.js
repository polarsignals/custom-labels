let withLabel;

let hook;

if (process.platform == 'linux') {
    const bindings = require('bindings');

    const addon = bindings('customlabels');

    const { createHook, executionAsyncId, triggerAsyncId, AsyncResource } = require( 'node:async_hooks');

    const lsByAsyncId = new Map();

    function ensureHook() {
        if (!hook) {
            hook = createHook({
                init(asyncId, type, triggerAsyncId, resource) {
                    addon.propagate(triggerAsyncId, asyncId);
                },
                destroy(asyncId) {
                    addon.destroy(asyncId);
                },
            });

            hook.enable();
        }
    }

    withLabels = function(f, ...kvs) {
        ensureHook();
        const id = executionAsyncId();
        return addon.withLabelsInternal(id, f, ...kvs);
    };
} else {
    withLabels = function(f, ...kvs) {
        return f();
    };
}

exports.withLabels = withLabels;
