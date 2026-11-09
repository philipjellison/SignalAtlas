mod config;
mod paths;
mod presets;
mod server;
mod wspr;

use std::{net::SocketAddr, sync::Arc};

use anyhow::Context;
use config::{ConfigStore, WsprScope};
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
    let paths = paths::resolve(&paths::Inputs::from_environment())?;
    info!(
        web = %paths.web_root.display(),
        config = %paths.config.display(),
        presets = %paths.presets.display(),
        wspr_cache = %paths.wspr_cache.display(),
        data_location = paths.data_source,
        "resolved paths"
    );
    let cache_path = paths.wspr_cache;
    let endpoint = std::env::var("SIGNALATLAS_WSPR_ENDPOINT")
        .unwrap_or_else(|_| "https://db1.wspr.live/".into());
    let store = ConfigStore::load(paths.config.clone())
        .await
        .with_context(|| format!("load configuration {}", paths.config.display()))?;
    let presets = PresetStore::load(paths.presets.clone())
        .await
        .with_context(|| format!("load presets {}", paths.presets.display()))?;
    let config = store.get();
    let mut snapshot = WsprSnapshot::load(&cache_path).await;
    if snapshot.scope != config.wspr_scope
        || (config.wspr_scope == WsprScope::Callsign
            && snapshot.receiver != config.receiver_callsign)
    {
        snapshot = WsprSnapshot::pending(config.receiver_callsign.clone(), config.wspr_scope);
    }
    let state = AppState::new(store, presets, snapshot);
    let source = Arc::new(WsprLiveSource::new(endpoint)?);
    tokio::spawn(wspr::run_poller(
        source,
        state.wspr_handle(),
        state.config_handle(),
        cache_path,
        state.poll_notify(),
        state.wspr_versions(),
    ));
    let app = server::router(state, paths.web_root);
    let listener = TcpListener::bind(address).await.with_context(|| {
        format!("cannot listen on {address} (is another instance or program using the port?)")
    })?;
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
