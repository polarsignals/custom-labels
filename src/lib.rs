//! # Custom labels for profilers.
//!
//! ## Overview
//!
//! This library provides Rust bindings to [v1 of the Custom Labels ABI](../custom-labels-v1.md).
//!
//! It allows time ranges within a thread's execution to be annotated with labels (key/value pairs) in such a way
//! that the labels are visible to a CPU profiler that may
//! interrupt the running process at any time. The profiler can then report the labels
//! that were active at any given time in the profiles it produces.
//!
//! The main interface is [`with_label`], which sets a label to a provided value,
//! executes a function, and then resets the label to its old value (or removes it if there was no old value).
//!
//! For example, imagine a program that performs database queries on behalf of a user. It might have a function
//! like the following:
//!
//! ```rust
//! # struct DbResultSet;
//! #
//! # fn do_query(sql: &str) -> DbResultSet {
//! #     DbResultSet
//! # }
//! #
//! fn query_for_user(username: &str, sql: &str) -> DbResultSet {
//!     custom_labels::with_label("username", username, || do_query(sql))
//! }
//! ```
//!
//! If two users named "Marta" and "Petros" repeatedly query the database, a profiler might produce a
//! CPU profile like the following:
//! ```text
//! * all (13.4s)
//! |
//! +---- username: Marta (4.9s)
//! |   |
//! |   +---- query_for_user (4.9s)
//! |       |
//! |       + ---- custom_labels::with_label (4.9s)
//! |            |
//! |            + ---- do_query (4.9s)
//! |
//! +---- username: Petros (8.5s)
//!     |
//!     +---- query_for_user (8.5s)
//!         |
//!         + ---- custom_labels::with_label (8.5s)
//!              |
//!              + ---- do_query (8.5s)
//! ```
//!
//! ## Profiler Support
//!
//! The following profilers can make use of the labels set with this library:
//! * [Parca](parca.dev) (when using parca-agent v0.33.0 and later)
//! * [Polar Signals Cloud](https://www.polarsignals.com) (when using parca-agent v0.33.0 and later).
//!
//! If you work on another profiler that also supports this format, [send us a PR](https://github.com/polarsignals/custom-labels)
//! to update this list!

use std::ptr::{null_mut, NonNull};
use std::{fmt, slice};

/// Low-level interface to the underlying C library.
pub mod sys {
    #[allow(non_camel_case_types)]
    #[allow(dead_code)]
    mod c {
        include!(concat!(env!("OUT_DIR"), "/bindings.rs"));
    }

    pub use c::custom_labels_label_t as Label;
    pub use c::custom_labels_labelset_t as Labelset;
    pub use c::custom_labels_string_t as String;

    impl<'a> From<&'a [u8]> for self::String {
        fn from(value: &'a [u8]) -> Self {
            Self {
                len: value.len(),
                buf: value.as_ptr(),
            }
        }
    }

    impl self::String {
        pub fn to_owned(&self) -> OwnedString {
            unsafe {
                let buf = libc::malloc(self.len);
                if buf.is_null() {
                    panic!("Out of memory");
                }
                libc::memcpy(buf, self.buf as *const _, self.len);
                OwnedString(Self {
                    len: self.len,
                    buf: buf as *mut _,
                })
            }
        }
    }

    pub struct OwnedString(self::String);

    impl OwnedString {
        /// Creates a new empty owned string.
        pub fn new() -> Self {
            OwnedString(self::String {
                len: 0,
                buf: std::ptr::null(),
            })
        }
    }

    impl std::ops::Deref for OwnedString {
        type Target = self::String;

        fn deref(&self) -> &Self::Target {
            &self.0
        }
    }

    impl std::ops::DerefMut for OwnedString {
        fn deref_mut(&mut self) -> &mut Self::Target {
            &mut self.0
        }
    }

    impl Drop for OwnedString {
        fn drop(&mut self) {
            unsafe {
                libc::free(self.0.buf as *mut _);
            }
        }
    }

    pub use c::custom_labels_clone as clone;
    pub use c::custom_labels_current as current;
    pub use c::custom_labels_debug_string as debug_string;
    pub use c::custom_labels_delete as delete;
    pub use c::custom_labels_free as free;
    pub use c::custom_labels_get as get;
    pub use c::custom_labels_new as new;
    pub use c::custom_labels_replace as replace;
    pub use c::custom_labels_run_with as run_with;
    pub use c::custom_labels_set as set;

    pub mod careful {
        pub use super::c::custom_labels_careful_delete as delete;
        pub use super::c::custom_labels_careful_run_with as run_with;
        pub use super::c::custom_labels_careful_set as set;
    }
}

/// Utilities for build scripts
pub mod build {
    /// Emit the instructions required for an
    /// executable to expose custom labels data.
    pub fn emit_build_instructions() {
        let dlist_path = format!("{}/dlist", std::env::var("OUT_DIR").unwrap());
        std::fs::write(&dlist_path, include_str!("../dlist")).unwrap();
        println!("cargo:rustc-link-arg=-Wl,--dynamic-list={}", dlist_path);
    }
}

/// A set of key-value labels that can be installed as the current label set.
pub struct Labelset {
    raw: NonNull<sys::Labelset>,
}

unsafe impl Send for Labelset {}

impl Labelset {
    /// Create a new label set.
    pub fn new() -> Self {
        Self::with_capacity(0)
    }

    /// Create a new label set with the specified capacity.
    pub fn with_capacity(capacity: usize) -> Self {
        let raw = unsafe { sys::new(capacity) };
        let raw = NonNull::new(raw).expect("failed to allocate labelset");
        Self { raw }
    }

    /// Create a new label set by cloning the current one, if it exists,
    /// or creating a new one otherwise.
    pub fn clone_from_current() -> Self {
        Self::try_clone_from_current().unwrap_or_default()
    }

    /// Create a new label set by cloning the current one, if it exists,
    pub fn try_clone_from_current() -> Option<Self> {
        let raw = unsafe { sys::current() };
        if raw.is_null() {
            None
        } else {
            let raw = unsafe { sys::clone(raw) };
            let raw = NonNull::new(raw).expect("failed to clone labelset");
            Some(Self { raw })
        }
    }

    /// Run a function with this set of labels applied.
    pub fn enter<F, Ret>(&mut self, f: F) -> Ret
    where
        F: FnOnce() -> Ret,
    {
        struct Guard {
            old: *mut sys::Labelset,
        }

        impl Drop for Guard {
            fn drop(&mut self) {
                unsafe { sys::replace(self.old) };
            }
        }

        let old = unsafe { sys::replace(self.raw.as_ptr()) };
        let _guard = Guard { old };
        f()
    }

    /// Adds the specified key-value pair to the label set.
    pub fn set<K, V>(&mut self, key: K, value: V)
    where
        K: AsRef<[u8]>,
        V: AsRef<[u8]>,
    {
        let errno = unsafe {
            sys::set(
                self.raw.as_ptr(),
                key.as_ref().into(),
                value.as_ref().into(),
                null_mut(),
            )
        };
        if errno != 0 {
            panic!("out of memory");
        }
    }

    /// Deletes the specified label, if it exists, from the label set.
    pub fn delete<K>(&mut self, key: K)
    where
        K: AsRef<[u8]>,
    {
        unsafe { sys::delete(self.raw.as_ptr(), key.as_ref().into()) }
    }

    /// Gets the label corresponding to a key on the given label set,
    /// or `None` if no such label exists.
    pub fn get<K>(&self, key: K) -> Option<&[u8]>
    where
        K: AsRef<[u8]>,
    {
        unsafe {
            sys::get(self.raw.as_ptr(), key.as_ref().into())
                .as_ref()
                .map(|lbl| slice::from_raw_parts(lbl.value.buf, lbl.value.len))
        }
    }
}

impl Default for Labelset {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for Labelset {
    fn drop(&mut self) {
        unsafe { sys::free(self.raw.as_ptr()) }
    }
}

impl Clone for Labelset {
    fn clone(&self) -> Self {
        let raw = unsafe { sys::clone(self.raw.as_ptr()) };
        let raw = NonNull::new(raw).expect("failed to clone labelset");
        Self { raw }
    }
}

impl<K, V> Extend<(K, V)> for Labelset
where
    K: AsRef<[u8]>,
    V: AsRef<[u8]>,
{
    fn extend<T: IntoIterator<Item = (K, V)>>(&mut self, iter: T) {
        for (k, v) in iter {
            self.set(k, v);
        }
    }
}

impl fmt::Debug for Labelset {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        debug_labelset(f, self.raw.as_ptr())
    }
}

fn debug_labelset(f: &mut fmt::Formatter<'_>, labelset: *const sys::Labelset) -> fmt::Result {
    let mut cstr = sys::OwnedString::new();
    let errno = unsafe { sys::debug_string(labelset, &mut *cstr) };
    if errno != 0 {
        panic!("out of memory");
    }
    let bytes = unsafe { slice::from_raw_parts(cstr.buf, cstr.len) };
    let str = String::from_utf8_lossy(bytes);
    f.write_str(&str)
}

/// The active label set for the current thread.
pub const CURRENT_LABELSET: CurrentLabelset = CurrentLabelset { _priv: () };

/// The type of [`CURRENT_LABELSET`].
pub struct CurrentLabelset {
    _priv: (),
}

impl CurrentLabelset {
    /// Adds the specified key-value pair to the current label set.
    ///
    /// # Panics
    ///
    /// Panics if there is no current label set.
    pub fn set<K, V>(&self, key: K, value: V)
    where
        K: AsRef<[u8]>,
        V: AsRef<[u8]>,
    {
        if unsafe { sys::current() }.is_null() {
            panic!("no current label set");
        }
        let errno = unsafe {
            sys::set(
                sys::current(),
                key.as_ref().into(),
                value.as_ref().into(),
                null_mut(),
            )
        };
        if errno != 0 {
            panic!("out of memory");
        }
    }

    /// Deletes the specified label, if it exists, from the current label set.
    pub fn delete<K>(&self, key: K)
    where
        K: AsRef<[u8]>,
    {
        unsafe { sys::delete(sys::current(), key.as_ref().into()) }
    }

    /// Gets the label corresponding to a key on the current label set,
    /// or `None` if no such label exists.
    pub fn get<K>(&self, key: K) -> Option<Vec<u8>>
    where
        K: AsRef<[u8]>,
    {
        unsafe {
            sys::get(sys::current(), key.as_ref().into())
                .as_ref()
                .map(|lbl| {
                    let v = slice::from_raw_parts(lbl.value.buf, lbl.value.len);
                    v.to_vec()
                })
        }
    }
}

impl fmt::Debug for CurrentLabelset {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let current = unsafe { sys::current() };
        if current.is_null() {
            panic!("no current labelset");
        }
        debug_labelset(f, current)
    }
}

/// Set the label for the specified key to the specified
/// value while the given function is running.
///
/// All labels are thread-local: setting a label on one thread
/// has no effect on its value on any other thread.
// TODO: rewrite this to use custom_labels_run_with, via
// https://docs.rs/ffi_helpers/latest/ffi_helpers/fn.split_closure.html
pub fn with_label<K, V, F, Ret>(k: K, v: V, f: F) -> Ret
where
    K: AsRef<[u8]>,
    V: AsRef<[u8]>,
    F: FnOnce() -> Ret,
{
    unsafe {
        if sys::current().is_null() {
            let l = sys::new(0);
            sys::replace(l);
        }
    }
    struct Guard<'a> {
        k: &'a [u8],
        old_v: Option<sys::OwnedString>,
    }

    impl<'a> Drop for Guard<'a> {
        fn drop(&mut self) {
            if let Some(old_v) = std::mem::take(&mut self.old_v) {
                let errno = unsafe { sys::set(sys::current(), self.k.into(), *old_v, null_mut()) };
                if errno != 0 {
                    panic!("corruption in custom labels library: errno {errno}");
                }
            } else {
                unsafe { sys::delete(sys::current(), self.k.into()) };
            }
        }
    }

    let old_v = unsafe { sys::get(sys::current(), k.as_ref().into()).as_ref() }
        .map(|lbl| lbl.value.to_owned());
    let _g = Guard {
        k: k.as_ref(),
        old_v,
    };

    let errno = unsafe {
        sys::set(
            sys::current(),
            k.as_ref().into(),
            v.as_ref().into(),
            null_mut(),
        )
    };
    if errno != 0 {
        panic!("corruption in custom labels library: errno {errno}")
    }

    f()
}

/// Set the labels for the specified keys to the specified
/// values while the given function is running.
///
/// `i` is an iterator of key-value pairs.
///
/// The effect is the same as repeatedly nesting calls to the singular [`with_label`].
// TODO: rewrite this to use custom_labels_run_with, via
// https://docs.rs/ffi_helpers/latest/ffi_helpers/fn.split_closure.html
pub fn with_labels<I, K, V, F, Ret>(i: I, f: F) -> Ret
where
    I: IntoIterator<Item = (K, V)>,
    K: AsRef<[u8]>,
    V: AsRef<[u8]>,
    F: FnOnce() -> Ret,
{
    let mut i = i.into_iter();
    if let Some((k, v)) = i.next() {
        with_label(k, v, || with_labels(i, f))
    } else {
        f()
    }
}

pub mod asynchronous {
    use pin_project_lite::pin_project;
    use std::future::Future;
    use std::iter;
    use std::pin::Pin;
    use std::task::{Context, Poll};

    use crate::Labelset;

    pin_project! {
        /// A [`Future`] with custom labels attached.
        ///
        /// This type is returned by the [`Label`] extension trait. See that
        /// trait's documentation for details.
        pub struct Labeled<Fut> {
            #[pin]
            inner: Fut,
            labelset: Labelset,
        }
    }

    impl<Fut, Ret> Future for Labeled<Fut>
    where
        Fut: Future<Output = Ret>,
    {
        type Output = Ret;

        fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
            let p = self.project();
            p.labelset.enter(|| p.inner.poll(cx))
        }
    }

    /// Attaches custom labels to a [`Future`].
    pub trait Label: Sized {
        /// Attach the currently active labels to the future.
        ///
        /// This can be used to propagate the current labels when spawning
        /// a new future.
        fn with_current_labels(self) -> Labeled<Self>;

        /// Attach a single label to the future.
        ///
        /// This is equivalent to calling [`with_labels`] with an iterator that
        /// yields a single key–value pair.
        fn with_label<K, V>(self, k: K, v: V) -> Labeled<Self>
        where
            K: AsRef<[u8]>,
            V: AsRef<[u8]>;

        /// Attaches the specified labels to the future.
        ///
        /// The labels will be installed in the current thread whenever the
        /// future is polled, and removed when the poll completes.
        ///
        /// This is equivalent to calling [`with_labelset`] with a label
        /// set constructed like so:
        ///
        /// ```rust
        /// # use custom_labels::Labelset;
        /// let mut labelset = Labelset::clone_from_current();
        /// labelset.extend(i);
        /// ```
        fn with_labels<I, K, V>(self, i: I) -> Labeled<Self>
        where
            I: IntoIterator<Item = (K, V)>,
            K: AsRef<[u8]>,
            V: AsRef<[u8]>;

        /// Attaches the specified labelset to the future.
        ///
        /// The labels in the set will be installed in the current thread
        /// whenever the future is polled, and removed when the poll completes.
        fn with_labelset(self, labelset: Labelset) -> Labeled<Self>;
    }

    impl<Fut: Future> Label for Fut {
        fn with_current_labels(self) -> Labeled<Self> {
            self.with_labels(iter::empty::<(&[u8], &[u8])>())
        }

        fn with_label<K, V>(self, k: K, v: V) -> Labeled<Self>
        where
            K: AsRef<[u8]>,
            V: AsRef<[u8]>,
        {
            self.with_labels(iter::once((k, v)))
        }

        fn with_labels<I, K, V>(self, iter: I) -> Labeled<Self>
        where
            I: IntoIterator<Item = (K, V)>,
            K: AsRef<[u8]>,
            V: AsRef<[u8]>,
        {
            let mut labelset = Labelset::clone_from_current();
            labelset.extend(iter);
            Labeled {
                inner: self,
                labelset,
            }
        }

        fn with_labelset(self, labelset: Labelset) -> Labeled<Self> {
            Labeled {
                inner: self,
                labelset,
            }
        }
    }
}
