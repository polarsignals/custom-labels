use std::time::{Duration, Instant};

use rand::distributions::Alphanumeric;
use rand::Rng;

use otel_thread_ctx::otel_process_ctx::linux as process_ctx;
use otel_thread_ctx::otel_thread_ctx::linux::ThreadContext;
use otel_thread_ctx::proto::opentelemetry::proto::{
    common::v1::{
        any_value, AnyValue, ArrayValue, KeyValue, ProcessContext,
    },
    resource::v1::Resource,
};

fn rand_str() -> String {
    String::from_utf8(
        rand::thread_rng()
            .sample_iter(&Alphanumeric)
            .take(16)
            .collect::<Vec<_>>(),
    )
    .unwrap()
}

fn string_val(s: &str) -> Option<AnyValue> {
    Some(AnyValue {
        value: Some(any_value::Value::StringValue(s.to_string())),
    })
}

fn main() {
    // Build and publish process context so profilers can decode the key table.
    // Key index 0 is reserved for local_root_span_id by convention.
    // We register key index 1 = "label" in the key table via extra_attributes.
    let ctx = ProcessContext {
        resource: Some(Resource {
            attributes: vec![
                KeyValue { key: "service.name".into(), value: string_val("spin-example"), key_ref: 0 },
                KeyValue { key: "service.version".into(), value: string_val("0.5.0"), key_ref: 0 },
            ],
            dropped_attributes_count: 0,
            entity_refs: vec![],
        }),
        extra_attributes: vec![
            KeyValue {
                key: "threadlocal.schema_version".into(),
                value: string_val("tlsdesc_v1_dev"),
                key_ref: 0,
            },
            KeyValue {
                key: "threadlocal.attribute_key_map".into(),
                value: Some(AnyValue {
                    value: Some(any_value::Value::ArrayValue(ArrayValue {
                        values: vec![
                            AnyValue { value: Some(any_value::Value::StringValue("local_root_span_id".into())) },
                            AnyValue { value: Some(any_value::Value::StringValue("label".into())) },
                        ],
                    })),
                }),
                key_ref: 0,
            },
        ],
    };

    process_ctx::publish(&ctx).expect("failed to publish process context");
    println!("Process context published");

    let trace_id = [1u8; 16];
    let span_id = [2u8; 8];
    // Initial attach
    ThreadContext::new(trace_id, span_id, &[(1, &rand_str())]).attach();

    loop {
        // In-place update (no allocation)
        ThreadContext::update(trace_id, span_id, &[(1, &rand_str())]);
        std::thread::sleep(Duration::from_secs(1));
    }

    let _ = ThreadContext::detach();
    process_ctx::unpublish().expect("failed to unpublish process context");
    println!("Done");
}
