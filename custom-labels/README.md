# custom-labels

Compatibility shim for the original `custom-labels` Rust API, backed by the newer
`otel-thread-ctx` OpenTelemetry thread/process context implementation.

New integrations should prefer using `otel-thread-ctx` directly. This crate exists so existing
Rust users of the custom-labels adapter can keep using `custom_labels::{with_label, with_labels}`
with minimal code changes.
