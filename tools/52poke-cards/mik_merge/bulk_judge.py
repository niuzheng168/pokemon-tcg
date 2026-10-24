"""Bounded, fail-closed semantic adjudication of an already staged report.

Public entry points: plan(run_dir, *, max_requests, ...) and
run(run_dir, *, max_requests, run_azure=False, ...). Both write an offline plan
before any possible inference. Only run's explicit opt-in permits inference.
The existing semantic engine owns the prompt, evidence validation and decisions.
Its globals are configured once, before starting this module's worker threads;
do not run another semantic job concurrently in the same Python process.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict, deque
from concurrent.futures import ThreadPoolExecutor, as_completed
import copy
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import json
from pathlib import Path
import re
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit

from . import semantics as engine
from .common import load, require, safe_path, write


CHUNK_SIZE = 4                 # Keep all six historical calibration bodies unchanged.
MAX_WORKERS = 8
MAX_RPM = 20
# User-verified capacities; headers are observations, never permission to raise
# these limits. Unknown explicit deployments use the smaller conservative cap.
NOMINAL_TPM = dict(zip(engine.DEFAULT_DEPLOYMENTS, (1_000_000, 500_000)))
TOKEN_OVERHEAD = 2048
RATE_LIMIT_HEADERS = frozenset({
    "x-ratelimit-limit", "x-ratelimit-limit-requests", "x-ratelimit-limit-tokens",
    "x-ratelimit-remaining", "x-ratelimit-remaining-requests", "x-ratelimit-remaining-tokens",
    "x-ratelimit-reset", "x-ratelimit-reset-requests", "x-ratelimit-reset-tokens",
    "retry-after", "retry-after-ms", "x-ms-retry-after-ms",
})
PROVENANCE_KEYS = {"source_file", "source_sha256", "source_slot"}
PAIR_FIELD = re.compile(r"(?:(?:attacks|abilities)\.(?:0|[1-9]\d*)\.effect|effects)\Z")
PRINTING_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*\Z")
HASH = re.compile(r"[0-9a-f]{64}\Z")


def utc():
    return datetime.now(timezone.utc).isoformat()


def token_limit(deployment):
    return NOMINAL_TPM.get(deployment, min(NOMINAL_TPM.values())) * 4 // 5


def token_pacing():
    return {
        "window_seconds": 60, "nominal_tpm_fraction": 0.8,
        "reservation_limits": {name: token_limit(name) for name in engine.DEPLOYMENTS},
        "estimator": "canonical_request_utf8_bytes_plus_max_tokens_plus_2048_overhead",
        "applies_to": "uncached_outgoing_attempts_only", "refund_on_completion": False,
        "limits_auto_increased": False,
    }


def rate_limit_headers(headers):
    """Only bounded numeric/duration/date values from an exact header allowlist."""
    result = {}
    if headers is None:
        return result
    for key, value in headers.items():
        name = key.lower()
        if name not in RATE_LIMIT_HEADERS or not isinstance(value, str):
            continue
        value = value.strip()
        if not value or len(value) > 128 or not value.isascii() or any(ord(c) < 32 for c in value):
            continue
        valid = bool(re.fullmatch(r"\d+(?:\.\d+)?", value))
        if "reset" in name or name == "retry-after":
            valid |= bool(re.fullmatch(r"(?:\d+(?:\.\d+)?(?:ms|s|m|h|d))+", value))
            if not valid:
                try:
                    valid = parsedate_to_datetime(value) is not None
                except (ValueError, TypeError, OverflowError):
                    pass
        if valid:
            result[name] = value
    return result


def body_key(pair):
    """No normalized similarity: raw strings AND verified context must agree."""
    visible = engine.visible_pair(pair, 0, False)
    visible.pop("pair_id")
    meaning = {k: v for k, v in pair["context"].items() if k not in PROVENANCE_KEYS}
    return engine.sha(engine.encoded({
        "left": pair["left"], "right": pair["right"],
        "visible": visible, "verified_context_meaning": meaning,
    }))


def request_payload(pairs, reviewer):
    """Byte-for-byte compatible with Foundry.review (including calibration)."""
    visible = [engine.visible_pair(p, i, reviewer == 1) for i, p in enumerate(pairs)]
    return {
        "model": engine.DEPLOYMENTS[reviewer], "temperature": 0, "max_tokens": 11000,
        "messages": [{"role": "system", "content": engine.SYSTEM},
                     {"role": "user", "content": json.dumps({"pairs": visible}, ensure_ascii=False)}],
        "response_format": {"type": "json_schema", "json_schema": {
            "name": "tcg_rule_equivalence", "strict": True,
            "schema": engine.response_schema([p["pair_id"] for p in visible]),
        }},
    }


def _bytes(root, path, raw):
    path = safe_path(root, path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = safe_path(root, path.with_suffix(path.suffix + ".tmp"))
    temporary.write_bytes(raw)
    temporary.replace(path)


@dataclass
class Request:
    pairs: list
    reviewer: int
    group: str
    payload: dict = field(init=False)
    digest: str = field(init=False)
    reserved_tokens: int = field(init=False)
    cache_state: str = "missing"
    cache: tuple | None = None
    cache_error: str | None = None

    def __post_init__(self):
        self.payload = request_payload(self.pairs, self.reviewer)
        body = engine.encoded(self.payload)
        self.digest = engine.sha(body)
        # UTF-8 bytes deliberately overestimate input tokens, including the
        # repeated evidence spans and JSON schema. Reserve the full output cap.
        self.reserved_tokens = len(body) + self.payload["max_tokens"] + TOKEN_OVERHEAD

    @property
    def prefix(self):
        return engine.OUT / "cloud" / f"{self.group}-reviewer-{self.reviewer + 1}-{self.digest[:16]}"

    @property
    def paths(self):
        return tuple(self.prefix.with_suffix(f".{kind}.json") for kind in ("request", "response", "receipt"))

    def public(self):
        return {
            "group": self.group, "deployment": engine.DEPLOYMENTS[self.reviewer],
            "reviewer": self.reviewer + 1, "source_order_reversed": self.reviewer == 1,
            "request_sha256": self.digest, "pair_ids": [p["id"] for p in self.pairs],
            "input_sha256": [p.get("input_sha256") for p in self.pairs],
            "pair_count": len(self.pairs), "cache_state": self.cache_state,
            "cache_error": self.cache_error,
            "token_reservation": self.reserved_tokens,
        }


class CacheIndex:
    """Index full hashes, never names, results.json, or unverified responses.

    A damaged or incomplete matching triple is an error, not a cache miss. That
    applies even if a second source contains an apparently valid duplicate.
    """
    def __init__(self, roots):
        self.entries = defaultdict(list)
        self.short_entries = defaultdict(list)
        seen = set()
        for root in roots:
            root = Path(root).resolve()
            if root in seen:
                continue
            seen.add(root)
            prefixes = set()
            for kind in ("request", "response", "receipt"):
                suffix = f".{kind}.json"
                prefixes.update(str(p)[:-len(suffix)] for p in root.glob("*" + suffix))
            for prefix in sorted(prefixes):
                paths = tuple(Path(prefix + f".{kind}.json") for kind in ("request", "response", "receipt"))
                keys, receipt, valid = set(), {}, False
                try:
                    raw_request = paths[0].read_bytes()
                    keys.add(engine.sha(raw_request))
                    canonical = engine.sha(engine.encoded(json.loads(raw_request)))
                    keys.add(canonical)
                    receipt = load(paths[2])
                    if isinstance(receipt, dict) and HASH.fullmatch(str(receipt.get("request_sha256", ""))):
                        keys.add(receipt["request_sha256"])
                    raw_response = paths[1].read_bytes()
                    valid = (
                        engine.sha(raw_request) == canonical == receipt.get("request_sha256")
                        and engine.sha(raw_response) == receipt.get("response_sha256")
                    )
                except Exception:
                    # Do not expose parser exceptions, paths, or provider text.
                    try:
                        receipt = load(paths[2])
                        digest = receipt.get("request_sha256")
                        if isinstance(digest, str) and HASH.fullmatch(digest):
                            keys.add(digest)
                    except Exception:
                        receipt = {}
                entry = (valid, paths, receipt)
                for key in keys:
                    self.entries[key].append(entry)
                short = re.search(r"-([0-9a-f]{16})$", prefix)
                if short:
                    self.short_entries[short[1]].append(entry)

    def match(self, request):
        entries = self.entries.get(request.digest, [])
        # Filename suffix is only a way to detect an incomplete/corrupt cache;
        # it can never establish a successful full-hash match.
        if not entries and self.short_entries.get(request.digest[:16]):
            return "error", None, "cache_integrity_error"
        if not entries:
            return "missing", None, None
        for valid, paths, receipt in entries:
            if not valid or (
                receipt.get("deployment") != engine.DEPLOYMENTS[request.reviewer]
                or receipt.get("source_order_reversed") is not (request.reviewer == 1)
                or receipt.get("pair_count") != len(request.pairs)
            ):
                return "error", None, "cache_integrity_error"
        return "cached", entries[0][1], None


@dataclass
class Prepared:
    root: Path
    base: dict
    base_hash: str
    pairs: list
    pair_errors: dict
    errors: list
    metadata: dict
    files: dict
    aliases: dict
    requests: list
    document: dict


def _collect(base, root):
    pairs, pair_errors, errors, metadata, files = [], {}, [], {}, {}
    seen = set()
    for result in base["results"]:
        card = result["mik_id"]
        require(isinstance(card, str) and PRINTING_ID.fullmatch(card), "Unsafe MIK printing identifier.")
        require(card not in seen, "Duplicate card in staged report.")
        seen.add(card)
        files[card] = {}
        location = result.get("merged_metadata_file")
        if location:
            path = safe_path(root, Path(location))
            require(not path.resolve().is_relative_to(engine.OUT.resolve()), "Base candidate overlaps semantic output.")
            try:
                metadata[card] = load(path)
                require(isinstance(metadata[card], dict), "Invalid base candidate.")
                files[card][str(path)] = engine.sha(path.read_bytes())
            except Exception:
                metadata.pop(card, None)
                errors.append({"code": "base_candidate_invalid", "card_id": card})
        blocked = not result.get("chosen") or result.get("status") == "blocked"
        if blocked:
            if result.get("semantic_pairs"):
                errors.append({"code": "blocked_card_has_semantic_pairs", "card_id": card})
            continue
        if location:
            for name in ("mik-metadata.json", "normalized-wiki-source.json", "normalized-wiki-display.json"):
                path = safe_path(root, Path(location).parent / name)
                try:
                    files[card][str(path)] = engine.sha(path.read_bytes())
                except Exception:
                    errors.append({"code": "frozen_source_missing", "card_id": card})
        fields = set()
        for item in result.get("semantic_pairs", []):
            name = item.get("field", "")
            require(isinstance(name, str), "Invalid semantic field.")
            identity = card + ":" + name
            if name in fields:
                pair_errors[identity] = "ambiguous_source_slot"
                errors.append({"code": "ambiguous_source_slot", "pair_id": identity, "card_id": card})
                continue
            fields.add(name)
            try:
                require(PAIR_FIELD.fullmatch(name), "Ambiguous source slot.")
                block = result["chosen"]["block"]
                require(type(block) is int and block >= 0, "Ambiguous source block.")
                require(card in metadata, "Missing base candidate.")
                singleton = {**result, "semantic_pairs": [item]}
                pair = engine.source_pairs({"results": [singleton]})[0]
                require(all(isinstance(pair[s], str) for s in ("left", "right")), "Invalid source text.")
            except Exception:
                pair = {
                    "id": identity, "kind": "source_pair", "card_id": card, "field": name,
                    "left": item.get("mik") if isinstance(item.get("mik"), str) else "",
                    "right": item.get("wiki") if isinstance(item.get("wiki"), str) else "",
                    "base_status": item.get("status"), "context": {},
                }
                pair["input_sha256"] = engine.sha(engine.encoded(pair))
                pair_errors[identity] = "source_validation_failed"
                errors.append({"code": "source_validation_failed", "pair_id": identity, "card_id": card})
            if max(len(pair["left"]), len(pair["right"])) > 4000:
                pair_errors[identity] = "effect_text_exceeds_bound"
                errors.append({"code": "effect_text_exceeds_bound", "pair_id": identity, "card_id": card})
            pairs.append(pair)
    return pairs, pair_errors, errors, metadata, files


def _prepare(run_dir, *, max_requests, env=None, azure_host=None,
             workers_per_deployment=8, requests_per_minute=20, cache_sources=(),
             deployments=None):
    require(type(max_requests) is int and max_requests > 0, "An explicit positive max_requests is required.")
    require(type(workers_per_deployment) is int and 1 <= workers_per_deployment <= MAX_WORKERS,
            "workers_per_deployment must be between 1 and 8.")
    require(type(requests_per_minute) is int and 1 <= requests_per_minute <= MAX_RPM,
            "requests_per_minute must be between 1 and 20.")
    engine.configure(run_dir, deployments=deployments, max_requests=max_requests)
    root = engine.ROOT
    require(not engine.OUT.is_symlink(), "Semantic output must not alias another directory.")
    safe_path(engine.OUT, engine.OUT / "cloud")
    raw = (root / "pilot-results.json").read_bytes()
    base, base_hash = json.loads(raw), engine.sha(raw)
    require(isinstance(base.get("results"), list), "Missing staged results.")
    if (root / "run-inputs.json").is_file():
        saved = load(root / "run-inputs.json")
        protected = [v for k, v in saved.items() if k in ("source", "snapshot", "observations") and v]
        if saved.get("selection"):
            selection = Path(saved["selection"]).absolute()
            if selection.is_relative_to(root):
                safe_path(root, selection)
                require(selection == root / "full-selection.json" and selection.is_file()
                        and not selection.is_symlink(),
                        "Only a regular run-owned full-selection.json may overlap the run.")
                require(engine.sha(selection.read_bytes()) == base.get("selection_sha256"),
                        "Run-owned selection does not match the frozen report hash.")
            else:
                protected.append(selection)
        engine.output_root(root, protected=protected)
    pairs, pair_errors, errors, metadata, files = _collect(base, root)
    aliases = {}
    representatives = []
    skipped_by_hard_veto = 0
    for pair in pairs:
        if pair["base_status"] != "needs_semantic_review" or pair["id"] in pair_errors:
            continue
        if engine.hard_checks(pair)["vetoes"]:
            skipped_by_hard_veto += 1
            continue
        key = body_key(pair)
        if key not in aliases:
            representatives.append(pair)
            aliases[key] = []
        aliases[key].append(pair)
    requests = []
    for kind, items in (("controls", engine.controls() if representatives else []),
                        ("source-pairs", representatives)):
        for offset in range(0, len(items), CHUNK_SIZE):
            group = f"controls-{offset // CHUNK_SIZE + 1}" if kind == "controls" else (
                "source-pairs" if offset == 0 else f"source-pairs-{offset // CHUNK_SIZE + 1}")
            requests.extend(Request(items[offset:offset + CHUNK_SIZE], reviewer, group) for reviewer in (0, 1))
    cache = CacheIndex([engine.OUT / "cloud", *cache_sources])
    previous = load(engine.OUT / "attempt-ledger.json") if (engine.OUT / "attempt-ledger.json").exists() else {"attempts": []}
    attempted = {a["request_sha256"] for a in previous["attempts"]}
    for request in requests:
        request.cache_state, request.cache, request.cache_error = cache.match(request)
        if request.cache_state == "missing" and request.digest in attempted:
            request.cache_state, request.cache_error = "error", "previous_attempt_without_valid_cache"
    count = Counter(r.cache_state for r in requests)
    document = {
        "schema": "mik-52poke-bulk-semantic-plan-v1", "base_report_sha256": base_hash,
        "engine_sha256": engine.sha(Path(engine.__file__).read_bytes()),
        "bulk_engine_sha256": engine.sha(Path(__file__).read_bytes()),
        "card_count": len(base["results"]), "source_pair_count_including_empty": len(pairs),
        "model_source_pair_count": sum(len(v) for v in aliases.values()),
        "skipped_by_hard_veto": skipped_by_hard_veto,
        "skipped_oversized_pairs": sum(v == "effect_text_exceeds_bound" for v in pair_errors.values()),
        "exact_unique_body_count": len(representatives),
        "deduplicated_source_pair_count": sum(len(v) - 1 for v in aliases.values()),
        "calibration_request_count": 6 if representatives else 0,
        "planned_request_count": len(requests), "uncached_request_count": count["missing"],
        "cached_request_count": count["cached"], "invalid_cache_count": count["error"],
        "max_requests": max_requests, "budget_sufficient": count["missing"] <= max_requests,
        "workers_per_deployment": workers_per_deployment, "requests_per_minute": requests_per_minute,
        "token_pacing": token_pacing(),
        "deployments": list(engine.DEPLOYMENTS), "chunk_size": CHUNK_SIZE,
        "expected_answers_sent_to_models": False, "network_requests_made": 0,
        "deduplication": "exact_raw_left_right_and_equivalent_verified_context_only",
        "dedup_groups": [{"body_sha256": key, "representative_id": group[0]["id"],
                          "pairs": [{"id": p["id"], "input_sha256": p["input_sha256"]} for p in group]}
                         for key, group in aliases.items()],
        "requests": [r.public() for r in requests], "diagnostics": errors,
    }
    # The plan is durable even when the explicitly requested budget is too small.
    write(root, root / "semantic-plan.json", document)
    return Prepared(root, base, base_hash, pairs, pair_errors, errors, metadata, files,
                    aliases, requests, document)


def plan(run_dir, *, max_requests, env=None, azure_host=None,
         workers_per_deployment=8, requests_per_minute=20, cache_sources=(), deployments=None):
    """Offline: no credential reads, network, or cache mutation."""
    return _prepare(run_dir, max_requests=max_requests, env=env, azure_host=azure_host,
                    workers_per_deployment=workers_per_deployment, requests_per_minute=requests_per_minute,
                    cache_sources=cache_sources, deployments=deployments).document


def credentials(env, azure_host):
    """Only the explicit .env.foundry API key; never process env/Entra tokens."""
    require(env is not None and Path(env).name == ".env.foundry", "An explicit .env.foundry is required.")
    cfg = {}
    for line in Path(env).read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            cfg[key.strip()] = value.strip().strip("\"'")
    endpoint = cfg.get("AOAI_ENDPOINT", "").rstrip("/")
    parsed = urlsplit(endpoint)
    require(isinstance(azure_host, str) and azure_host == azure_host.lower()
            and parsed.hostname == azure_host, "Explicit --azure-host must match AOAI_ENDPOINT.")
    require(any(azure_host.endswith(suffix) for suffix in (
        ".openai.azure.com", ".cognitiveservices.azure.com", ".services.ai.azure.com")),
        "Only explicit Azure service hosts are allowed.")
    require(parsed.scheme == "https" and parsed.path == "/openai/v1" and parsed.port in (None, 443)
            and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment,
            "Expected a clean HTTPS Azure /openai/v1 endpoint.")
    key = cfg.get("AZURE_OPENAI_API_KEY") or cfg.get("FOUNDRY_KEY")
    require(bool(key), "An API key is required; Entra inference is not supported.")
    return endpoint, key


class RateGate:
    """Combined rolling request/token ceilings plus conservative even spacing."""
    def __init__(self, rpm, token_limit=None):
        self.rpm, self.next_at = rpm, 0.0
        self.events = deque()
        self.token_limit = token_limit
        self.token_events = deque()
        self.reserved_in_window = 0
        self.lock = threading.Lock()

    def wait(self, reserved_tokens=0):
        require(type(reserved_tokens) is int and reserved_tokens >= 0, "Invalid token reservation.")
        if self.token_limit is not None and reserved_tokens > self.token_limit:
            raise Diagnostic("request_token_reservation_exceeds_limit")
        with self.lock:
            while True:
                now = time.monotonic()
                while self.events and now - self.events[0] >= 60:
                    self.events.popleft()
                while self.token_events and now - self.token_events[0][0] >= 60:
                    self.reserved_in_window -= self.token_events.popleft()[1]
                delay = max(0, self.next_at - now)
                if len(self.events) >= self.rpm:
                    delay = max(delay, self.events[0] + 60 - now)
                if self.token_limit is not None and self.reserved_in_window + reserved_tokens > self.token_limit:
                    delay = max(delay, self.token_events[0][0] + 60 - now)
                if delay <= 0:
                    self.events.append(now)
                    self.next_at = now + 60 / self.rpm
                    if reserved_tokens:
                        self.token_events.append((now, reserved_tokens))
                        self.reserved_in_window += reserved_tokens
                    return
                time.sleep(delay)


class Diagnostic(Exception):
    def __init__(self, code, http_status=None, headers=None):
        super().__init__(code)
        self.code, self.http_status = code, http_status
        self.headers = headers or {}


class Coordinator:
    def __init__(self, prepared, max_requests, rpm, env, azure_host):
        self.prepared, self.max_requests = prepared, max_requests
        self.env, self.azure_host = env, azure_host
        self.lock = threading.RLock()
        self.gates = [RateGate(rpm, token_limit(name)) for name in engine.DEPLOYMENTS]
        self.calls = 0
        self.reservations = Counter()
        self.outcomes = []
        self.usage = Counter()
        self.fresh_usage = Counter()
        self.cached_usage = Counter()
        self.path = engine.OUT / "attempt-ledger.json"
        self.ledger = load(self.path) if self.path.exists() else {"schema": "mik-52poke-attempt-ledger-v1", "attempts": []}
        self._credentials = None

    def _save(self):
        write(engine.OUT, self.path, self.ledger)

    def _network(self, request):
        # Validate credentials before reserving an outgoing attempt.
        with self.lock:
            if self._credentials is None:
                try:
                    self._credentials = credentials(self.env, self.azure_host)
                except Exception:
                    raise Diagnostic("credential_configuration_invalid") from None
            endpoint, key = self._credentials
        body = engine.encoded(request.payload)
        wire = urllib.request.Request(endpoint + "/chat/completions", data=body, headers={
            "api-key": key, "Content-Type": "application/json",
        })
        opener = urllib.request.build_opener(engine.NoRedirect())
        self.gates[request.reviewer].wait(request.reserved_tokens)
        with self.lock:
            if self.calls >= self.max_requests:
                raise Diagnostic("request_budget_exhausted")
            # Ledger persistence precedes the actual outgoing open, including failures.
            attempt = {
                **request.public(), "attempt_number": len(self.ledger["attempts"]) + 1,
                "started_at_utc": utc(), "status": "attempted",
            }
            self.ledger["attempts"].append(attempt)
            self._save()
            self.calls += 1
            self.reservations[engine.DEPLOYMENTS[request.reviewer]] += request.reserved_tokens
        started = time.monotonic()
        try:
            try:
                with opener.open(wire, timeout=180) as stream:
                    headers = rate_limit_headers(getattr(stream, "headers", None))
                    raw = stream.read(8_000_001)
            except urllib.error.HTTPError as error:
                status = error.code
                headers = rate_limit_headers(error.headers)
                try:
                    error.close()
                except Exception:
                    pass
                raise Diagnostic("azure_http_error", status, headers) from None
            except Exception:
                raise Diagnostic("azure_transport_error") from None
            # Archive successful HTTP bytes even when JSON/schema validation fails.
            try:
                response = json.loads(raw) if len(raw) <= 8_000_000 else {}
            except Exception:
                response = {}
            receipt = {
                "at_utc": utc(), "request_sha256": request.digest, "response_sha256": engine.sha(raw),
                "deployment": engine.DEPLOYMENTS[request.reviewer],
                "returned_model": response.get("model") if isinstance(response, dict) else None,
                "usage": response.get("usage") if isinstance(response, dict) else None,
                "source_order_reversed": request.reviewer == 1, "pair_count": len(request.pairs),
                "elapsed_seconds": round(time.monotonic() - started, 3),
                "response_bytes_archived": len(raw), "response_body_truncated": len(raw) > 8_000_000,
                "rate_limit_headers": headers, "token_reservation": request.reserved_tokens,
                "rolling_token_reservation_limit": self.gates[request.reviewer].token_limit,
            }
            for path, value in zip(request.paths, (body, raw, engine.encoded(receipt))):
                _bytes(engine.OUT, path, value)
            with self.lock:
                attempt.update(response_sha256=receipt["response_sha256"], usage=receipt["usage"],
                               rate_limit_headers=headers)
                self._save()
            if len(raw) > 8_000_000:
                raise Diagnostic("oversized_model_response")
        except Exception as error:
            with self.lock:
                attempt.update(status="failed", finished_at_utc=utc(),
                               error_code=error.code if isinstance(error, Diagnostic) else "archive_error")
                if isinstance(error, Diagnostic) and error.http_status is not None:
                    attempt["http_status"] = error.http_status
                    attempt["rate_limit_headers"] = error.headers
                    # HTTP failures have no archived model body and must not
                    # masquerade as replayable request/response/hash triples.
                    error_path = request.prefix.with_suffix(".error-receipt.json")
                    write(engine.OUT, error_path, {
                        "at_utc": utc(), "request_sha256": request.digest,
                        "deployment": engine.DEPLOYMENTS[request.reviewer],
                        "source_order_reversed": request.reviewer == 1,
                        "pair_count": len(request.pairs), "http_status": error.http_status,
                        "error_code": error.code, "rate_limit_headers": error.headers,
                        "token_reservation": request.reserved_tokens,
                        "rolling_token_reservation_limit": self.gates[request.reviewer].token_limit,
                        "model_response_body_archived": False,
                    })
                    attempt["error_receipt_file"] = str(error_path)
                self._save()
            raise
        return attempt

    def execute(self, request, allow_network):
        outcome = {**request.public(), "cached": request.cache_state == "cached", "status": "failed"}
        attempt = None
        rows = {}
        try:
            if request.cache_state == "error":
                raise Diagnostic(request.cache_error)
            if request.cache_state == "cached":
                # Re-check bytes at use time (the offline index is not authority).
                paths = request.cache
                raw_request, raw_response, raw_receipt = (p.read_bytes() for p in paths)
                if len(raw_response) > 8_000_000:
                    raise Diagnostic("oversized_model_response")
                receipt = json.loads(raw_receipt)
                if not (
                    engine.sha(raw_request) == request.digest == receipt.get("request_sha256")
                    and engine.sha(raw_response) == receipt.get("response_sha256")
                    and receipt.get("deployment") == engine.DEPLOYMENTS[request.reviewer]
                    and receipt.get("source_order_reversed") is (request.reviewer == 1)
                    and receipt.get("pair_count") == len(request.pairs)
                ):
                    raise Diagnostic("cache_integrity_error")
                for source, target, raw in zip(paths, request.paths, (raw_request, raw_response, raw_receipt)):
                    if source.resolve() != target.resolve():
                        _bytes(engine.OUT, target, raw)
            else:
                if not allow_network:
                    raise Diagnostic("matching_cache_missing")
                attempt = self._network(request)
            # Each worker's client handles exactly one request, cache-only. This
            # reuses strict output validation, reversal and literal original spans.
            client = engine.Foundry(False)
            rows = client.review(request.pairs, request.reviewer, request.group)
            require(set(rows) == {p["id"] for p in request.pairs}, "Incomplete request results.")
            outcome["status"] = "complete"
        except Exception as error:
            outcome["error_code"] = error.code if isinstance(error, Diagnostic) else "request_validation_failed"
            if isinstance(error, Diagnostic) and error.http_status is not None:
                outcome["http_status"] = error.http_status
                outcome["rate_limit_headers"] = error.headers
                outcome["error_receipt_file"] = str(request.prefix.with_suffix(".error-receipt.json"))
        finally:
            # Receipt accounting is independent of evidence validation success.
            receipt_path = request.paths[2]
            if receipt_path.is_file() and request.cache_state != "error":
                try:
                    receipt = load(receipt_path)
                    require(receipt["request_sha256"] == request.digest
                            and engine.sha(request.paths[0].read_bytes()) == request.digest
                            and engine.sha(request.paths[1].read_bytes()) == receipt["response_sha256"],
                            "Receipt hash mismatch.")
                    outcome.update(response_sha256=receipt["response_sha256"], usage=receipt.get("usage"))
                    if "rate_limit_headers" in receipt:
                        outcome["rate_limit_headers"] = rate_limit_headers(receipt["rate_limit_headers"])
                except Exception:
                    outcome["status"], outcome["error_code"], rows = "failed", "cache_integrity_error", {}
            if attempt is not None:
                with self.lock:
                    attempt.update(status=outcome["status"], finished_at_utc=utc())
                    if outcome.get("error_code"):
                        attempt["error_code"] = outcome["error_code"]
                    self._save()
        return rows if outcome["status"] == "complete" else {}, outcome

    def completed(self, outcome):
        with self.lock:
            self.outcomes.append(outcome)
            usage = outcome.get("usage")
            if isinstance(usage, dict):
                tokens = Counter({k: v for k, v in usage.items() if type(v) is int})
                self.usage.update(tokens)
                (self.cached_usage if outcome["cached"] else self.fresh_usage).update(tokens)

    def checkpoint(self, phase, calibration_passed=None):
        with self.lock:
            errors = self.prepared.errors + [
                {"code": o["error_code"], "request_sha256": o["request_sha256"],
                 "group": o["group"], "deployment": o["deployment"]}
                for o in self.outcomes if o.get("error_code")]
            value = {
                "schema": "mik-52poke-judge-progress-v1", "updated_at_utc": utc(), "phase": phase,
                "card_count": len(self.prepared.base["results"]), "source_pair_count": len(self.prepared.pairs),
                "exact_unique_body_count": self.prepared.document["exact_unique_body_count"],
                "planned_requests": len(self.prepared.requests), "completed_requests": len(self.outcomes),
                "completed_chunks": len(self.outcomes), "actual_calls": self.calls,
                "max_requests": self.max_requests,
                "token_pacing": token_pacing(), "token_reservations": dict(self.reservations),
                "caches": sum(o["cached"] for o in self.outcomes),
                "successful_requests": sum(o["status"] == "complete" for o in self.outcomes),
                "calibration_passed": calibration_passed, "tokens": dict(self.usage),
                "fresh_tokens": dict(self.fresh_usage), "cached_tokens": dict(self.cached_usage),
                "error_count": len(errors), "errors": errors,
            }
            write(self.prepared.root, self.prepared.root / "judge-progress.json", value)
            return value


def _control_ok(pair, row):
    return row["verdict"] in engine.ACCEPTED if pair["expected_accept"] else row["verdict"] == "different"


def _phase(requests, coordinator, judges, *, allow_network, workers, phase, calibration_passed=None):
    def finish(request, result):
        rows, outcome = result
        for identity, row in rows.items():
            judges[identity].append(row)
        coordinator.completed(outcome)
        coordinator.checkpoint(phase, calibration_passed)

    # Replay all available caches first, without credentials or thread creation.
    for request in requests:
        if request.cache_state != "missing":
            finish(request, coordinator.execute(request, False))
    missing = [r for r in requests if r.cache_state == "missing"]
    if phase == "calibration":
        failed_cached = any(o["status"] != "complete" for o in coordinator.outcomes)
        failed_cached |= any(not _control_ok(p, row) for p in engine.controls() for row in judges[p["id"]])
        if failed_cached:
            allow_network = False
    # Separate pools give each deployment its own hard concurrency ceiling.
    with ThreadPoolExecutor(max_workers=workers) as first, ThreadPoolExecutor(max_workers=workers) as second:
        pools = (first, second)
        futures = {pools[r.reviewer].submit(coordinator.execute, r, allow_network): r for r in missing}
        for future in as_completed(futures):
            request = futures[future]
            try:
                result = future.result()
            except Exception:
                result = ({}, {**request.public(), "cached": False, "status": "failed",
                               "error_code": "worker_failed"})
            finish(request, result)
    # Completion order must not change per-printing evidence or candidate hashes
    # between a parallel first run and a sequential cache-only replay.
    order = {deployment: i for i, deployment in enumerate(engine.DEPLOYMENTS)}
    for rows in judges.values():
        rows.sort(key=lambda row: order[row["deployment"]])


def propagate_review(pair, representative, review):
    """Validate every printing's literal spans again; never trust alias identity."""
    require(body_key(pair) == body_key(representative), "Nonexact duplicate propagation.")
    row = {
        "pair_id": "p000", "verdict": review["verdict"], "summary": review["summary"],
        "dimensions": [{k: copy.deepcopy(d[k]) for k in (
            "dimension", "relation", "left_evidence_ids", "right_evidence_ids", "explanation")}
                       for d in review["dimensions"]],
    }
    validated = engine.validate_output({"results": [row]}, [engine.visible_pair(pair, 0, False)])["p000"]
    for original, checked in zip(review["dimensions"], validated["dimensions"]):
        for side in ("left", "right"):
            require(original[side + "_spans"] == checked[side + "_spans"]
                    and original[side + "_quotes"] == checked[side + "_quotes"],
                    "Duplicate evidence differs from target source spans.")
            for span in checked[side + "_spans"]:
                require(pair[side][span["start"]:span["end"]] == span["text"],
                        "Duplicate evidence is not literal original source text.")
    return {
        **copy.deepcopy(review), "source_pair_id": representative["id"],
        "printing_pair_id": pair["id"], "printing_input_sha256": pair["input_sha256"],
        "propagated_exact_duplicate": pair["id"] != representative["id"],
    }


def _changed(prepared):
    changed = set()
    for card, files in prepared.files.items():
        for path, expected in files.items():
            try:
                require(engine.sha(Path(path).read_bytes()) == expected, "Frozen input changed.")
            except Exception:
                changed.add(card)
    return changed


def _decisions(prepared, judges, calibration_passed):
    decisions = {}
    representatives = {body_key(group[0]): group[0] for group in prepared.aliases.values()}
    for pair in prepared.pairs:
        rows, failure = [], prepared.pair_errors.get(pair["id"])
        checks = engine.hard_checks(pair)
        if not failure and pair["base_status"] == "needs_semantic_review":
            if not checks["vetoes"]:
                representative = representatives[body_key(pair)]
                try:
                    rows = [propagate_review(pair, representative, row) for row in judges[representative["id"]]]
                except Exception:
                    failure = "duplicate_evidence_validation_failed"
            decision = engine.decide(pair, rows, calibration_passed)
            if checks["vetoes"]:
                decision["model_skipped"] = "hard_veto"
        else:
            same = engine.layout(pair["left"]) == engine.layout(pair["right"])
            safe = same or engine.layout(engine.strip_verified_reminder(pair["left"], pair["context"])) == (
                engine.layout(engine.strip_verified_reminder(pair["right"], pair["context"])))
            accepted = safe and not checks["vetoes"] and not failure
            decision = {
                "id": pair["id"], "input_sha256": pair["input_sha256"],
                "decision": ("deterministic_equal" if same else "deterministic_equal_with_reminder") if accepted else "needs_review",
                "machine_accepted": accepted, "human_reviewed": False, "reviews": [],
                "hard_checks": checks, "hold_reasons": [] if accepted else ["deterministic_gate_failed"],
            }
        if failure:
            decision.update(decision="needs_review", machine_accepted=False)
            decision["hold_reasons"].append(failure)
        decisions[pair["id"]] = {
            **decision, "left": pair["left"], "right": pair["right"], "context": pair["context"],
            "field": pair["field"], "card_id": pair["card_id"],
        }
    return decisions


def run(run_dir, *, max_requests, run_azure=False, env=None, azure_host=None,
        workers_per_deployment=8, requests_per_minute=20, cache_sources=(), deployments=None):
    """Produce semantic-v2/results.json; never modify sources/base candidates."""
    prepared = _prepare(
        run_dir, max_requests=max_requests, env=env, azure_host=azure_host,
        workers_per_deployment=workers_per_deployment, requests_per_minute=requests_per_minute,
        cache_sources=cache_sources, deployments=deployments)
    if run_azure:
        require(prepared.document["budget_sufficient"],
                f"Plan requires {prepared.document['uncached_request_count']} uncached requests; "
                "explicit --max-requests is insufficient. No requests sent.")
    require(engine.sha((prepared.root / "pilot-results.json").read_bytes()) == prepared.base_hash
            and not _changed(prepared), "Frozen inputs changed while planning. No requests sent.")
    coordinator = Coordinator(prepared, max_requests, requests_per_minute, env, azure_host)
    coordinator.checkpoint("planned")
    judges = defaultdict(list)
    control_requests = [r for r in prepared.requests if r.group.startswith("controls-")]
    source_requests = [r for r in prepared.requests if not r.group.startswith("controls-")]
    calibration = engine.controls() if control_requests else []
    _phase(control_requests, coordinator, judges, allow_network=run_azure,
           workers=workers_per_deployment, phase="calibration")
    calibration_results = []
    for pair in calibration:
        rows = judges[pair["id"]]
        passed = (
            len(rows) == 2 and {r["deployment"] for r in rows} == set(engine.DEPLOYMENTS)
            and all(_control_ok(pair, r) for r in rows)
        )
        calibration_results.append({
            **pair, "passed": passed, "model_only_verdicts": [r["verdict"] for r in rows],
            "deterministic_checks": engine.hard_checks(pair), "reviews": rows,
        })
    calibration_passed = all(c["passed"] for c in calibration_results)
    calibration_report = {
        "control_count": len(calibration_results), "passed": calibration_passed,
        "expected_answers_sent_to_models": False, "controls": calibration_results,
    }
    write(engine.OUT, engine.OUT / "calibration.json", calibration_report)
    coordinator.checkpoint("source", calibration_passed)
    # A failed calibration can replay source caches, but cannot start new inference.
    _phase(source_requests, coordinator, judges, allow_network=run_azure and calibration_passed,
           workers=workers_per_deployment, phase="source", calibration_passed=calibration_passed)
    changed = _changed(prepared)
    if engine.sha((prepared.root / "pilot-results.json").read_bytes()) != prepared.base_hash:
        changed.update(r["mik_id"] for r in prepared.base["results"])
    for card in sorted(changed):
        prepared.errors.append({"code": "frozen_input_changed", "card_id": card})
    for pair in prepared.pairs:
        if pair["card_id"] in changed:
            prepared.pair_errors[pair["id"]] = "frozen_input_changed"
    decisions = _decisions(prepared, judges, calibration_passed)
    request_errors = defaultdict(list)
    for outcome in coordinator.outcomes:
        if outcome.get("error_code"):
            for identity in outcome["pair_ids"]:
                request_errors[identity].append({
                    "code": outcome["error_code"], "deployment": outcome["deployment"],
                    "request_sha256": outcome["request_sha256"],
                })
    for group in prepared.aliases.values():
        diagnostics = request_errors[group[0]["id"]]
        for pair in group:
            if diagnostics:
                decision = decisions[pair["id"]]
                decision["request_diagnostics"] = copy.deepcopy(diagnostics)
                decision["hold_reasons"].extend(sorted({d["code"] for d in diagnostics}))
    by_card = defaultdict(list)
    for decision in decisions.values():
        by_card[decision["card_id"]].append(decision)
    results = []
    cards_with_errors = {e["card_id"] for e in prepared.errors if e.get("card_id")}
    for original in prepared.base["results"]:
        result = copy.deepcopy(original)
        card = result["mik_id"]
        per_card = by_card[card]
        result.update(base_status=original["status"], base_holds=copy.deepcopy(original["holds"]),
                      semantic_equivalence=per_card)
        by_field = {d["field"]: d for d in per_card}
        if original.get("chosen") and original["status"] != "blocked":
            result["holds"] = [
                h for h in result["holds"] if not (
                    h["code"] == "effect_semantics_unresolved"
                    and by_field.get(h.get("field"), {}).get("machine_accepted", False))]
            for decision in per_card:
                if not decision["machine_accepted"] and not any(
                        h["code"] == "effect_semantics_unresolved" and h.get("field") == decision["field"]
                        for h in result["holds"]):
                    result["holds"].append({"code": "effect_semantics_unresolved", "field": decision["field"]})
            if card in cards_with_errors:
                result["holds"].append({"code": "semantic_input_validation_failed"})
            result["status"] = "needs_review" if result["holds"] else "ready"
        if card in prepared.metadata:
            metadata = copy.deepcopy(prepared.metadata[card])
            metadata["human_reviewed"] = False
            metadata["rules_engine_implemented"] = False
            if "rules_engine" in metadata:
                metadata["rules_engine"] = False
            metadata["semantic_equivalence_review"] = {
                "schema": "mik-52poke-equivalence-v2", "machine_only": True, "human_reviewed": False,
                "calibration_passed": calibration_passed, "decisions": per_card,
            }
            flags = {h["code"] for h in result["holds"]}
            flags.update(f for f in metadata.get("review_flags", [])
                         if f != "effect_semantics_unresolved" or f in flags)
            metadata["review_flags"] = sorted(flags)
            target = engine.OUT / "candidates" / card / "metadata.json"
            write(engine.OUT, target, metadata)
            result["base_merged_metadata_file"] = original["merged_metadata_file"]
            result["merged_metadata_file"] = str(target)
        results.append(result)
    counters = {
        "cards": len(results), "source_pairs": len(prepared.pairs),
        "unique_model_bodies": prepared.document["exact_unique_body_count"],
        "skipped_by_hard_veto": prepared.document["skipped_by_hard_veto"],
        "skipped_oversized_pairs": prepared.document["skipped_oversized_pairs"],
        "deduplicated_pairs": prepared.document["deduplicated_source_pair_count"],
        "actual_outgoing_attempts": coordinator.calls,
        "cache_hits": sum(o["cached"] for o in coordinator.outcomes),
        "successful_requests": sum(o["status"] == "complete" for o in coordinator.outcomes),
        "failed_requests": sum(o["status"] != "complete" for o in coordinator.outcomes),
        "accepted_pairs": sum(d["machine_accepted"] for d in decisions.values()),
        "held_pairs": sum(not d["machine_accepted"] for d in decisions.values()),
    }
    report = {
        "schema": "mik-52poke-equivalence-pilot-v2", "adjudicator": "bounded_parallel_bulk",
        "engine_sha256": prepared.document["engine_sha256"],
        "bulk_engine_sha256": prepared.document["bulk_engine_sha256"],
        "base_report_sha256": prepared.base_hash, "deployments": list(engine.DEPLOYMENTS),
        "calibration_passed": calibration_passed, "calibration_required": bool(calibration),
        "calibration": calibration_report, "control_count": len(calibration_results),
        "model_reviewed_source_pairs": prepared.document["model_source_pair_count"],
        "exact_unique_body_count": prepared.document["exact_unique_body_count"],
        "skipped_by_hard_veto": prepared.document["skipped_by_hard_veto"],
        "skipped_oversized_pairs": prepared.document["skipped_oversized_pairs"],
        "source_pair_count_including_empty": len(prepared.pairs),
        "deterministic_pair_count": sum(p["base_status"] != "needs_semantic_review" for p in prepared.pairs),
        "planned_request_count": len(prepared.requests), "max_requests": max_requests,
        "workers_per_deployment": workers_per_deployment, "requests_per_minute": requests_per_minute,
        "token_pacing": token_pacing(), "token_reservations": dict(coordinator.reservations),
        "fresh_requests_this_run": coordinator.calls,
        "request_count_including_cached": len(coordinator.outcomes),
        "cloud_usage": dict(coordinator.usage), "usage": dict(coordinator.usage),
        "fresh_cloud_usage": dict(coordinator.fresh_usage), "cached_cloud_usage": dict(coordinator.cached_usage),
        "status_counts": dict(Counter(r["status"] for r in results)),
        "base_status_counts": dict(Counter(r["status"] for r in prepared.base["results"])),
        "archive_release": prepared.base.get("archive_release"), "sampling": prepared.base.get("sampling"),
        "snapshot_sha256": prepared.base.get("snapshot_sha256"),
        "model_compared_scope": "effect_body_after_evidence_verified_standard_reminder_masking",
        "original_sources_and_candidates_modified": False, "production_library_modified": False,
        "is_accuracy_benchmark": False, "human_reviewed": False, "rules_engine_implemented": False,
        "counters": counters, "diagnostics": prepared.errors,
        "requests": coordinator.outcomes, "attempt_ledger_file": str(coordinator.path),
        "decisions": list(decisions.values()), "results": results,
    }
    write(engine.OUT, engine.OUT / "results.json", report)
    progress = coordinator.checkpoint("complete", calibration_passed)
    progress.update(status_counts=report["status_counts"], counters=counters)
    write(prepared.root, prepared.root / "judge-progress.json", progress)
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("plan", "run"))
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--env")
    parser.add_argument("--azure-host")
    parser.add_argument("--max-requests", type=int, required=True)
    parser.add_argument("--workers-per-deployment", type=int, default=8)
    parser.add_argument("--requests-per-minute", type=int, default=20)
    parser.add_argument("--run-azure", action="store_true")
    parser.add_argument("--cache-source", action="append", default=[])
    parser.add_argument("--reviewer-a", default=engine.DEFAULT_DEPLOYMENTS[0])
    parser.add_argument("--reviewer-b", default=engine.DEFAULT_DEPLOYMENTS[1])
    args = parser.parse_args(argv)
    options = dict(
        max_requests=args.max_requests, env=args.env, azure_host=args.azure_host,
        workers_per_deployment=args.workers_per_deployment, requests_per_minute=args.requests_per_minute,
        cache_sources=args.cache_source, deployments=(args.reviewer_a, args.reviewer_b))
    try:
        report = plan(args.run_dir, **options) if args.command == "plan" else run(
            args.run_dir, run_azure=args.run_azure, **options)
    except Exception:
        # No provider bodies, parser values, endpoint credentials or dotenv text.
        parser.exit(2, "Bulk adjudication stopped; check input integrity, explicit budget and local configuration.\n")
    keys = ("card_count", "exact_unique_body_count", "planned_request_count", "uncached_request_count",
            "cached_request_count", "invalid_cache_count", "budget_sufficient", "status_counts",
            "calibration_passed", "fresh_requests_this_run", "counters")
    print(json.dumps({k: report[k] for k in keys if k in report}, ensure_ascii=False, indent=2))
    return report


if __name__ == "__main__":
    main()
