use std::future::{Future, IntoFuture};
use std::net::SocketAddr;
use std::time::Duration;

use axum::Router;
use tokio::net::TcpListener;

/// Sits between the 150 s default chat-stream deadline and the platform's 200 s kill timeout,
/// which leaves about 10 s for Litestream's final sync once the API exits.
pub const DRAIN_CAP: Duration = Duration::from_secs(190);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Drain {
    Finished,
    CapReached,
}

/// The cap is measured from the moment `shutdown` resolves, not from startup, so a stream that
/// began just before the signal still gets the whole allowance.
pub async fn serve_until(
    listener: TcpListener,
    app: Router,
    shutdown: impl Future<Output = ()> + Send + 'static,
    drain_cap: Duration,
) -> Result<Drain, std::io::Error> {
    let (signalled_tx, signalled_rx) = tokio::sync::oneshot::channel::<()>();
    // The peer address is what login throttling keys on when no proxy is trusted.
    let serving = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        shutdown.await;
        let _ = signalled_tx.send(());
    })
    .into_future();
    tokio::pin!(serving);

    tokio::select! {
        result = &mut serving => result.map(|()| Drain::Finished),
        // The sender also drops when the shutdown future panics, and graceful shutdown then
        // starts with nothing else to bound it, so the cap must start from that moment too.
        signalled = signalled_rx => {
            if signalled.is_err() {
                tracing::error!("shutdown trigger was lost; draining with the cap from now");
            }
            tokio::select! {
                result = &mut serving => result.map(|()| Drain::Finished),
                () = tokio::time::sleep(drain_cap) => Ok(Drain::CapReached),
            }
        }
    }
}

/// Tokio keeps its handlers installed for the life of
/// the process, so later signals are swallowed instead of killing the process mid-drain.
#[cfg(unix)]
pub async fn first_termination_signal() {
    use tokio::signal::unix::{signal, SignalKind};

    let mut terminate = signal(SignalKind::terminate()).expect("install SIGTERM handler");
    let mut interrupt = signal(SignalKind::interrupt()).expect("install SIGINT handler");
    tokio::select! {
        _ = terminate.recv() => {}
        _ = interrupt.recv() => {}
    }
}

#[cfg(not(unix))]
pub async fn first_termination_signal() {
    let _ = tokio::signal::ctrl_c().await;
}
