//! Outgoing HTTP clients.
//!
//! On Android the default `getaddrinfo` resolver of reqwest fails
//! (`failed to lookup address information: No address associated with
//! hostname`), so every client is built through [`client_builder`], which
//! installs a resolver falling back on public DNS servers. Other platforms get
//! the stock builder unchanged.

/// Client builder to use for every outgoing request.
pub fn client_builder() -> reqwest::ClientBuilder {
    let builder = reqwest::Client::builder();
    #[cfg(target_os = "android")]
    let builder = builder.dns_resolver(std::sync::Arc::new(android::AndroidDns::new()));
    builder
}

#[cfg(target_os = "android")]
mod android {
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};

    use hickory_resolver::config::{NameServerConfigGroup, ResolverConfig};
    use hickory_resolver::name_server::TokioConnectionProvider;
    use hickory_resolver::TokioResolver;
    use reqwest::dns::{Addrs, Name, Resolve, Resolving};

    const PUBLIC_DNS: [IpAddr; 2] = [
        IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1)),
        IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8)),
    ];

    const DNS_PORT: u16 = 53;

    /// System resolution first, then an explicit public resolver: Android has
    /// no `/etc/resolv.conf` for hickory to read.
    pub(super) struct AndroidDns {
        fallback: TokioResolver,
    }

    impl AndroidDns {
        pub(super) fn new() -> Self {
            let servers = NameServerConfigGroup::from_ips_clear(&PUBLIC_DNS, DNS_PORT, true);
            let config = ResolverConfig::from_parts(None, Vec::new(), servers);
            Self {
                fallback: TokioResolver::builder_with_config(
                    config,
                    TokioConnectionProvider::default(),
                )
                .build(),
            }
        }
    }

    impl Resolve for AndroidDns {
        fn resolve(&self, name: Name) -> Resolving {
            let host = name.as_str().to_string();
            let fallback = self.fallback.clone();
            Box::pin(async move {
                if let Ok(addrs) = tokio::net::lookup_host((host.as_str(), 0)).await {
                    let system: Vec<SocketAddr> = addrs.collect();
                    if !system.is_empty() {
                        return Ok(Box::new(system.into_iter()) as Addrs);
                    }
                }
                let lookup = fallback
                    .lookup_ip(host.as_str())
                    .await
                    .map_err(|error| Box::new(error) as Box<dyn std::error::Error + Send + Sync>)?;
                let addrs: Vec<SocketAddr> =
                    lookup.iter().map(|ip| SocketAddr::new(ip, 0)).collect();
                if addrs.is_empty() {
                    return Err(format!("résolution DNS vide pour {host}").into());
                }
                Ok(Box::new(addrs.into_iter()) as Addrs)
            })
        }
    }
}
