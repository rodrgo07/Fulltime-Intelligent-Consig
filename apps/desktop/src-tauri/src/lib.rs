mod auth;
mod commands;
mod config;
mod engine;
mod error;
mod secrets;
mod state;
mod supabase;
mod worker;

use state::{AppState, WorkerStatus};
use std::sync::Arc;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, WindowEvent};
use tauri_plugin_updater::UpdaterExt;
use tokio::sync::{Notify, RwLock};

/// Canal definido no build (CI): development | staging | production.
pub const CHANNEL: &str = match option_env!("FIC_CHANNEL") {
    Some(c) => c,
    None => "development",
};

/// Retenção dos logs técnicos locais (arquivos diários).
const LOG_RETENTION_DAYS: usize = 30;

fn init_logging(dir: &std::path::Path, level: &str) -> tracing_appender::non_blocking::WorkerGuard {
    use tracing_subscriber::EnvFilter;
    std::fs::create_dir_all(dir).ok();
    let appender = tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("fic-desktop")
        .filename_suffix("log")
        .max_log_files(LOG_RETENTION_DAYS)
        .build(dir)
        .expect("log dir");
    let (writer, guard) = tracing_appender::non_blocking(appender);
    let filter = match level { "DEBUG" => "debug", "WARNING" => "warn", "ERROR" => "error", _ => "info" };
    tracing_subscriber::fmt()
        .json()
        .with_current_span(false)
        .with_writer(writer)
        .with_env_filter(EnvFilter::new(format!("{filter},hyper=warn,reqwest=warn")))
        .init();
    guard
}

async fn quit(app: tauri::AppHandle) {
    if let Some(state) = app.try_state::<Arc<AppState>>() {
        if let Some(engine) = state.engine.read().await.clone() {
            engine.shutdown().await;
        }
    }
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| commands::show_main(app)))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();
            let paths = app.path();
            let data_dir = paths.app_local_data_dir()?;
            let log_dir = paths.app_log_dir()?;
            let config_dir = paths.app_config_dir()?;
            std::fs::create_dir_all(&data_dir)?;

            let store = config::ConfigStore::new(&config_dir);
            let cfg = store.load();
            let guard = init_logging(&log_dir, &cfg.log_level);
            app.manage(guard);
            tracing::info!(version = %app.package_info().version, channel = CHANNEL, "aplicativo iniciado");

            let state = Arc::new(AppState {
                channel: CHANNEL,
                data_dir,
                log_dir,
                config_store: store,
                config: RwLock::new(cfg.clone()),
                auth: auth::Auth::new(secrets::Secrets::new(CHANNEL)),
                sb: RwLock::new(None),
                engine: RwLock::new(None),
                status: RwLock::new(WorkerStatus { engine_state: "starting".into(), ..Default::default() }),
                wake: Notify::new(),
                engine_restart: Notify::new(),
            });
            app.manage(state.clone());

            // Bandeja: o app continua trabalhando com a janela fechada.
            let open = MenuItem::with_id(app, "open", "Abrir", true, None::<&str>)?;
            let pause = MenuItem::with_id(app, "pause", "Pausar / retomar fila", true, None::<&str>)?;
            let exit = MenuItem::with_id(app, "quit", "Sair", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &pause, &exit])?;
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().cloned().expect("icon"))
                .tooltip("Fulltime Intelligent Consig")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, ev| match ev.id().as_ref() {
                    "open" => commands::show_main(app),
                    "pause" => {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Some(st) = app.try_state::<Arc<AppState>>() {
                                let paused = !st.config.read().await.worker_paused;
                                let _ = commands::worker_set_paused(st, paused).await;
                            }
                        });
                    }
                    "quit" => {
                        tauri::async_runtime::spawn(quit(app.clone()));
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, ev| {
                    if let TrayIconEvent::DoubleClick { button: MouseButton::Left, .. } = ev {
                        commands::show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            let minimized = std::env::args().any(|a| a == "--minimized") || cfg.start_minimized;
            if minimized {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }

            tauri::async_runtime::spawn(async move {
                state.rebuild_client().await;
                if let Some(sb) = state.sb.read().await.clone() {
                    let max = state.config.read().await.session_max_hours;
                    if state.auth.resume(&sb, max).await {
                        tracing::info!("sessão do backoffice retomada");
                    }
                }
                worker::spawn_all(state.clone());
                // Verificação periódica de atualização (a cada 6 h); a instalação é sempre explícita.
                loop {
                    if let Ok(updater) = handle.updater() {
                        if let Ok(Some(u)) = updater.check().await {
                            let _ = handle.emit("update-available", u.version.clone());
                        }
                    }
                    tokio::time::sleep(Duration::from_secs(6 * 3600)).await;
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(commands::handler())
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o aplicativo");
}
