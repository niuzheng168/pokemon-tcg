from concurrent.futures import ThreadPoolExecutor, as_completed
import argparse
import fcntl
import json
from pathlib import Path

from .core import Store, DEFAULT_STATE, DEFAULT_IMAGES, DEFAULT_RECEIPTS, DEFAULT_DERIVED, DEFAULT_REPORTS


def main():
    parser = argparse.ArgumentParser(description="Filter only verified, local official images; never downloads source images.")
    parser.add_argument("--state", type=Path, default=DEFAULT_STATE)
    sub = parser.add_subparsers(dest="command", required=True)
    prepare = sub.add_parser("prepare")
    for name, default in (("images", DEFAULT_IMAGES), ("receipts", DEFAULT_RECEIPTS),
                          ("derived", DEFAULT_DERIVED), ("reports", DEFAULT_REPORTS)):
        prepare.add_argument("--" + name, type=Path, default=default)
    prepare.add_argument("--workers", type=int, default=4)
    classify = sub.add_parser("classify")
    classify.add_argument("--run-azure", action="store_true", required=True)
    classify.add_argument("--env", type=Path, required=True)
    classify.add_argument("--phases", nargs="+", choices=("primary", "secondary", "adjudicator", "verifier"), default=["primary", "secondary", "adjudicator", "verifier"])
    classify.add_argument("--workers", type=int, default=6)
    classify.add_argument("--batch-size", type=int, default=12)
    classify.add_argument("--limit", type=int, default=0)
    classify.add_argument("--max-requests", type=int, default=900)
    frame = sub.add_parser("frame-audit", help="Recheck claimed cards with nonportrait or unusual framing.")
    frame.add_argument("--run-azure", action="store_true", required=True)
    frame.add_argument("--env", type=Path, required=True)
    frame.add_argument("--workers", type=int, default=6)
    frame.add_argument("--max-requests", type=int, default=100)
    sub.add_parser("status")
    sub.add_parser("export")
    serve = sub.add_parser("serve")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8832)
    serve.add_argument("--allow-host", action="append", default=[], help="Additional private LAN IP permitted in the Host header.")
    serve.add_argument("--forwarded-origin", action="append", default=[],
                       help="Exact trusted HTTP origin for an SSH-forwarded port, e.g. http://localhost:57824.")
    serve.add_argument("--ssh-forwarded", action="store_true",
                       help="Allow changing loopback ports through a local SSH proxy; retain browser same-origin checks.")
    args = parser.parse_args()
    store = Store(args.state)
    if args.command == "serve":
        from .web import serve
        serve(store, args.host, args.port, args.allow_host, args.forwarded_origin, args.ssh_forwarded)
        return
    if args.command == "status":
        print(json.dumps(store.snapshot()["summary"], ensure_ascii=False, indent=2))
        return
    with (store.root / ".pipeline.lock").open("a+b") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.command == "prepare":
            if not 1 <= args.workers <= 8:
                raise ValueError("Use 1..8 preview workers.")
            store.seed(args.receipts, args.images, args.derived, args.reports)
            rows = [r for r in store.rows() if not r["prepared"]]
            done = 0
            with ThreadPoolExecutor(max_workers=args.workers) as pool:
                futures = {pool.submit(store.prepare_one, row): row for row in rows}
                for future in as_completed(futures):
                    row = futures[future]
                    try:
                        future.result()
                    except Exception as error:
                        with store.lock, store.db:
                            store.db.execute("UPDATE images SET error=? WHERE id=?",
                                             (type(error).__name__ + ":" + str(error)[:150], row["id"]))
                    done += 1
                    if done % 200 == 0 or done == len(rows):
                        print(f"Preview/hash checks: {done}/{len(rows)}", flush=True)
            result = store.export()
        elif args.command == "classify":
            from .model import classify
            result = classify(store, args.env, phases=args.phases, workers=args.workers,
                              batch_size=args.batch_size, limit=args.limit, max_requests=args.max_requests)
        elif args.command == "frame-audit":
            from .model import frame_audit
            if not 1 <= args.workers <= 8 or args.max_requests < 1:
                raise ValueError("Invalid bounded frame-audit settings.")
            result = frame_audit(store, args.env, workers=args.workers, max_requests=args.max_requests)
        else:
            result = store.export()
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if args.command in ("classify", "frame-audit") and not result["pipeline_complete"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
