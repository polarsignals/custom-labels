//! Example using the custom-labels adapter, which implements the original custom-labels
//! API on top of the newer OTel thread/process context APIs. For new code, prefer using
//! `otel_process_ctx` and `otel_thread_ctx` directly — see the `spin` example.

use std::time::{Duration, Instant};

use rand::distr::Alphanumeric;
use rand::RngExt;

fn rand_str() -> String {
    String::from_utf8(
        rand::rng()
            .sample_iter(Alphanumeric)
            .take(16)
            .collect::<Vec<_>>(),
    )
    .unwrap()
}

fn main() {
    let mut last_update = Instant::now();

    loop {
        otel_thread_ctx::custom_labels_adapter::with_label("l1", rand_str(), || {
            otel_thread_ctx::custom_labels_adapter::with_label("l2", rand_str(), || loop {
                if last_update.elapsed() >= Duration::from_secs(10) {
                    break;
                }
            })
        });
        last_update = Instant::now();
    }
}
