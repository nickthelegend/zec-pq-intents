//! zpay-verify: check an incoming shielded Zcash payment with only the receiver's unified
//! *incoming* viewing key (UIVK).
//!
//! Copied from zec-payment-verify-sdk/packages/core (same author, MIT) so this repo builds on its own.
//!
//! ```no_run
//! # async fn demo() -> Result<(), zpay_verify::VerifyError> {
//! use zpay_verify::{verify, Expect};
//! let v = verify("https://testnet.zec.rocks:443", "uivktest1…", "030c3cbf…",
//!                &Expect { amount_zat: 100_000, memo: Some("x402z-…".into()), min_conf: 1, shielded_only: true }).await?;
//! assert!(v.verdict.ok);
//! # Ok(()) }
//! ```
//!
//! The transaction is fetched from lightwalletd, its txid is re-computed, and every Sapling,
//! Orchard and Ironwood output is trial-decrypted with the key. An incoming viewing key sees
//! received notes and their memos; it cannot spend, and cannot see spends or change.
//! Extracted from zec-shielded-x402's facilitator `check_uivk` (same author, MIT).

pub mod lwd;

use orchard::note_encryption::{DomainVersion, IronwoodVersion, NoteEncryptionDomain, OrchardVersion};
use sapling::note_encryption::SaplingDomain;
use serde::Serialize;
use zcash_keys::address::UnifiedAddress;
use zcash_keys::keys::{UnifiedFullViewingKey, UnifiedIncomingViewingKey};
use zcash_note_encryption::try_note_decryption;
use zcash_primitives::transaction::{components::sapling::zip212_enforcement, Transaction};
use zcash_protocol::consensus::{BlockHeight, BranchId, Network};
use zcash_protocol::memo::{Memo, MemoBytes};

pub const NETWORK: Network = Network::TestNetwork;

/// Something went wrong before a verdict could be reached (bad input, network).
#[derive(Debug)]
pub enum VerifyError {
    BadKey(String),
    BadAddress(String),
    BadTxid(String),
    Lwd(lwd::LwdError),
    Unparseable(String),
    TxidMismatch,
}

impl std::fmt::Display for VerifyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VerifyError::BadKey(e) => write!(f, "not a testnet unified incoming viewing key: {e}"),
            VerifyError::BadAddress(e) => write!(f, "not a testnet unified address: {e}"),
            VerifyError::BadTxid(t) => write!(f, "not a txid (64 hex characters): {t}"),
            VerifyError::Lwd(e) => write!(f, "{e}"),
            VerifyError::Unparseable(e) => write!(f, "transaction does not parse: {e}"),
            VerifyError::TxidMismatch => write!(f, "lightwalletd returned a transaction whose txid differs from the one requested"),
        }
    }
}

impl std::error::Error for VerifyError {}

impl From<lwd::LwdError> for VerifyError {
    fn from(e: lwd::LwdError) -> Self {
        VerifyError::Lwd(e)
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Output {
    pub pool: &'static str,
    pub value: u64,
    /// Text memo, if the memo is text.
    pub memo: Option<String>,
    /// The memo is set but is not UTF-8 text.
    pub memo_binary: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, Default)]
pub struct Pools {
    pub sapling: bool,
    pub orchard: bool,
    pub ironwood: bool,
    pub transparent: bool,
}

/// What the viewing key sees in one transaction.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct TxReport {
    pub txid: String,
    pub found: bool,
    /// None while in the mempool or when not found.
    pub height: Option<u32>,
    pub confirmations: u32,
    pub tip: u32,
    pub outputs: Vec<Output>,
    pub pools: Pools,
}

/// What the receiver expects to have been paid.
#[derive(Debug, Clone)]
pub struct Expect {
    pub amount_zat: u64,
    /// Only outputs with exactly this text memo count. None: every output to the key counts.
    pub memo: Option<String>,
    pub min_conf: u32,
    /// Reject a transaction that has any transparent input or output.
    pub shielded_only: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Verdict {
    pub ok: bool,
    /// Sum of the outputs that count towards the payment.
    pub paid_zat: u64,
    /// Empty when ok. Codes: TX_NOT_FOUND, NO_OUTPUT_TO_KEY, MEMO_MISMATCH, AMOUNT_TOO_LOW,
    /// NOT_CONFIRMED, TRANSPARENT_PART.
    pub reasons: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Verification {
    pub report: TxReport,
    pub verdict: Verdict,
    pub lightwalletd: String,
}

pub fn parse_uivk(s: &str) -> Result<UnifiedIncomingViewingKey, VerifyError> {
    UnifiedIncomingViewingKey::decode(&NETWORK, s.trim()).map_err(|e| VerifyError::BadKey(e.to_string()))
}

/// UFVK → UIVK, so a receiver can share a key that sees incoming payments only.
pub fn uivk_from_ufvk(ufvk: &str) -> Result<String, VerifyError> {
    let k = UnifiedFullViewingKey::decode(&NETWORK, ufvk.trim()).map_err(|e| VerifyError::BadKey(e.to_string()))?;
    k.to_unified_incoming_viewing_key().encode(&NETWORK).map_err(|e| VerifyError::BadKey(format!("{e:?}")))
}

/// Which receivers of a unified address an incoming viewing key derives, so a payer can tell
/// whether a payment to that address will be seen with that key.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Ownership {
    pub address: String,
    /// Receivers the address has: "orchard", "sapling", "transparent".
    pub receivers: Vec<&'static str>,
    /// Shielded receivers of the address that this key derives (a payment to them is visible to it).
    pub covered: Vec<&'static str>,
    /// A unified address holding only one covered receiver (Orchard first), or None when the key
    /// covers none: pay this, not the full address, so a payment cannot land on a receiver the key
    /// does not see.
    pub pay_to: Option<String>,
}

/// Does `uivk` derive the shielded receivers of `ua`? An Orchard receiver is covered when the key
/// decrypts its diversifier to an index that re-derives the same address; Sapling likewise.
pub fn owns(uivk: &str, ua: &str) -> Result<Ownership, VerifyError> {
    let key = parse_uivk(uivk)?;
    let addr = UnifiedAddress::decode(&NETWORK, ua.trim()).map_err(|e| VerifyError::BadAddress(e.to_string()))?;
    let mut receivers = Vec::new();
    let mut covered = Vec::new();
    let orchard = addr.orchard().filter(|a| key.orchard().as_ref().is_some_and(|k| k.diversifier_index(a).is_some()));
    let sapling = addr.sapling().filter(|a| key.sapling().as_ref().is_some_and(|k| k.decrypt_diversifier(a).is_some()));
    if addr.has_orchard() {
        receivers.push("orchard");
    }
    if addr.has_sapling() {
        receivers.push("sapling");
    }
    if addr.has_transparent() {
        receivers.push("transparent");
    }
    if orchard.is_some() {
        covered.push("orchard");
    }
    if sapling.is_some() {
        covered.push("sapling");
    }
    let only = match (orchard, sapling) {
        (Some(o), _) => UnifiedAddress::from_receivers(Some(*o), None, None, None, None),
        (None, Some(s)) => UnifiedAddress::from_receivers(None, Some(*s), None, None, None),
        (None, None) => None,
    };
    Ok(Ownership { address: ua.trim().to_string(), receivers, covered, pay_to: only.map(|u| u.encode(&NETWORK)) })
}

fn memo_of(m: &[u8; 512]) -> (Option<String>, bool) {
    match MemoBytes::from_bytes(m).ok().and_then(|b| Memo::try_from(&b).ok()) {
        Some(Memo::Text(t)) => (Some(t.to_string()), false),
        Some(Memo::Empty) => (None, false),
        _ => (None, true),
    }
}

fn orchard_family<V: DomainVersion>(
    pool: &'static str,
    ivk: &orchard::keys::IncomingViewingKey,
    bundle: &orchard::bundle::Bundle<orchard::bundle::Authorized, zcash_protocol::value::ZatBalance>,
    out: &mut Vec<Output>,
) {
    let p = orchard::keys::PreparedIncomingViewingKey::new(ivk);
    for a in bundle.actions() {
        let d = NoteEncryptionDomain::<V>::for_action(a);
        if let Some((note, _, memo)) = try_note_decryption(&d, &p, a) {
            let (memo, memo_binary) = memo_of(&memo);
            out.push(Output { pool, value: note.value().inner(), memo, memo_binary });
        }
    }
}

/// Fetch `txid` and decrypt it with `uivk`. A txid lightwalletd does not know is reported with
/// `found: false`, not as an error.
pub async fn inspect(c: &mut lwd::Client, uivk: &UnifiedIncomingViewingKey, txid: &str, tip: BlockHeight) -> Result<TxReport, VerifyError> {
    let id = lwd::parse_txid(txid).ok_or_else(|| VerifyError::BadTxid(txid.to_string()))?;
    let empty = |found| TxReport { txid: txid.to_string(), found, height: None, confirmations: 0, tip: tip.into(), outputs: vec![], pools: Pools::default() };
    let (data, loc) = match lwd::get_transaction(c, &id).await? {
        lwd::FetchedTx::Found { data, location } => (data, location),
        lwd::FetchedTx::NotFound => return Ok(empty(false)),
    };
    let mined = match loc {
        lwd::TxLocation::Mined(h) => Some(h),
        lwd::TxLocation::Mempool => None,
        // Only on a fork that is not the main chain: as good as not found.
        lwd::TxLocation::Orphaned => return Ok(empty(false)),
    };
    let tx = Transaction::read(&data[..], BranchId::for_height(&NETWORK, mined.unwrap_or(tip + 1))).map_err(|e| VerifyError::Unparseable(e.to_string()))?;
    if tx.txid() != id {
        return Err(VerifyError::TxidMismatch);
    }
    let mut outputs = Vec::new();
    if let (Some(b), Some(ivk)) = (tx.sapling_bundle(), uivk.sapling()) {
        let d = SaplingDomain::new(zip212_enforcement(&NETWORK, mined.unwrap_or(tip + 1)));
        let p = ivk.prepare();
        for o in b.shielded_outputs() {
            if let Some((note, _, memo)) = try_note_decryption(&d, &p, o) {
                let (memo, memo_binary) = memo_of(&memo);
                outputs.push(Output { pool: "Sapling", value: note.value().inner(), memo, memo_binary });
            }
        }
    }
    if let Some(ivk) = uivk.orchard() {
        if let Some(b) = tx.orchard_bundle() {
            orchard_family::<OrchardVersion>("Orchard", ivk, b, &mut outputs);
        }
        if let Some(b) = tx.ironwood_bundle() {
            orchard_family::<IronwoodVersion>("Ironwood", ivk, b, &mut outputs);
        }
    }
    let transparent = tx.transparent_bundle().is_some_and(|b| !b.vin.is_empty() || !b.vout.is_empty());
    Ok(TxReport {
        txid: txid.to_string(),
        found: true,
        height: mined.map(u32::from),
        confirmations: mined.map(|h| u32::from(tip).saturating_sub(u32::from(h)) + 1).unwrap_or(0),
        tip: tip.into(),
        outputs,
        pools: Pools { sapling: tx.sapling_bundle().is_some(), orchard: tx.orchard_bundle().is_some(), ironwood: tx.ironwood_bundle().is_some(), transparent },
    })
}

/// The rules, separate from the network so they can be read and tested on their own.
pub fn check(r: &TxReport, e: &Expect) -> Verdict {
    let mut reasons = Vec::new();
    if !r.found {
        return Verdict { ok: false, paid_zat: 0, reasons: vec!["TX_NOT_FOUND".into()] };
    }
    let counted: Vec<&Output> = r.outputs.iter().filter(|o| e.memo.as_ref().is_none_or(|m| o.memo.as_deref() == Some(m.as_str()))).collect();
    let paid_zat = counted.iter().map(|o| o.value).sum();
    if r.outputs.is_empty() {
        reasons.push("NO_OUTPUT_TO_KEY".into());
    } else if counted.is_empty() {
        reasons.push("MEMO_MISMATCH".into());
    }
    if !r.outputs.is_empty() && paid_zat < e.amount_zat {
        reasons.push("AMOUNT_TOO_LOW".into());
    }
    if r.confirmations < e.min_conf {
        reasons.push("NOT_CONFIRMED".into());
    }
    if e.shielded_only && r.pools.transparent {
        reasons.push("TRANSPARENT_PART".into());
    }
    Verdict { ok: reasons.is_empty(), paid_zat, reasons }
}

/// Connect, fetch, decrypt, check.
pub async fn verify(lwd_url: &str, uivk: &str, txid: &str, e: &Expect) -> Result<Verification, VerifyError> {
    let key = parse_uivk(uivk)?;
    let mut c = lwd::connect(lwd_url).await?;
    let tip = lwd::chain_tip(&mut c).await?;
    let report = inspect(&mut c, &key, txid, tip).await?;
    let verdict = check(&report, e);
    Ok(Verification { report, verdict, lightwalletd: lwd_url.to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(outputs: Vec<(u64, Option<&str>)>, conf: u32, transparent: bool) -> TxReport {
        TxReport {
            txid: "00".repeat(32),
            found: true,
            height: Some(100),
            confirmations: conf,
            tip: 100 + conf.saturating_sub(1),
            outputs: outputs.into_iter().map(|(value, m)| Output { pool: "Ironwood", value, memo: m.map(String::from), memo_binary: false }).collect(),
            pools: Pools { ironwood: true, transparent, ..Pools::default() },
        }
    }
    const E: fn(u64, Option<&str>) -> Expect = |amount_zat, memo| Expect { amount_zat, memo: memo.map(String::from), min_conf: 1, shielded_only: true };

    #[test]
    fn exact_payment_passes_and_counts_only_matching_memos() {
        let r = report(vec![(60, Some("inv-1")), (40, Some("inv-1")), (500, Some("other"))], 3, false);
        assert_eq!(check(&r, &E(100, Some("inv-1"))), Verdict { ok: true, paid_zat: 100, reasons: vec![] });
        assert_eq!(check(&r, &E(101, Some("inv-1"))).reasons, vec!["AMOUNT_TOO_LOW"]);
        assert_eq!(check(&r, &E(600, None)).paid_zat, 600);
    }

    #[test]
    fn each_failure_has_its_reason() {
        assert_eq!(check(&report(vec![], 3, false), &E(1, None)).reasons, vec!["NO_OUTPUT_TO_KEY"]);
        assert_eq!(check(&report(vec![(100, Some("a"))], 3, false), &E(100, Some("b"))).reasons, vec!["MEMO_MISMATCH", "AMOUNT_TOO_LOW"]);
        assert_eq!(check(&report(vec![(100, None)], 0, false), &E(100, None)).reasons, vec!["NOT_CONFIRMED"]);
        assert_eq!(check(&report(vec![(100, None)], 2, true), &E(100, None)).reasons, vec!["TRANSPARENT_PART"]);
        let mut gone = report(vec![], 0, false);
        gone.found = false;
        assert_eq!(check(&gone, &E(1, None)).reasons, vec!["TX_NOT_FOUND"]);
    }

    /// The published run's wallets (deployments/testnet.json): the receive key derives the receive
    /// address; the anchor wallet's key does not.
    fn wallets() -> serde_json::Value {
        serde_json::from_str::<serde_json::Value>(include_str!("../../../deployments/testnet.json")).expect("record")["wallets"].clone()
    }

    #[test]
    fn owns_the_address_its_key_derives_and_not_another_wallets() {
        let w = wallets();
        let (ua, own, other) = (w["receive"]["address"].as_str().unwrap(), w["receive"]["uivk"].as_str().unwrap(), w["anchor"]["uivk"].as_str().unwrap());
        let mine = owns(own, ua).unwrap();
        assert_eq!(mine.receivers, vec!["orchard"]);
        assert_eq!(mine.covered, vec!["orchard"]);
        assert_eq!(owns(own, &mine.pay_to.unwrap()).unwrap().covered, vec!["orchard"]);
        let theirs = owns(other, ua).unwrap();
        assert!(theirs.covered.is_empty());
        assert_eq!(theirs.pay_to, None);
    }

    #[test]
    fn a_new_diversified_address_of_the_same_key_is_covered() {
        let w = wallets();
        let key = parse_uivk(w["receive"]["uivk"].as_str().unwrap()).unwrap();
        let fresh = UnifiedAddress::from_receivers(Some(key.orchard().as_ref().unwrap().address_at(7u32)), None, None, None, None).unwrap().encode(&NETWORK);
        assert_ne!(fresh, w["receive"]["address"].as_str().unwrap());
        assert_eq!(owns(w["receive"]["uivk"].as_str().unwrap(), &fresh).unwrap().covered, vec!["orchard"]);
        assert!(owns(w["anchor"]["uivk"].as_str().unwrap(), &fresh).unwrap().covered.is_empty());
    }

    #[test]
    fn a_mixed_address_is_paid_only_on_the_receiver_the_key_covers() {
        let w = wallets();
        let anchor = UnifiedAddress::decode(&NETWORK, w["anchor"]["address"].as_str().unwrap()).unwrap();
        // Orchard from the anchor wallet, Sapling from the receive wallet's own key.
        let key = parse_uivk(w["receive"]["uivk"].as_str().unwrap()).unwrap();
        let sapling = key.sapling().as_ref().expect("the receive key has a Sapling part").find_address(0u32).unwrap().1;
        let mixed = UnifiedAddress::from_receivers(anchor.orchard().cloned(), Some(sapling), None, None, None).unwrap().encode(&NETWORK);
        let o = owns(w["receive"]["uivk"].as_str().unwrap(), &mixed).unwrap();
        assert_eq!(o.receivers, vec!["orchard", "sapling"]);
        assert_eq!(o.covered, vec!["sapling"]);
        let only = UnifiedAddress::decode(&NETWORK, &o.pay_to.unwrap()).unwrap();
        assert_eq!((only.has_orchard(), only.sapling()), (false, Some(&sapling)));
    }

    /// "Another wallet's key" for the node tests: the full viewing key of a throwaway seed (32 bytes
    /// of 7, account 0) that holds nothing. The fixture file must be exactly this derivation.
    #[test]
    fn the_throwaway_ufvk_fixture_is_derived_from_the_public_test_seed_and_does_not_cover_the_escrow() {
        use zcash_keys::keys::UnifiedSpendingKey;
        let usk = UnifiedSpendingKey::from_seed(&NETWORK, &[7u8; 32], zip32::AccountId::ZERO).unwrap();
        let ufvk = usk.to_unified_full_viewing_key().encode(&NETWORK).unwrap();
        let fixture = include_str!("../../node/test/fixtures/throwaway-ufvk.txt").trim().to_string();
        if std::env::var("WRITE_FIXTURE").is_ok() {
            std::fs::write(concat!(env!("CARGO_MANIFEST_DIR"), "/../node/test/fixtures/throwaway-ufvk.txt"), format!("{ufvk}\n")).unwrap();
            return;
        }
        assert_eq!(ufvk, fixture);
        let w = wallets();
        assert!(owns(&uivk_from_ufvk(&fixture).unwrap(), w["escrow"]["address"].as_str().unwrap()).unwrap().covered.is_empty());
    }

    #[test]
    fn owns_refuses_what_is_not_an_address() {
        let w = wallets();
        assert!(matches!(owns(w["receive"]["uivk"].as_str().unwrap(), "utest1notanaddress"), Err(VerifyError::BadAddress(_))));
    }

    #[test]
    fn transparent_allowed_when_asked() {
        let e = Expect { shielded_only: false, ..E(100, None) };
        assert!(check(&report(vec![(100, None)], 2, true), &e).ok);
    }
}
