fn main() {
    println!("cargo:rerun-if-changed=src/customlabels.cpp");
    println!("cargo:rerun-if-changed=src/customlabels.h");
    println!("cargo:rerun-if-changed=./dlist");

    cc::Build::new()
        .file("src/customlabels.cpp")
        .compile("customlabels");

    println!("cargo:rustc-link-lib=static=customlabels");
    println!("cargo:rustc-link-arg=-Wl,--dynamic-list=./dlist");

    // Generate bindings using bindgen
    let bindings = bindgen::Builder::default()
        .header("src/customlabels.h")
        .parse_callbacks(Box::new(bindgen::CargoCallbacks::new()))
        .generate()
        .expect("Unable to generate bindings");

    let out_path = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());
    bindings
        .write_to_file(out_path.join("bindings.rs"))
        .expect("Couldn't write bindings!");

    // Compile protobuf definitions
    println!("cargo:rerun-if-changed=proto/");
    std::env::set_var("PROTOC", protoc_bin_vendored::protoc_bin_path().unwrap());
    prost_build::Config::new()
        .compile_protos(
            &["proto/opentelemetry/proto/common/v1/process_context.proto"],
            &["proto/"],
        )
        .expect("Failed to compile protobuf definitions");
}
