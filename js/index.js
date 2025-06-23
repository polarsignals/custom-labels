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
            // addon.log("init: " + asyncId + ", " + triggerAsyncId + "; ");
            const parent = lsByAsyncId.get(triggerAsyncId);
            if (parent) {
                // addon.log("parent:");
                // parent.printDebug();
                lsByAsyncId.set(asyncId, new addon.LabelSetRef(parent));
            } else {
                // addon.log("no parent\n");
                lsByAsyncId.set(asyncId, new addon.LabelSetRef());
            }
        },
        before(asyncId) {
            // addon.log("before: " + asyncId + "; ");
            const x = lsByAsyncId.get(asyncId);
            if (x) {
                // x.printDebug();
                x.install();
            } else {
                // addon.log("no set\n");
            }
        },
        after(asyncId) {
            addon.clearLabelSet();
        },
        destroy(asyncId) {
            // addon.log("destroy: " + asyncId + "; ");
            // const x = lsByAsyncId.get(asyncId);
            // if (x) {
            //     x.printDebug();
            // } else {
            //     addon.log("no set\n");
            // }
            lsByAsyncId.delete(asyncId);
        },   
    });

    hook.enable();

    withLabel = function(k, v, f) {
        const xct = executionAsyncId();
        // addon.log('wl: ' + k + ' ' + v + '; xct: ' + xct + "\n");
        let ls = lsByAsyncId.get(xct);
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
        // addon.log('wl done. xct: ' + xct + "; ");
        // ls.printDebug();
        return retval;
    };
} else {
    withLabel = function(k, v, f) {
        return f();
    };
}

exports.withLabel = withLabel;
