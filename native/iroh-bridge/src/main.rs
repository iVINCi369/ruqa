//! iroh-bridge — транспортный сайдкар для Ruqa.
//!
//! Поднимает iroh Endpoint и мостит каждый QUIC bi-stream в отдельное локальное
//! TCP-соединение, чтобы JS-сторона (Bare worklet / Electron main) могла говорить
//! своим протоколом, не умея Node-API.
//!
//! Протокол моста (TCP, 127.0.0.1), первая строка от клиента — JSON:
//!   {"op":"control"}                        — канал событий
//!   {"op":"join","role":"host"}             — поднять хост; ответ несёт код
//!   {"op":"join","topic":hex,"role":"host"} — снова хостить свой прежний код
//!   {"op":"join","topic":hex,"role":"guest"}— подключиться к коду
//!   {"op":"leave"}                          — закрыть Endpoint
//!   {"op":"open"}                           — открыть новый bi-stream к пиру
//!   {"op":"attach","id":N}                  — принять входящий bi-stream N
//!
//! Локальная сеть (соседи без кода, отдельный Endpoint на ключе устройства):
//!   {"op":"lan-start","secret":hex,"userData":str} — светиться и слушать
//!   {"op":"lan-stop"}                              — погасить
//!   {"op":"lan-invite","endpointId":..,"topic":hex,...} — позвать соседа
//!   {"op":"lan-respond","requestId":N,"response":"accepted"|"declined"}
//!
//! События о путях: {"event":"conn-type","connectionType":"direct"|"relay"} —
//! каким путём реально идут данные прямо сейчас.
//! Сервер отвечает одной строкой {"ok":true,...}, дальше — сырой поток.
//!
//! У каждой операции есть необязательное поле `"session"` (по умолчанию
//! "default"). Сессия — это отдельный Endpoint со своей личностью и своим
//! набором стримов: передача файлов и сопряжение устройств идут одновременно и
//! не должны выбивать друг друга. Все события несут то же поле `session`,
//! клиент обязан отбирать свои.

mod lan;

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::{Context, Result, anyhow};
use iroh::endpoint::{Connection, RecvStream, SendStream, presets};
use iroh::{Endpoint, EndpointAddr, RelayMode, SecretKey, TransportAddr};
use futures_lite::StreamExt;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Mutex, broadcast, watch};

const ALPN: &[u8] = b"ruqa/drive/1";
const BINDING_LABEL: &[u8] = b"ruqa/channel-binding";

struct Args {
    bridge_port: u16,
    offline: bool,
    mdns: bool,
}

fn parse_args() -> Result<Args> {
    let mut a = Args { bridge_port: 0, offline: false, mdns: false };
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let mut i = 0;
    while i < argv.len() {
        match argv[i].as_str() {
            "--bridge-port" => {
                a.bridge_port = argv[i + 1].parse()?;
                i += 2;
            }
            "--offline" => {
                a.offline = true;
                i += 1;
            }
            "--mdns" => {
                a.mdns = true;
                i += 1;
            }
            other => return Err(anyhow!("unknown arg {other}")),
        }
    }
    Ok(a)
}

/// Join-код — это ПУБЛИЧНЫЙ ключ хоста (EndpointId, 32 байта, 64 hex).
///
/// Секретный ключ хост генерирует случайно на каждый код и никому не отдаёт,
/// поэтому знание кода не даёт возможности хостом притвориться: гость
/// подключается к EndpointId из кода, а TLS у iroh проверяет, что на другом
/// конце владелец этого ключа. Разбор в claude/join-code-identity.md.
///
/// Секреты живут в памяти процесса: транспорт может «перехостить» тот же код
/// после обрыва (rearm в RacingTransport), и личность при этом обязана
/// остаться прежней.
type HostKeys = Arc<Mutex<HashMap<String, SecretKey>>>;

fn parse_endpoint_id(s: &str) -> Result<iroh::EndpointId> {
    let raw = hex_to_bytes(s)?;
    iroh::EndpointId::from_bytes(&raw).map_err(|e| anyhow!("bad join code: {e}"))
}

fn hex_to_bytes(s: &str) -> Result<[u8; 32]> {
    if s.len() != 64 {
        return Err(anyhow!("topic must be 32 bytes hex"));
    }
    let raw = (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16))
        .collect::<Result<Vec<u8>, _>>()?;
    raw.as_slice().try_into().map_err(|_| anyhow!("bad topic"))
}

pub(crate) fn hex_to_key(s: &str) -> Result<SecretKey> {
    if s.len() != 64 {
        return Err(anyhow!("topic must be 32 bytes hex"));
    }
    let raw = (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16))
        .collect::<Result<Vec<u8>, _>>()?;
    let arr: [u8; 32] = raw.as_slice().try_into().map_err(|_| anyhow!("bad topic"))?;
    Ok(SecretKey::from_bytes(&arr))
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

type Pending = Arc<Mutex<HashMap<u64, (SendStream, RecvStream)>>>;

/// Живой Endpoint с единственным соединением. Пересоздаётся на каждый join.
struct Node {
    endpoint: Endpoint,
    conn_rx: watch::Receiver<Option<Connection>>,
    pending: Pending,
}

/// Сессии по имени: у каждой свой Endpoint. Идентификаторы стримов нумеруются
/// внутри сессии, поэтому совпадение номеров между сессиями безопасно.
type Shared = Arc<Mutex<HashMap<String, Node>>>;

fn session_of(req: &serde_json::Value) -> String {
    req["session"].as_str().unwrap_or("default").to_string()
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = parse_args()?;
    let (events_tx, _) = broadcast::channel::<String>(256);
    let node: Shared = Arc::new(Mutex::new(HashMap::new()));
    let host_keys: HostKeys = Arc::new(Mutex::new(HashMap::new()));
    let lan_state: lan::SharedLan = Arc::new(Mutex::new(None));

    let bridge = TcpListener::bind(("127.0.0.1", args.bridge_port)).await?;
    let bridge_port = bridge.local_addr()?.port();

    println!(
        "{}",
        serde_json::json!({
            "ready": true,
            "bridgePort": bridge_port,
            "offline": args.offline,
            "mdns": args.mdns,
        })
    );

    let cfg = Arc::new(args);
    loop {
        let (sock, _) = bridge.accept().await?;
        let events_tx = events_tx.clone();
        let node = node.clone();
        let host_keys = host_keys.clone();
        let lan_state = lan_state.clone();
        let cfg = cfg.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_bridge(sock, events_tx, node, host_keys, lan_state, cfg).await {
                eprintln!("bridge conn error: {e:#}");
            }
        });
    }
}

async fn build_endpoint(cfg: &Args, secret: SecretKey) -> Result<Endpoint> {
    // Оффлайн: ни релея, ни DNS/pkarr — только прямой UDP и, если попросили, mDNS.
    let endpoint = if cfg.offline {
        let mut b = Endpoint::builder(presets::Minimal)
            .secret_key(secret)
            .alpns(vec![ALPN.to_vec()])
            .relay_mode(RelayMode::Disabled);
        if cfg.mdns {
            b = b.address_lookup(iroh_mdns_address_lookup::MdnsAddressLookup::builder());
        }
        b.bind().await?
    } else {
        let mut b = Endpoint::builder(presets::N0)
            .secret_key(secret)
            .alpns(vec![ALPN.to_vec()]);
        if cfg.mdns {
            b = b.address_lookup(iroh_mdns_address_lookup::MdnsAddressLookup::builder());
        }
        b.bind().await?
    };
    Ok(endpoint)
}

async fn local_addrs(endpoint: &Endpoint) -> Vec<String> {
    for _ in 0..60 {
        let addr: EndpointAddr = endpoint.addr();
        let ips: Vec<String> = addr
            .addrs
            .iter()
            .filter_map(|a| match a {
                TransportAddr::Ip(sa) => Some(sa.to_string()),
                _ => None,
            })
            .collect();
        if !ips.is_empty() {
            return ips;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    endpoint.bound_sockets().iter().map(|s| s.to_string()).collect()
}

fn channel_binding(conn: &Connection) -> Option<String> {
    let mut out = [0u8; 32];
    conn.export_keying_material(&mut out, BINDING_LABEL, &[]).ok()?;
    Some(to_hex(&out))
}

/// Следит, каким путём реально идут данные.
///
/// iroh начинает через релей и молча переезжает на прямой путь, когда пробивка
/// удалась, — поэтому один замер в момент подключения врёт. Смотрим на
/// выбранный путь всё время, пока соединение живо: `paths_stream` отдаёт
/// снапшот сразу и потом на каждое изменение.
fn spawn_path_watcher(events: broadcast::Sender<String>, session: String, conn: Connection) {
    tokio::spawn(async move {
        let endpoint_id = conn.remote_id().to_string();
        let mut last: Option<&'static str> = None;
        let mut paths = conn.paths_stream();

        while let Some(snapshot) = paths.next().await {
            // Выбранного пути ещё нет — сказать нечего, ждём следующий снимок.
            let Some(path) = snapshot.iter().find(|path| path.is_selected()) else {
                continue;
            };
            let kind = if path.is_relay() { "relay" } else { "direct" };
            if last == Some(kind) {
                continue;
            }
            last = Some(kind);
            // Адрес пути нужен, чтобы отличить честную пробивку NAT от «прямого»
            // пути через тейлнет или локальную сеть, — по одному слову «direct»
            // этого не видно.
            let _ = events.send(
                serde_json::json!({
                    "event": "conn-type",
                    "session": session,
                    "endpointId": endpoint_id,
                    "connectionType": kind,
                    "remoteAddr": path.remote_addr().to_string(),
                    "rttMs": path.rtt().as_millis(),
                })
                .to_string(),
            );
        }
    });
}

fn announce_peer(
    events: &broadcast::Sender<String>,
    session: &str,
    conn: &Connection,
    direction: &str,
) {
    let _ = events.send(
        serde_json::json!({
            "event": "peer",
            "session": session,
            "direction": direction,
            "endpointId": conn.remote_id().to_string(),
            "binding": channel_binding(conn),
        })
        .to_string(),
    );
}

/// Принимать входящие bi-stream'ы и складывать до `attach`.
fn spawn_stream_acceptor(
    session: String,
    mut conn_rx: watch::Receiver<Option<Connection>>,
    pending: Pending,
    events: broadcast::Sender<String>,
) {
    let next_id = Arc::new(AtomicU64::new(1));
    tokio::spawn(async move {
        let conn = loop {
            if let Some(c) = conn_rx.borrow_and_update().clone() {
                break c;
            }
            if conn_rx.changed().await.is_err() {
                return;
            }
        };
        loop {
            match conn.accept_bi().await {
                Ok((send, recv)) => {
                    let id = next_id.fetch_add(1, Ordering::Relaxed);
                    pending.lock().await.insert(id, (send, recv));
                    let _ = events.send(
                        serde_json::json!({"event":"stream","session":session,"id":id}).to_string(),
                    );
                }
                Err(e) => {
                    let _ = events.send(
                        serde_json::json!({
                            "event": "closed", "session": session, "message": e.to_string()
                        })
                        .to_string(),
                    );
                    return;
                }
            }
        }
    });
}

async fn join(
    cfg: &Args,
    node: &Shared,
    host_keys: &HostKeys,
    events: &broadcast::Sender<String>,
    session: &str,
    topic: Option<&str>,
    role: &str,
    hints: Vec<std::net::SocketAddr>,
) -> Result<serde_json::Value> {
    leave(node, Some(session)).await;

    // Хост: код без topic — новая случайная личность, код = её публичный ключ;
    // с topic — повторный хостинг своего же кода той же личностью.
    // Гость: topic — это EndpointId хоста, к нему и подключаемся.
    let (secret, host_id) = if role == "host" {
        let secret = match topic {
            None => SecretKey::generate(),
            Some(code) => host_keys
                .lock()
                .await
                .get(code)
                .cloned()
                .ok_or_else(|| anyhow!("unknown host code: it was not generated here"))?,
        };
        let id = secret.public();
        host_keys.lock().await.insert(id.to_string(), secret.clone());
        (secret, id)
    } else {
        let code = topic.context("guest join needs topic")?;
        (SecretKey::generate(), parse_endpoint_id(code)?)
    };
    let endpoint = build_endpoint(cfg, secret).await?;
    let addrs = local_addrs(&endpoint).await;

    let (conn_tx, conn_rx) = watch::channel::<Option<Connection>>(None);
    let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
    spawn_stream_acceptor(session.to_string(), conn_rx.clone(), pending.clone(), events.clone());

    if role == "host" {
        let ep = endpoint.clone();
        let events = events.clone();
        let session = session.to_string();
        tokio::spawn(async move {
            while let Some(incoming) = ep.accept().await {
                match incoming.await {
                    Ok(conn) => {
                        announce_peer(&events, &session, &conn, "in");
                        spawn_path_watcher(events.clone(), session.clone(), conn.clone());
                        let _ = conn_tx.send(Some(conn));
                    }
                    Err(e) => {
                        let _ = events.send(
                            serde_json::json!({
                                "event": "error", "session": session, "message": e.to_string()
                            })
                            .to_string(),
                        );
                    }
                }
            }
        });
    } else {
        let ep = endpoint.clone();
        let events = events.clone();
        let session = session.to_string();
        tokio::spawn(async move {
            // Известные адреса — это «запомненное устройство» или узел тейлнета:
            // с ними соединение встаёт за один RTT, без всякого обнаружения.
            let target = if hints.is_empty() {
                EndpointAddr::new(host_id)
            } else {
                EndpointAddr::from_parts(host_id, hints.into_iter().map(TransportAddr::Ip))
            };
            match ep.connect(target, ALPN).await {
                Ok(conn) => {
                    announce_peer(&events, &session, &conn, "out");
                    spawn_path_watcher(events.clone(), session.clone(), conn.clone());
                    let _ = conn_tx.send(Some(conn));
                }
                Err(e) => {
                    let _ = events.send(
                        serde_json::json!({
                            "event": "error", "session": session, "message": e.to_string()
                        })
                        .to_string(),
                    );
                }
            }
        });
    }

    let endpoint_id = endpoint.id().to_string();
    node.lock()
        .await
        .insert(session.to_string(), Node { endpoint, conn_rx, pending });

    Ok(serde_json::json!({ "ok": true, "endpointId": endpoint_id, "addrs": addrs }))
}

/// `session = Some(name)` — закрыть одну сессию, `None` — все.
async fn leave(node: &Shared, session: Option<&str>) {
    let taken: Vec<Node> = {
        let mut guard = node.lock().await;
        match session {
            Some(name) => guard.remove(name).into_iter().collect(),
            None => guard.drain().map(|(_, n)| n).collect(),
        }
    };
    for n in taken {
        n.endpoint.close().await;
    }
}

async fn handle_bridge(
    sock: TcpStream,
    events_tx: broadcast::Sender<String>,
    node: Shared,
    host_keys: HostKeys,
    lan_state: lan::SharedLan,
    cfg: Arc<Args>,
) -> Result<()> {
    sock.set_nodelay(true)?;
    let (r, mut w) = sock.into_split();
    let mut reader = BufReader::new(r);
    let mut line = String::new();
    reader.read_line(&mut line).await?;
    let req: serde_json::Value = serde_json::from_str(line.trim())?;
    let op = req["op"].as_str().unwrap_or("");

    match op {
        "control" => {
            let mut rx = events_tx.subscribe();
            w.write_all(b"{\"ok\":true}\n").await?;
            while let Ok(msg) = rx.recv().await {
                w.write_all(msg.as_bytes()).await?;
                w.write_all(b"\n").await?;
            }
            Ok(())
        }
        "join" => {
            let topic = req["topic"].as_str();
            let role = req["role"].as_str().unwrap_or("guest");
            let addrs: Vec<std::net::SocketAddr> = req["addrs"]
                .as_array()
                .map(|list| {
                    list.iter()
                        .filter_map(|v| v.as_str())
                        .filter_map(|s| s.parse().ok())
                        .collect()
                })
                .unwrap_or_default();
            let reply = join(&cfg, &node, &host_keys, &events_tx, &session_of(&req), topic, role, addrs)
                .await?;
            w.write_all(reply.to_string().as_bytes()).await?;
            w.write_all(b"\n").await?;
            Ok(())
        }
        "leave" => {
            leave(&node, Some(&session_of(&req))).await;
            w.write_all(b"{\"ok\":true}\n").await?;
            Ok(())
        }
        "open" => {
            let mut rx = {
                let guard = node.lock().await;
                guard.get(&session_of(&req)).context("open before join")?.conn_rx.clone()
            };
            let conn = loop {
                if let Some(c) = rx.borrow_and_update().clone() {
                    break c;
                }
                rx.changed().await?;
            };
            let (send, recv) = conn.open_bi().await?;
            w.write_all(b"{\"ok\":true}\n").await?;
            pipe(reader, w, send, recv).await
        }
        "attach" => {
            let id = req["id"].as_u64().context("attach needs id")?;
            let pending = {
                let guard = node.lock().await;
                guard.get(&session_of(&req)).context("attach before join")?.pending.clone()
            };
            let (send, recv) = {
                let mut guard = pending.lock().await;
                guard.remove(&id).context("unknown stream id")?
            };
            w.write_all(b"{\"ok\":true}\n").await?;
            pipe(reader, w, send, recv).await
        }
        "lan-start" => {
            let secret = req["secret"].as_str().context("lan-start needs secret")?;
            let user_data = req["userData"].as_str().unwrap_or("{}");
            let reply =
                lan::start(&events_tx, &lan_state, secret, user_data, cfg.offline).await?;
            w.write_all(reply.to_string().as_bytes()).await?;
            w.write_all(b"\n").await?;
            Ok(())
        }
        "lan-stop" => {
            lan::stop(&lan_state).await;
            w.write_all(b"{\"ok\":true}\n").await?;
            Ok(())
        }
        "lan-invite" => {
            let endpoint_id = req["endpointId"].as_str().context("lan-invite needs endpointId")?;
            let hints: Vec<std::net::SocketAddr> = req["addrs"]
                .as_array()
                .map(|list| {
                    list.iter()
                        .filter_map(|v| v.as_str())
                        .filter_map(|s| s.parse().ok())
                        .collect()
                })
                .unwrap_or_default();
            let payload = serde_json::json!({
                "topic": req["topic"],
                "displayName": req["displayName"],
                "deviceType": req["deviceType"],
                "fileCount": req["fileCount"],
                "textCount": req["textCount"],
                "totalSize": req["totalSize"],
            });
            let reply = lan::invite(&lan_state, endpoint_id, hints, payload).await?;
            w.write_all(reply.to_string().as_bytes()).await?;
            w.write_all(b"\n").await?;
            Ok(())
        }
        "lan-respond" => {
            let id = req["requestId"].as_u64().context("lan-respond needs requestId")?;
            let response = req["response"].as_str().unwrap_or("declined");
            let reply = lan::respond(&lan_state, id, response).await?;
            w.write_all(reply.to_string().as_bytes()).await?;
            w.write_all(b"\n").await?;
            Ok(())
        }
        other => Err(anyhow!("unknown op {other}")),
    }
}

async fn pipe(
    mut tcp_r: BufReader<tokio::net::tcp::OwnedReadHalf>,
    mut tcp_w: tokio::net::tcp::OwnedWriteHalf,
    mut send: SendStream,
    mut recv: RecvStream,
) -> Result<()> {
    let up = async move {
        let n = tokio::io::copy(&mut tcp_r, &mut send).await;
        let _ = send.finish();
        n
    };
    let down = async move {
        let n = tokio::io::copy(&mut recv, &mut tcp_w).await;
        let _ = tcp_w.shutdown().await;
        n
    };
    let (a, b) = tokio::join!(up, down);
    a?;
    b?;
    Ok(())
}
