"""Explicit staging, offline preview, and opt-in bounded Foundry adjudication."""
import argparse

from .common import TOOL


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    stage = sub.add_parser("stage", help="Read local MIK and Wiki sources; create candidates only.")
    stage.add_argument("--source", required=True)
    stage.add_argument("--snapshot", default=TOOL / "snapshots/2026.10.18")
    stage.add_argument("--selection", required=True)
    stage.add_argument("--run-dir", required=True)
    stage.add_argument("--observations", help="Optional, locally inspected printed numbers bound to image SHA-256.")
    judge = sub.add_parser("judge", help="Reuse matching response caches unless --run-azure is explicit.")
    judge.add_argument("--run-dir", required=True)
    judge.add_argument("--run-azure", action="store_true")
    judge.add_argument("--env", help="Optional private dotenv file; not read during cache-only replay.")
    judge.add_argument("--azure-host", help="Explicit allowed Azure hostname; required for uncached requests.")
    judge.add_argument("--reviewer-a", default="gpt-4.1-mini-global-standard")
    judge.add_argument("--reviewer-b", default="gpt-4.1-global-standard")
    judge.add_argument("--max-requests", type=int, default=8)
    html = sub.add_parser("html", help="Build an offline reviewer, including before model review.")
    html.add_argument("--run-dir", required=True)
    html.add_argument("--library", default=TOOL / "library")
    serve = sub.add_parser("serve", help="Serve only the rendered HTML on loopback.")
    serve.add_argument("--run-dir", required=True)
    serve.add_argument("--port", type=int, default=0)
    args = parser.parse_args(argv)
    if args.command == "stage":
        from .stage import run
        run(args.source, args.snapshot, args.selection, args.run_dir, args.observations)
    elif args.command == "judge":
        from . import semantics
        semantics.configure(args.run_dir, env_file=args.env, azure_host=args.azure_host,
                            deployments=(args.reviewer_a, args.reviewer_b), max_requests=args.max_requests)
        semantics.run(args.run_azure)
    elif args.command == "html":
        from .review import build
        print(build(args.run_dir, args.library))
    else:
        from .preview import serve
        serve(args.run_dir, args.port)
