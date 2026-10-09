//! Draining on shutdown: an open stream finishes, new connections are refused, and a stuck
//! request cannot hold the process past the cap.

use std::time::Duration;

use api::shutdown::{serve_until, Drain};
use axum::body::Body;
use axum::routing::get;
use axum::Router;
use futures_util::stream;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;

fn slow_stream_app() -> Router {
    Router::new().route(
        "/stream",
        get(|| async {
            let events = stream::unfold(0u8, |step| async move {
                if step == 3 {
                    return None;
                }
                tokio::time::sleep(Duration::from_millis(150)).await;
                let event = if step == 2 { "done" } else { "tick" };
                Some((
                    Ok::<_, std::convert::Infallible>(format!("event: {event}\n\n")),
                    step + 1,
                ))
            });
            Body::from_stream(events)
        }),
    )
}

fn stuck_app() -> Router {
    Router::new().route(
        "/stuck",
        get(|| async {
            std::future::pending::<()>().await;
        }),
    )
}

async fn bind() -> (TcpListener, std::net::SocketAddr) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    (listener, addr)
}

async fn open_request(addr: std::net::SocketAddr, path: &str) -> TcpStream {
    let mut conn = TcpStream::connect(addr).await.unwrap();
    conn.write_all(
        format!("GET {path} HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n").as_bytes(),
    )
    .await
    .unwrap();
    conn
}

#[tokio::test]
async fn open_stream_finishes_and_new_connections_are_refused_after_shutdown() {
    let (listener, addr) = bind().await;
    let (stop_tx, stop_rx) = oneshot::channel::<()>();
    let server = tokio::spawn(serve_until(
        listener,
        slow_stream_app(),
        async {
            let _ = stop_rx.await;
        },
        Duration::from_secs(30),
    ));

    let mut conn = open_request(addr, "/stream").await;
    let mut first = [0u8; 16];
    conn.read_exact(&mut first).await.unwrap();

    stop_tx.send(()).unwrap();
    // The listener closes as soon as the drain starts, while the stream is still open.
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        TcpStream::connect(addr).await.is_err(),
        "a new connection was accepted during the drain"
    );

    let mut rest = Vec::new();
    conn.read_to_end(&mut rest).await.unwrap();
    let text = String::from_utf8_lossy(&rest);
    assert!(text.contains("event: done"), "stream was cut off: {text}");

    let outcome = server.await.unwrap().unwrap();
    assert_eq!(outcome, Drain::Finished);
}

#[tokio::test]
async fn a_stuck_request_does_not_outlive_the_cap() {
    let (listener, addr) = bind().await;
    let (stop_tx, stop_rx) = oneshot::channel::<()>();
    let server = tokio::spawn(serve_until(
        listener,
        stuck_app(),
        async {
            let _ = stop_rx.await;
        },
        Duration::from_millis(200),
    ));

    let _stuck = open_request(addr, "/stuck").await;
    tokio::time::sleep(Duration::from_millis(100)).await;

    stop_tx.send(()).unwrap();
    let outcome = tokio::time::timeout(Duration::from_secs(5), server)
        .await
        .expect("serve future stayed alive past the cap")
        .unwrap()
        .unwrap();
    assert_eq!(outcome, Drain::CapReached);
}

#[tokio::test]
async fn the_cap_is_measured_from_the_signal_not_from_startup() {
    let (listener, _addr) = bind().await;
    let (stop_tx, stop_rx) = oneshot::channel::<()>();
    let server = tokio::spawn(serve_until(
        listener,
        stuck_app(),
        async {
            let _ = stop_rx.await;
        },
        Duration::from_millis(100),
    ));

    tokio::time::sleep(Duration::from_millis(400)).await;
    assert!(!server.is_finished(), "cap started before the signal");

    stop_tx.send(()).unwrap();
    let outcome = tokio::time::timeout(Duration::from_secs(5), server)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    // With no open connections the drain finishes at once; the cap only bounds stuck ones.
    assert_eq!(outcome, Drain::Finished);
}
