use tracing::{span, Subscriber};
use tracing_opentelemetry::OtelData;
use tracing_subscriber::{
    registry::{LookupSpan, SpanRef},
    Layer,
};

use crate::Labelset;

pub struct ClTracingLayer<F> {
    f: F,
}

struct LabelsData<const OLD: bool>(Option<Labelset>);

impl<F> ClTracingLayer<F> {
    fn replace<S, const OLD: bool>(id: &span::Id, ctx: tracing_subscriber::layer::Context<'_, S>)
    where
        S: Subscriber + for<'span> LookupSpan<'span>,
    {
        let span = ctx.span(id).expect("Span not found, this is a bug");
        let Some(LabelsData(ls)) = span.extensions_mut().remove::<LabelsData<OLD>>() else {
            return;
        };

        let old = ls.and_then(Labelset::swap);

        if OLD {
            span.extensions_mut().insert(LabelsData::<false>(old));
        } else {
            span.extensions_mut().insert(LabelsData::<true>(old));
        }
    }
}

impl<S, F, I> Layer<S> for ClTracingLayer<F>
where
    S: Subscriber + for<'span> LookupSpan<'span>,
    I: IntoIterator<Item = (&'static str, String)>,
    F: Fn(&SpanRef<'_, S>) -> I + Send + Sync + 'static,
{
    fn on_new_span(
        &self,
        _attrs: &span::Attributes<'_>,
        id: &span::Id,
        ctx: tracing_subscriber::layer::Context<'_, S>,
    ) {
        let span = ctx.span(id).expect("Span not found, this is a bug");
        let mut ls = Labelset::clone_from_current();
        let labels = (self.f)(&span);
        for (k, v) in labels {
            ls.set(k, v);
        }
        let data = LabelsData::<false>(Some(ls));

        span.extensions_mut().insert(data);
    }
    fn on_enter(&self, id: &span::Id, ctx: tracing_subscriber::layer::Context<'_, S>) {
        Self::replace::<S, false>(id, ctx);
    }

    fn on_exit(&self, id: &span::Id, ctx: tracing_subscriber::layer::Context<'_, S>) {
        Self::replace::<S, true>(id, ctx);
    }
}

/// Creates a Tracing layer that applies the OTEL trace_id and span_id as custom
/// labels whenever it is entered.
pub fn otel_trace_span_layer<S: Subscriber + for<'span> LookupSpan<'span>>(
) -> ClTracingLayer<impl Fn(&SpanRef<'_, S>) -> Vec<(&'static str, String)>> {
    ClTracingLayer {
        f: |span: &SpanRef<_>| {
            let mut labels = Vec::new();

            if let Some(data) = span.extensions().get::<OtelData>() {
                if let Some(span_id) = data.builder.span_id {
                    let s = format!("{span_id}");
                    labels.push(("span_id", s))
                }
                if let Some(trace_id) = data.builder.trace_id {
                    let s = format!("{trace_id}");
                    labels.push(("trace_id", s))
                }
            }
            labels
        },
    }
}
