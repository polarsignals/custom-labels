mod c {
    include!(concat!(env!("OUT_DIR"), "/bindings.rs"));
}

pub use c::custom_labels_string_t as String;
pub use c::custom_labels_label_t as Label;

impl<'a> From<&'a [u8]> for self::String {
    fn from(value: &'a [u8]) -> Self {
        Self {
            len: value.len(),
            buf: value.as_ptr(),
        }
    }
}

pub use c::custom_labels_get as get;
pub use c::custom_labels_set as set;
pub use c::custom_labels_delete as delete;
