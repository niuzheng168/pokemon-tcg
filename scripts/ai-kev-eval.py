"""How well a served Kev model picks the search's move on held-out records (scripts/ai-kev-data.mjs's heldout.jsonl).

For every record it sends the System One request (state, question, options; never the label or target) and reports how
often the model's top option is the search's best move (top-1), the target probability of the option it picks (how
good its pick is by the search's own estimates), the cross-entropy against the target, and the same for picking at
random. Standard library only:
    python3 scripts/ai-kev-eval.py <heldout.jsonl> <server url> [--limit N] [--workers 8]
"""
import argparse, json, math, urllib.request
from concurrent.futures import ThreadPoolExecutor


def ask(url, record):
    body = {"state": record["state"], "questions": {qid: {k: v for k, v in q.items() if k in ("type", "instructions", "criteria")}
                                                    for qid, q in record["questions"].items()}}
    request = urllib.request.Request(url.rstrip("/") + "/v1/systemone", data=json.dumps(body, ensure_ascii=False).encode(),
                                     headers={"content-type": "application/json"})
    with urllib.request.urlopen(request, timeout=300) as response:
        out = json.loads(response.read())
    answers = out.get("answers", out)
    return answers["move"]["probabilities"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("heldout")
    parser.add_argument("url")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()
    records = [json.loads(line) for line in open(args.heldout, encoding="utf-8") if line.strip()]
    if args.limit:
        records = records[: args.limit]
    with ThreadPoolExecutor(args.workers) as pool:
        answers = list(pool.map(lambda r: ask(args.url, r), records))
    top1 = picked = xent = random_top1 = random_picked = 0.0
    for record, p in zip(records, answers):
        q = record["questions"]["move"]
        target, keys = q["target"], list(q["criteria"])
        choice = max(keys, key=lambda k: p.get(k, 0))
        top1 += choice == q["label"]
        picked += target[choice]
        xent -= sum(t * math.log(max(1e-9, p.get(k, 0))) for k, t in target.items())
        random_top1 += 1 / len(keys)
        random_picked += sum(target.values()) / len(keys)
    n = len(records)
    print(json.dumps({"records": n, "top1": round(top1 / n, 4), "pickedTarget": round(picked / n, 4), "crossEntropy": round(xent / n, 4),
                      "random": {"top1": round(random_top1 / n, 4), "pickedTarget": round(random_picked / n, 4)}}, ensure_ascii=False))


if __name__ == "__main__":
    main()
