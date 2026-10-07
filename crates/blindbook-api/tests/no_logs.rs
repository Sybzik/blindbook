//! The no-logs guarantee, checked on the source (THREAT_MODEL N2): the API never reads a client
//! address or a proxy header, and has no request-tracing layer. A change that adds one fails here.

const FORBIDDEN: [&str; 7] = [
    "ConnectInfo",
    "remote_addr",
    "peer_addr",
    "x-forwarded-for",
    "x-real-ip",
    "TraceLayer",
    "forwarded",
];

#[test]
fn the_api_never_sees_or_logs_a_client() {
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut checked = 0;
    for entry in std::fs::read_dir(&src).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_some_and(|e| e == "rs") {
            let text = std::fs::read_to_string(&path).unwrap();
            for line in text.lines().filter(|l| !l.trim_start().starts_with("//")) {
                let lower = line.to_lowercase();
                for f in FORBIDDEN {
                    assert!(
                        !lower.contains(&f.to_lowercase()),
                        "{}: `{f}` in `{}`",
                        path.display(),
                        line.trim()
                    );
                }
            }
            checked += 1;
        }
    }
    assert!(checked >= 8, "checked {checked} files");
    // The binary forces request logging off whatever RUST_LOG says.
    let main = std::fs::read_to_string(src.join("main.rs")).unwrap();
    assert!(main.contains("tower_http=off") && main.contains("hyper=off"));
}
