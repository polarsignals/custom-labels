use axum::extract::Path;
use axum::http::StatusCode;
use axum::response::Html;
use axum::routing::get;
use axum::Router;
use markdown::Options;
use rand::seq::SliceRandom;
use rand::{thread_rng, Rng};
use tokio::net::TcpListener;

#[tokio::main]
async fn main() {
    let r = Router::new().route("/{fname}", get(handler));
    let listener = TcpListener::bind("0.0.0.0:3000").await.unwrap();
    axum::serve(listener, r).await.unwrap();
}

#[cfg(debug_assertions)]
const TRIALS: usize = 100;

#[cfg(not(debug_assertions))]
const TRIALS: usize = 1000;

async fn handler(Path(fname): Path<String>) -> Result<Html<String>, StatusCode> {
    custom_labels::asynchronous::with_label("fname", fname.clone(), async move {
        async fn inner(fname: String) -> Result<Html<String>, anyhow::Error> {
            println!("{}", format!("examples/testdata/{fname}"));
            let contents = tokio::fs::read_to_string(format!("examples/testdata/{fname}")).await?;
            let mut trials = (0..TRIALS)
                .map(|i| {
                    custom_labels::with_label("trial", format!("{i}"), || {
                        markdown::to_html_with_options(&contents, &Options::gfm()).unwrap()
                    })
                })
                .collect::<Vec<_>>();

            Ok(Html(std::mem::take(
                trials.choose_mut(&mut thread_rng()).unwrap(),
            )))
        }
        inner(fname).await.map_err(|e| {
            eprintln!("Error: {e}");
            StatusCode::INTERNAL_SERVER_ERROR
        })
    })
    .await
}
