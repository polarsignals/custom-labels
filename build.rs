fn main() {
    println!("cargo:rerun-if-changed=src/lib.c");
    println!("cargo:rerun-if-changed=src/lib.h");
    
    cc::Build::new()
        .file("src/lib.c")
        .compile("clib");

    println!("cargo:rustc-link-lib=static=clib");
    
    // Generate bindings using bindgen
    let bindings = bindgen::Builder::default()
        .header("src/lib.h")
        .parse_callbacks(Box::new(bindgen::CargoCallbacks::new()))
        .generate()
        .expect("Unable to generate bindings");

    // Write the bindings to the $OUT_DIR/bindings.rs file.
    let out_path = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());
    bindings
        .write_to_file(out_path.join("bindings.rs"))
        .expect("Couldn't write bindings!");
}
