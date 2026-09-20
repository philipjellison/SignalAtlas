mod config;
mod presets;
mod server;
mod wspr;

use std::{net::SocketAddr, path::PathBuf, sync::Arc};

use anyhow::Context;
use config::ConfigStore;
use presets::PresetStore;
use server::AppState;
use tokio::net::TcpListener;
use tracing::info;
use tracing_subscriber::EnvFilter;
use wspr::{WsprLiveSource, WsprSnapshot};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "signalatlas=info,tower_http=info".into()),
        )
        .init();

    let bind = std::env::var("SIGNALATLAS_BIND").unwrap_or_else(|_| "0.0.0.0:3000".into());
    let address: SocketAddr = bind
        .parse()
        .context("SIGNALATLAS_BIND must be an IP address and port")?;
    let config_path = std::env::var_os("SIGNALATLAS_CONFIG")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("data/config.json"));
    let preset_path = std::env::var_os("SIGNALATLAS_PRESETS")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            config_path
                .parent()
                .unwrap_or_else(|| std::path::Path::new("data"))
                .join("presets.json")
        });

    let cache_path = std::env::var_os("SIGNALATLAS_WSPR_CACHE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("data/wspr-cache.json"));
    let endpoint = std::env::var("SIGNALATLAS_WSPR_ENDPOINT")
        .unwrap_or_else(|_| "https://db1.wspr.live/".into());
    let store = ConfigStore::load(config_path).await?;
    let presets = PresetStore::load(preset_path).await?;
    let snapshot = WsprSnapshot::load(&cache_path).await;
    let state = AppState::new(store, presets, snapshot);
    let source = Arc::new(WsprLiveSource::new(endpoint)?);
    tokio::spawn(wspr::run_poller(
        source,
        state.wspr_handle(),
        state.config_handle(),
        cache_path,
        state.poll_notify(),
    ));
    let app = server::router(state, PathBuf::from("web"));
    let listener = TcpListener::bind(address).await?;
    info!(%address, "SignalAtlas is ready");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("install Ctrl-C handler")
    };
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = terminate => {} }
}
