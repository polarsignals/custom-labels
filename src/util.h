#ifndef UTIL_H
#define UTIL_H
// The point of these barriers, which prevent the compiler from
// reordering code before or after, is to make sure that we can be
// interrupted at any instruction and the profiler will see a
// consistent state.
//
// For example, if we push a new label onto our array and then
// increment `count`, we must have a barrier
// in between. Otherwise, it's possible that the compiler will
// reorder the ++n store before the code that pushes the new label.
// Then if the profiler is invoked between those two points,
// it will see the new value of `count` and possibly
// try to read gibberish.
#define BARRIER asm volatile("": : :"memory")

#endif
