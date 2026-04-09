//! Minimal adapter from the original [custom-labels API](https://github.com/polarsignals/custom-labels/blob/master/custom-labels-v1.md)
//! to the newer OTel thread/process context APIs. This module shows how the two APIs
//! relate. We recommend using the new APIs directly where possible.
//!
//! # Simplifications
//!
//! - A new process context is published on every label change (push and pop). A production
//!   implementation would only republish the key table when new keys appear.
//! - Trace and span IDs are always zeroed, since the custom-labels API manages these by convention as
//!   regular labels.

use std::cell::RefCell;

use crate::{
    opentelemetry::proto::{
        common::v1::{any_value, AnyValue, KeyValue},
        processcontext::v1development::ProcessContext,
        resource::v1::Resource,
    },
    otel_thread_ctx::ThreadContext,
};

thread_local! {
    /// Per-thread active labels as key-value pairs.
    static LABELS: RefCell<Vec<(String, String)>> = const { RefCell::new(Vec::new()) };
}

/// Publish a process context containing the current labels, and update the thread
/// context with zeroed trace/span IDs.
fn sync() {
    LABELS.with(|labels| {
        let labels = labels.borrow();

        // Publish the full label set as process context attributes.
        let extra_attributes: Vec<KeyValue> = labels
            .iter()
            .map(|(k, v)| KeyValue {
                key: k.clone(),
                value: Some(AnyValue {
                    value: Some(any_value::Value::StringValue(v.clone())),
                }),
                ..Default::default()
            })
            .collect();

        let ctx = ProcessContext {
            resource: Some(Resource::default()),
            extra_attributes,
        };
        let _ = crate::otel_process_ctx::publish(&ctx);

        // Mirror labels into the thread context, using position as the key index.
        let attrs: Vec<(u8, &str)> = labels
            .iter()
            .enumerate()
            .map(|(i, (_, v))| (i as u8, v.as_str()))
            .collect();
        ThreadContext::update([0u8; 16], [0u8; 8], &attrs);
    });
}

/// Set label `k` to `v` for the duration of `f`, then restore the previous value.
///
/// All labels are thread-local: setting a label on one thread has no effect on any other.
pub fn with_label<K, V, F, Ret>(k: K, v: V, f: F) -> Ret
where
    K: AsRef<[u8]>,
    V: AsRef<[u8]>,
    F: FnOnce() -> Ret,
{
    let key = String::from_utf8_lossy(k.as_ref()).into_owned();
    let value = String::from_utf8_lossy(v.as_ref()).into_owned();

    // Push: save previous value (if any) and install the new one.
    let prev = LABELS.with(|labels| {
        let mut labels = labels.borrow_mut();
        match labels.iter().position(|(k, _)| *k == key) {
            Some(pos) => Some(std::mem::replace(&mut labels[pos].1, value)),
            None => {
                labels.push((key.clone(), value));
                None
            }
        }
    });

    sync();
    let result = f();

    // Pop: restore previous value or remove the entry.
    LABELS.with(|labels| {
        let mut labels = labels.borrow_mut();
        if let Some(pos) = labels.iter().position(|(k, _)| *k == key) {
            if let Some(old) = &prev {
                labels[pos].1 = old.clone();
            } else {
                labels.remove(pos);
            }
        }
    });
    sync();

    result
}

/// Set multiple labels for the duration of `f`. Equivalent to nested [`with_label`] calls.
pub fn with_labels<I, K, V, F, Ret>(i: I, f: F) -> Ret
where
    I: IntoIterator<Item = (K, V)>,
    K: AsRef<[u8]>,
    V: AsRef<[u8]>,
    F: FnOnce() -> Ret,
{
    let mut iter = i.into_iter();
    if let Some((k, v)) = iter.next() {
        with_label(k, v, || with_labels(iter, f))
    } else {
        f()
    }
}
