let withLabel;

let hook;

if (process.platform == 'linux') {
    const bindings = require('bindings');

    const addon = bindings('customlabels');

    const { createHook, executionAsyncId, triggerAsyncId, AsyncResource } = require( 'node:async_hooks');
    const { writeSync }  = require( 'fs');
    const { inspect }  = require( 'util');

    const begin = Date.now();

    const lsByAsyncId = new Map();

    hook = createHook({
        init(asyncId, type, triggerAsyncId, resource) {
            const parent = lsByAsyncId.get(triggerAsyncId);
            if (parent) {
                lsByAsyncId.set(asyncId, new addon.LabelSetRef(parent));
            } else {
                lsByAsyncId.set(asyncId, new addon.LabelSetRef());
            }
        },
        before(asyncId) {
            const x = lsByAsyncId.get(asyncId);
            if (x) {
                x.install();
            }
        },
        after(asyncId) {
            const t = triggerAsyncId();
            const x = lsByAsyncId.get(t);
            if (x) {
                x.install();
            } else {
                addon.clearLabelSet();
            }
        },
        destroy(asyncId) {
            lsByAsyncId.delete(asyncId);
        },   
    });

    hook.enable();

    withLabel = function(k, v, f) {
        let ls = lsByAsyncId.get(executionAsyncId());
        if (!ls) {
            ls = new addon.LabelSetRef();
            lsByAsyncId.set(executionAsyncId, ls);
            ls.install();
        }
        const old = ls.getValue(k);
        ls.setValue(k, v);
        const retval = f();
        if (old) {
            ls.setValue(k, old);
        } else {
            ls.deleteValue(k);
        }
        return retval;
    };
} else {
    withLabel = function(k, v, f) {
        return f();
    };
}

exports.withLabel = withLabel;
