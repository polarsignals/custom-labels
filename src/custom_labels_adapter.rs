//! Minimal adapter from the original [custom-labels API](https://github.com/polarsignals/custom-labels/blob/master/custom-labels-v1.md)
//! to the newer OTel thread/process context APIs. This module shows how the two APIs
//! relate. We recommend using the new APIs directly where possible.
//!
//! # Simplifications
//!
//! - Trace and span IDs are always zeroed, since the custom-labels API manages these by
//!   convention as regular labels.

use std::{
    cell::RefCell,
    collections::HashMap,
    sync::{LazyLock, RwLock},
};

use crate::{
    opentelemetry::proto::{
        common::v1::{any_value, AnyValue, ArrayValue, KeyValue},
        processcontext::v1development::ProcessContext,
        resource::v1::Resource,
    },
    otel_thread_ctx::ThreadContext,
};

/// Global key registry: key name -> thread context key index.
/// Only grows; indices are never reused.
static KEY_REGISTRY: LazyLock<RwLock<HashMap<String, u8>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

thread_local! {
    /// Per-thread active labels: key index -> current value.
    static LABELS: RefCell<Vec<Option<String>>> = const { RefCell::new(Vec::new()) };
}

/// Look up or register `key` in the global registry. Returns the key index.
/// If a new key is registered, republishes the process context.
fn key_index(key: &str) -> u8 {
    // Fast path: key already registered.
    {
        let map = KEY_REGISTRY.read().unwrap();
        if let Some(&idx) = map.get(key) {
            return idx;
        }
    }

    // Slow path: register the key and republish.
    let mut map = KEY_REGISTRY.write().unwrap();

    // Double-check after acquiring write lock.
    if let Some(&idx) = map.get(key) {
        return idx;
    }

    assert!(
        map.len() < 256,
        "custom-labels-adapter: max 256 distinct keys"
    );
    let idx = map.len() as u8;
    map.insert(key.to_owned(), idx);

    // Build the ordered key list by sorting on index.
    let mut keys: Vec<_> = map.iter().map(|(k, &v)| (k.as_str(), v)).collect();
    keys.sort_by_key(|&(_, v)| v);
    let attribute_key_map: Vec<AnyValue> = keys
        .iter()
        .map(|(k, _)| AnyValue {
            value: Some(any_value::Value::StringValue((*k).to_owned())),
        })
        .collect();

    let ctx = ProcessContext {
        resource: Some(Resource::default()),
        extra_attributes: vec![
            KeyValue {
                key: "threadlocal.schema_version".into(),
                value: Some(AnyValue {
                    value: Some(any_value::Value::StringValue("tlsdesc_v1_dev".into())),
                }),
                ..Default::default()
            },
            KeyValue {
                key: "threadlocal.attribute_key_map".into(),
                value: Some(AnyValue {
                    value: Some(any_value::Value::ArrayValue(ArrayValue {
                        values: attribute_key_map,
                    })),
                }),
                ..Default::default()
            },
        ],
    };
    drop(map);
    let _ = crate::otel_process_ctx::publish(&ctx);

    idx
}

/// Update the thread context from the current thread-local label state.
fn sync_thread_context() {
    LABELS.with(|labels| {
        let labels = labels.borrow();
        let attrs: Vec<(u8, &str)> = labels
            .iter()
            .enumerate()
            .filter_map(|(i, v)| v.as_deref().map(|s| (i as u8, s)))
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

    // Registers the key (and republishes process context) if new.
    let idx = key_index(&key) as usize;

    // Push: save previous value and install the new one.
    let prev = LABELS.with(|labels| {
        let mut labels = labels.borrow_mut();
        if labels.len() <= idx {
            labels.resize(idx + 1, None);
        }
        labels[idx].replace(value)
    });

    sync_thread_context();
    let result = f();

    // Pop: restore previous value.
    let is_new = prev.is_none();
    LABELS.with(|labels| {
        labels.borrow_mut()[idx] = prev;
    });
    if is_new {
        // Key was freshly added — it's the last entry in attrs_data, so a cheap pop suffices.
        ThreadContext::pop_last_attr();
    } else {
        // Key had a previous value — need a full rebuild to restore it.
        sync_thread_context();
    }

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

#[cfg(test)]
#[cfg(target_os = "linux")]
mod tests {
    use prost::Message;
    use std::{
        fs::File,
        io::{BufRead, BufReader},
        ptr,
        sync::atomic::{fence, AtomicU64, Ordering},
    };

    use crate::opentelemetry::proto::{
        common::v1::any_value, processcontext::v1development::ProcessContext,
    };

    /// Layout must match the header written by otel_process_ctx.
    #[repr(C, packed)]
    struct MappingHeader {
        signature: [u8; 8],
        version: u32,
        payload_size: u32,
        monotonic_published_at_ns: u64,
        payload_ptr: *const u8,
    }

    fn find_otel_mapping() -> Option<usize> {
        let file = File::open("/proc/self/maps").ok()?;
        for line in BufReader::new(file).lines() {
            let line = line.ok()?;
            let trimmed = line.trim_end();
            let name = trimmed.split_whitespace().nth(5).unwrap_or("");
            if name.starts_with("/memfd:OTEL_CTX")
                || name.starts_with("[anon_shmem:OTEL_CTX]")
                || name.starts_with("[anon:OTEL_CTX]")
            {
                return usize::from_str_radix(trimmed.split('-').next()?, 16).ok();
            }
        }
        None
    }

    /// Read back the published ProcessContext from the live memory mapping.
    fn read_published_process_context() -> ProcessContext {
        let addr = find_otel_mapping().expect("no OTEL_CTX mapping found");
        let header: *mut MappingHeader = ptr::with_exposed_provenance_mut(addr);

        let published_at = unsafe {
            AtomicU64::from_ptr(ptr::addr_of_mut!((*header).monotonic_published_at_ns))
                .load(Ordering::Relaxed)
        };
        assert_ne!(published_at, 0, "header not initialised");
        fence(Ordering::SeqCst);

        let payload_size = unsafe { (*header).payload_size } as usize;
        let payload_ptr = unsafe { (*header).payload_ptr };
        let payload = unsafe { std::slice::from_raw_parts(payload_ptr, payload_size) };

        ProcessContext::decode(payload).expect("failed to decode ProcessContext")
    }

    /// Helper: extract a string-valued extra_attribute by key name.
    fn extra_attr_string(ctx: &ProcessContext, key: &str) -> Option<String> {
        ctx.extra_attributes
            .iter()
            .find(|kv| kv.key == key)
            .and_then(|kv| match kv.value.as_ref()?.value.as_ref()? {
                any_value::Value::StringValue(s) => Some(s.clone()),
                _ => None,
            })
    }

    /// Helper: extract the attribute_key_map array from extra_attributes.
    fn extra_attr_key_map(ctx: &ProcessContext) -> Option<Vec<String>> {
        let kv = ctx
            .extra_attributes
            .iter()
            .find(|kv| kv.key == "threadlocal.attribute_key_map")?;
        match kv.value.as_ref()?.value.as_ref()? {
            any_value::Value::ArrayValue(arr) => Some(
                arr.values
                    .iter()
                    .filter_map(|v| match v.value.as_ref()? {
                        any_value::Value::StringValue(s) => Some(s.clone()),
                        _ => None,
                    })
                    .collect(),
            ),
            _ => None,
        }
    }

    #[test]
    #[serial_test::serial]
    fn process_context_schema_and_key_map() {
        super::KEY_REGISTRY.write().unwrap().clear();
        super::LABELS.with(|l| l.borrow_mut().clear());

        super::with_label("fruit", "apple", || {
            let ctx = read_published_process_context();
            assert_eq!(
                extra_attr_string(&ctx, "threadlocal.schema_version").as_deref(),
                Some("tlsdesc_v1_dev"),
            );
            assert_eq!(
                extra_attr_key_map(&ctx).as_deref(),
                Some(&["fruit".to_string()][..]),
            );

            // Second key grows the map.
            super::with_label("veggie", "carrot", || {
                let ctx = read_published_process_context();
                let key_map = extra_attr_key_map(&ctx).expect("missing attribute_key_map");
                assert_eq!(key_map, vec!["fruit", "veggie"]);
            });
        });
        let _ = crate::otel_process_ctx::unpublish();
    }
}
