//! Extra trust roots for TLS endpoints: a test server today, an enterprise
//! certificate authority later.

use rustls::pki_types::pem::PemObject;
use rustls::pki_types::CertificateDer;

use crate::error::MailError;

/// Roots added on top of the webpki bundle, as PEM documents.
#[derive(Clone, Debug, Default)]
pub struct TlsOptions {
    pub extra_roots_pem: Vec<Vec<u8>>,
}

impl TlsOptions {
    pub(crate) fn extra_roots_der(&self) -> Result<Vec<Vec<u8>>, MailError> {
        let mut roots = Vec::new();
        for pem in &self.extra_roots_pem {
            for certificate in CertificateDer::pem_slice_iter(pem) {
                let certificate = certificate.map_err(|error| {
                    MailError::Tls(format!("invalid root certificate: {error}"))
                })?;
                roots.push(certificate.as_ref().to_vec());
            }
        }
        Ok(roots)
    }
}
