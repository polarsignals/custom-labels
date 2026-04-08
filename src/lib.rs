//! # OTel Thread Context
//!
//! This library provides a mechanism for OpenTelemetry SDKs to publish
//! thread-level attributes for out-of-process readers such as the
//! OpenTelemetry eBPF profilers.

/// Generated protobuf types for OTel process context.
pub mod opentelemetry {
    pub mod proto {
        pub mod common {
            pub mod v1 {
                include!(concat!(env!("OUT_DIR"), "/opentelemetry.proto.common.v1.rs"));
            }
        }
        pub mod processcontext {
            pub mod v1development {
                include!(concat!(env!("OUT_DIR"), "/opentelemetry.proto.processcontext.v1development.rs"));
            }
        }
        pub mod resource {
            pub mod v1 {
                include!(concat!(env!("OUT_DIR"), "/opentelemetry.proto.resource.v1.rs"));
            }
        }
    }
}

pub mod otel_process_ctx;
pub mod otel_thread_ctx;

/// Utilities for build scripts
pub mod build {
    /// Emit the instructions required for an
    /// executable to expose custom labels data.
    pub fn emit_build_instructions() {
        #[cfg(target_os = "linux")]
        {
            let dlist_path = format!("{}/dlist", std::env::var("OUT_DIR").unwrap());
            std::fs::write(&dlist_path, include_str!("../dlist")).unwrap();
            println!("cargo:rustc-link-arg=-Wl,--dynamic-list={}", dlist_path);
        }
    }
}
