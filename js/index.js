let withLabel;

let hook;

// function mylog(s) {
//     // fs.writeFileSync(process.stderr, s + '\n');
//     process.stderr.write(s + '\n');
// }

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
            // mylog("init: " + asyncId + ", " + triggerAsyncId);
            const parent = lsByAsyncId.get(triggerAsyncId);
            if (parent) {
                // mylog("parent:");
                // parent.printDebug();
                lsByAsyncId.set(asyncId, new addon.LabelSetRef(parent));
            } else {
                lsByAsyncId.set(asyncId, new addon.LabelSetRef());
            }
        },
        before(asyncId) {
            // mylog("before: " + asyncId);
            const x = lsByAsyncId.get(asyncId);
            if (x) {
                // x.printDebug();
                x.install();
            } else {
                // mylog("no set");
            }
        },
        after(asyncId) {
            const t = triggerAsyncId();
            // mylog("after: " + asyncId + ", t: " + t);
            const x = lsByAsyncId.get(t);
            if (x) {
                // x.printDebug();
                x.install();
            } else {
                // mylog("no set");
                addon.clearLabelSet();
            }
        },
        destroy(asyncId) {
            // mylog("destroy: " + asyncId);
            // const x = lsByAsyncId.get(asyncId);
            // if (x) {
            //     x.printDebug();
            // } else {
            //     mylog("no set");
            // }
            lsByAsyncId.delete(asyncId);
        },   
    });

    hook.enable();

    withLabel = function(k, v, f) {
        const xct = executionAsyncId();
        // mylog('wl: ' + k + ' ' + v + '; xct: ' + xct);
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
        // mylog('wl done. xct: ' + xct);
        // ls.printDebug();
        return retval;
    };
} else {
    withLabel = function(k, v, f) {
        return f();
    };
}

exports.withLabel = withLabel;
